import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { ProcessOutputAuditSink, ProcessOutputChannel } from "./process-output-audit.js";
import { SegmentedLogStore } from "./storage/segmented-log.js";
import { bashOutputLogPrefix, bashOutputMetadataPrefix, stateRelativePath } from "./storage/paths.js";

export type BashOutputChannel = ProcessOutputChannel;

const DEFAULT_FLUSH_BYTES = 256 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 500;

export interface BeginBashOutputInput {
  activityId: string;
  turnId: string;
  conversationScopeId?: string;
  processId: number;
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  tty: boolean;
}

export interface FinishBashOutputInput {
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  error?: string;
}

export interface BashOutputMetadata {
  outputId: string;
  activityId: string;
  turnId: string;
  conversationScopeId?: string;
  processId: number;
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  tty: boolean;
  status: "running" | "done" | "failed";
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  error?: string;
  returned: boolean;
  outputBytes: number;
  startedAt: string;
  finishedAt?: string;
}

export interface BashOutputRecord extends BashOutputMetadata {
  output: string;
}

export interface BashOutputSlice extends BashOutputMetadata {
  output: string;
  cursor: number;
}

export interface BashOutputStoreOptions {
  now?: () => Date;
  outputId?: () => string;
  flushBytes?: number;
  flushIntervalMs?: number;
}

interface BashOutputStreamRow {
  id: string;
  activity_id: string;
  turn_id: string;
  conversation_scope_id: string | null;
  process_id: number;
  workspace_id: string;
  workspace_root: string;
  command: string;
  tty: number;
  status: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number;
  error: string | null;
  returned: number;
  completion_claimed_at: string | null;
  started_at: string;
  finished_at: string | null;
  log_file: string | null;
  output_bytes: number;
  command_file: string | null;
  command_offset: number | null;
  command_length: number | null;
  error_file: string | null;
  error_offset: number | null;
  error_length: number | null;
}

interface PendingOutput {
  buffers: Buffer[];
  bytes: number;
}

interface LegacyChunkRow {
  data: Buffer;
}

export class BashOutputStore implements ProcessOutputAuditSink {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly nextOutputId: () => string;
  private readonly stateDir: string;
  private readonly logs: SegmentedLogStore;
  private readonly pending = new Map<string, PendingOutput>();
  private readonly flushBytes: number;
  private readonly flushTimer: NodeJS.Timeout;

  constructor(stateDir: string, options: BashOutputStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? (() => new Date());
    this.nextOutputId = options.outputId ?? (() => `out_${randomUUID().replaceAll("-", "")}`);
    this.stateDir = stateDir;
    this.logs = new SegmentedLogStore(stateDir);
    this.flushBytes = positiveInteger(options.flushBytes, DEFAULT_FLUSH_BYTES, "Bash output flushBytes");
    const flushIntervalMs = positiveInteger(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
      "Bash output flushIntervalMs",
    );
    this.migrateLegacyStreams();
    this.migrateLegacyMetadata();
    this.flushTimer = setInterval(() => this.flushPending(), flushIntervalMs);
    this.flushTimer.unref();
  }

  begin(input: BeginBashOutputInput): string {
    const outputId = this.nextOutputId();
    const startedAt = this.now().toISOString();
    const workspace = { id: input.workspaceId, root: input.workspaceRoot, mode: "checkout" as const };
    const logPrefix = stateRelativePath(
      this.stateDir,
      bashOutputLogPrefix(this.stateDir, workspace, outputId),
    );
    const commandRef = this.logs.append(
      bashOutputMetadataPrefix(this.stateDir, workspace, outputId, "command"),
      Buffer.from(input.command, "utf8"),
    );
    this.database.sqlite.prepare(
      `insert into bash_output_streams (
        id, activity_id, turn_id, conversation_scope_id, process_id,
        workspace_id, workspace_root, command, tty, status, timed_out, started_at,
        log_file, output_bytes, command_file, command_offset, command_length
      ) values (?, ?, ?, ?, ?, ?, ?, '', ?, 'running', 0, ?, ?, 0, ?, ?, ?)`,
    ).run(
      outputId,
      input.activityId,
      input.turnId,
      input.conversationScopeId ?? null,
      input.processId,
      input.workspaceId,
      input.workspaceRoot,
      input.tty ? 1 : 0,
      startedAt,
      logPrefix,
      commandRef.prefix,
      commandRef.offset,
      commandRef.length,
    );
    return outputId;
  }

  append(outputId: string, _channel: BashOutputChannel, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (bytes.length === 0) return;
    const pending = this.pending.get(outputId) ?? { buffers: [], bytes: 0 };
    pending.buffers.push(bytes);
    pending.bytes += bytes.length;
    this.pending.set(outputId, pending);
    if (pending.bytes >= this.flushBytes) this.flushOutput(outputId);
  }

  markReturned(outputId: string): void {
    this.flushOutput(outputId);
    this.database.sqlite.prepare(
      "update bash_output_streams set returned = 1 where id = ?",
    ).run(outputId);
  }

  claimCompletion(outputId: string): BashOutputMetadata | undefined {
    this.flushOutput(outputId);
    const claimedAt = this.now().toISOString();
    const claimed = this.database.sqlite.prepare(
      `update bash_output_streams
       set completion_claimed_at = ?
       where id = ? and returned = 1 and status != 'running' and completion_claimed_at is null`,
    ).run(claimedAt, outputId);
    return claimed.changes === 1 ? this.readMetadata(outputId) : undefined;
  }

  finish(outputId: string, input: FinishBashOutputInput): void {
    this.flushOutput(outputId);
    const row = this.requireStream(outputId);
    const status = input.error || input.timedOut || input.signal || (input.exitCode !== undefined && input.exitCode !== 0)
      ? "failed"
      : "done";
    const errorRef = input.error
      ? this.logs.append(
          bashOutputMetadataPrefix(
            this.stateDir,
            { id: row.workspace_id, root: row.workspace_root, mode: "checkout" },
            outputId,
            "error",
          ),
          Buffer.from(input.error, "utf8"),
        )
      : undefined;
    this.database.sqlite.prepare(
      `update bash_output_streams
       set status = ?, exit_code = ?, signal = ?, timed_out = ?, error = null, finished_at = ?,
           error_file = ?, error_offset = ?, error_length = ?
       where id = ?`,
    ).run(
      status,
      input.exitCode ?? null,
      input.signal ?? null,
      input.timedOut ? 1 : 0,
      this.now().toISOString(),
      errorRef?.prefix ?? null,
      errorRef?.offset ?? null,
      errorRef?.length ?? null,
      outputId,
    );
  }

  read(outputId: string): BashOutputRecord | undefined {
    const metadata = this.readMetadata(outputId);
    if (!metadata) return undefined;
    const row = this.requireStream(outputId);
    const prefix = this.ensureFileBacked(row);
    const output = this.logs.readRange(prefix, 0, metadata.outputBytes).toString("utf8");
    return { ...metadata, output };
  }

  readSince(outputId: string, cursor = 0): BashOutputSlice | undefined {
    const metadata = this.readMetadata(outputId);
    if (!metadata) return undefined;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(`Bash output cursor must be a non-negative integer: ${cursor}.`);
    }
    const start = Math.min(cursor, metadata.outputBytes);
    const row = this.requireStream(outputId);
    const prefix = this.ensureFileBacked(row);
    const output = this.logs.readRange(prefix, start, metadata.outputBytes).toString("utf8");
    return { ...metadata, output, cursor: metadata.outputBytes };
  }

  readMetadata(outputId: string): BashOutputMetadata | undefined {
    this.flushOutput(outputId);
    const row = this.readStream(outputId);
    if (!row) return undefined;
    this.ensureFileBacked(row);
    const refreshed = this.requireStream(outputId);
    return this.rowToMetadata(refreshed);
  }

  deleteWorkspace(workspaceId: string): void {
    const rows = this.database.sqlite.prepare(
      "select id from bash_output_streams where workspace_id = ?",
    ).all(workspaceId) as Array<{ id: string }>;
    for (const row of rows) {
      this.flushOutput(row.id);
      this.pending.delete(row.id);
    }
    this.database.sqlite.prepare(
      "delete from bash_output_streams where workspace_id = ?",
    ).run(workspaceId);
  }

  close(): void {
    clearInterval(this.flushTimer);
    this.flushPending();
    this.database.close();
  }

  private flushPending(): void {
    for (const outputId of [...this.pending.keys()]) this.flushOutput(outputId);
  }

  private flushOutput(outputId: string): void {
    const pending = this.pending.get(outputId);
    if (!pending || pending.bytes === 0) return;
    const row = this.requireStream(outputId);
    const prefix = this.ensureFileBacked(row);
    const onDiskBytes = this.logs.logicalLength(prefix);
    if (onDiskBytes < row.output_bytes) {
      throw new Error(
        `Bash output ${outputId} metadata references ${row.output_bytes} bytes but only ${onDiskBytes} are on disk.`,
      );
    }
    const data = Buffer.concat(pending.buffers, pending.bytes);

    // File first, index second. If SQLite updating fails after the write, the
    // next access reconciles output_bytes from the append-only log rather than
    // re-emitting the already-written payload.
    this.logs.appendAt(prefix, onDiskBytes, data);
    this.pending.delete(outputId);
    this.database.sqlite.prepare(
      "update bash_output_streams set output_bytes = ? where id = ?",
    ).run(onDiskBytes + data.length, outputId);
  }

  private ensureFileBacked(row: BashOutputStreamRow): string {
    let prefix = row.log_file;
    if (!prefix) {
      prefix = stateRelativePath(
        this.stateDir,
        bashOutputLogPrefix(
          this.stateDir,
          { id: row.workspace_id, root: row.workspace_root, mode: "checkout" },
          row.id,
        ),
      );
      let logicalOffset = this.logs.logicalLength(prefix);
      const legacyRows = this.database.sqlite.prepare(
        `select data from bash_output_chunks
         where output_id = ?
         order by sequence asc`,
      );
      for (const legacy of legacyRows.iterate(row.id) as Iterable<LegacyChunkRow>) {
        this.logs.appendAt(prefix, logicalOffset, legacy.data);
        logicalOffset += legacy.data.length;
      }
      this.database.sqlite.transaction(() => {
        this.database.sqlite.prepare(
          "update bash_output_streams set log_file = ?, output_bytes = ? where id = ?",
        ).run(prefix, logicalOffset, row.id);
        this.database.sqlite.prepare("delete from bash_output_chunks where output_id = ?").run(row.id);
      }).immediate();
      row.log_file = prefix;
      row.output_bytes = logicalOffset;
      return prefix;
    }

    const onDiskBytes = this.logs.logicalLength(prefix);
    if (onDiskBytes < row.output_bytes) {
      throw new Error(
        `Bash output ${row.id} index is ahead of its segmented log (${row.output_bytes} > ${onDiskBytes}).`,
      );
    }
    if (onDiskBytes > row.output_bytes) {
      this.database.sqlite.prepare(
        "update bash_output_streams set output_bytes = ? where id = ?",
      ).run(onDiskBytes, row.id);
      row.output_bytes = onDiskBytes;
    }
    return prefix;
  }

  private migrateLegacyStreams(): void {
    const rows = this.database.sqlite.prepare(
      "select * from bash_output_streams where log_file is null order by started_at asc",
    );
    for (const row of rows.iterate() as Iterable<BashOutputStreamRow>) {
      this.ensureFileBacked(row);
    }
  }

  private migrateLegacyMetadata(): void {
    const rows = this.database.sqlite.prepare(
      `select * from bash_output_streams
       where command_file is null or (error is not null and error_file is null)
       order by started_at asc`,
    );
    const update = this.database.sqlite.prepare(
      `update bash_output_streams
       set command = '', error = null,
           command_file = ?, command_offset = ?, command_length = ?,
           error_file = ?, error_offset = ?, error_length = ?
       where id = ?`,
    );
    for (const row of rows.iterate() as Iterable<BashOutputStreamRow>) {
      const workspace = { id: row.workspace_id, root: row.workspace_root, mode: "checkout" as const };
      const commandRef = row.command_file
        ? undefined
        : this.logs.append(
            bashOutputMetadataPrefix(this.stateDir, workspace, row.id, "command"),
            Buffer.from(row.command, "utf8"),
          );
      const errorRef = row.error && !row.error_file
        ? this.logs.append(
            bashOutputMetadataPrefix(this.stateDir, workspace, row.id, "error"),
            Buffer.from(row.error, "utf8"),
          )
        : undefined;
      update.run(
        commandRef?.prefix ?? row.command_file,
        commandRef?.offset ?? row.command_offset,
        commandRef?.length ?? row.command_length,
        errorRef?.prefix ?? row.error_file,
        errorRef?.offset ?? row.error_offset,
        errorRef?.length ?? row.error_length,
        row.id,
      );
    }
  }

  private rowToMetadata(stream: BashOutputStreamRow): BashOutputMetadata {
    const command = this.readMetadataField(
      stream.command_file,
      stream.command_offset,
      stream.command_length,
      stream.command,
    );
    const error = this.readMetadataField(
      stream.error_file,
      stream.error_offset,
      stream.error_length,
      stream.error ?? undefined,
    );
    return {
      outputId: stream.id,
      activityId: stream.activity_id,
      turnId: stream.turn_id,
      ...(stream.conversation_scope_id ? { conversationScopeId: stream.conversation_scope_id } : {}),
      processId: stream.process_id,
      workspaceId: stream.workspace_id,
      workspaceRoot: stream.workspace_root,
      command,
      tty: stream.tty === 1,
      status: isBashOutputStatus(stream.status) ? stream.status : "failed",
      ...(stream.exit_code !== null ? { exitCode: stream.exit_code } : {}),
      ...(stream.signal ? { signal: stream.signal } : {}),
      timedOut: stream.timed_out === 1,
      ...(error ? { error } : {}),
      returned: stream.returned === 1,
      outputBytes: stream.output_bytes,
      startedAt: stream.started_at,
      ...(stream.finished_at ? { finishedAt: stream.finished_at } : {}),
    };
  }

  private readMetadataField(
    file: string | null,
    offset: number | null,
    length: number | null,
    fallback: string | undefined,
  ): string {
    if (file !== null && offset !== null && length !== null) {
      return this.logs.read({ prefix: file, offset, length }).toString("utf8");
    }
    return fallback ?? "";
  }

  private readStream(outputId: string): BashOutputStreamRow | undefined {
    return this.database.sqlite.prepare(
      "select * from bash_output_streams where id = ?",
    ).get(outputId) as BashOutputStreamRow | undefined;
  }

  private requireStream(outputId: string): BashOutputStreamRow {
    const row = this.readStream(outputId);
    if (!row) throw new Error(`Unknown Bash output: ${outputId}.`);
    return row;
  }
}

function isBashOutputStatus(value: string): value is BashOutputMetadata["status"] {
  return value === "running" || value === "done" || value === "failed";
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return resolved;
}
