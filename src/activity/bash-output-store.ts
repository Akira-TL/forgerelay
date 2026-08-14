import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { ProcessOutputAuditSink, ProcessOutputChannel } from "./process-output-audit.js";

export type BashOutputChannel = ProcessOutputChannel;

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

export interface BashOutputChunk {
  sequence: number;
  channel: BashOutputChannel;
  data: string;
}

export interface BashOutputRecord {
  outputId: string;
  activityId: string;
  turnId: string;
  conversationScopeId?: string;
  processId: number;
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  tty: boolean;
  output: string;
  chunks: BashOutputChunk[];
  status: "running" | "done" | "failed";
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  error?: string;
  returned: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface BashOutputStoreOptions {
  now?: () => Date;
  outputId?: () => string;
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
}

interface BashOutputChunkRow {
  output_id: string;
  sequence: number;
  channel: string;
  data: Buffer;
  created_at: string;
}

export class BashOutputStore implements ProcessOutputAuditSink {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly nextOutputId: () => string;
  private readonly nextSequences = new Map<string, number>();

  constructor(stateDir: string, options: BashOutputStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? (() => new Date());
    this.nextOutputId = options.outputId ?? (() => `out_${randomUUID().replaceAll("-", "")}`);
  }

  begin(input: BeginBashOutputInput): string {
    const outputId = this.nextOutputId();
    const startedAt = this.now().toISOString();
    this.database.sqlite.prepare(
      `insert into bash_output_streams (
        id, activity_id, turn_id, conversation_scope_id, process_id,
        workspace_id, workspace_root, command, tty, status, timed_out, started_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`,
    ).run(
      outputId,
      input.activityId,
      input.turnId,
      input.conversationScopeId ?? null,
      input.processId,
      input.workspaceId,
      input.workspaceRoot,
      input.command,
      input.tty ? 1 : 0,
      startedAt,
    );
    this.nextSequences.set(outputId, 1);
    return outputId;
  }

  append(outputId: string, channel: BashOutputChannel, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (bytes.length === 0) return;
    const sequence = this.nextSequence(outputId);
    this.database.sqlite.prepare(
      `insert into bash_output_chunks (output_id, sequence, channel, data, created_at)
       values (?, ?, ?, ?, ?)`,
    ).run(outputId, sequence, channel, bytes, this.now().toISOString());
  }

  markReturned(outputId: string): void {
    this.database.sqlite.prepare(
      "update bash_output_streams set returned = 1 where id = ?",
    ).run(outputId);
  }

  claimCompletion(outputId: string): BashOutputRecord | undefined {
    const claimedAt = this.now().toISOString();
    const claimed = this.database.sqlite.prepare(
      `update bash_output_streams
       set completion_claimed_at = ?
       where id = ? and returned = 1 and status != 'running' and completion_claimed_at is null`,
    ).run(claimedAt, outputId);
    return claimed.changes === 1 ? this.read(outputId) : undefined;
  }

  finish(outputId: string, input: FinishBashOutputInput): void {
    const status = input.error || input.timedOut || input.signal || (input.exitCode !== undefined && input.exitCode !== 0)
      ? "failed"
      : "done";
    this.database.sqlite.prepare(
      `update bash_output_streams
       set status = ?, exit_code = ?, signal = ?, timed_out = ?, error = ?, finished_at = ?
       where id = ?`,
    ).run(
      status,
      input.exitCode ?? null,
      input.signal ?? null,
      input.timedOut ? 1 : 0,
      input.error ?? null,
      this.now().toISOString(),
      outputId,
    );
  }

  read(outputId: string): BashOutputRecord | undefined {
    const stream = this.database.sqlite.prepare(
      "select * from bash_output_streams where id = ?",
    ).get(outputId) as BashOutputStreamRow | undefined;
    if (!stream) return undefined;

    const rows = this.database.sqlite.prepare(
      `select * from bash_output_chunks
       where output_id = ?
       order by sequence asc`,
    ).all(outputId) as BashOutputChunkRow[];
    const decoded = decodeChunks(rows);

    return {
      outputId: stream.id,
      activityId: stream.activity_id,
      turnId: stream.turn_id,
      ...(stream.conversation_scope_id ? { conversationScopeId: stream.conversation_scope_id } : {}),
      processId: stream.process_id,
      workspaceId: stream.workspace_id,
      workspaceRoot: stream.workspace_root,
      command: stream.command,
      tty: stream.tty === 1,
      output: decoded.map((chunk) => chunk.data).join(""),
      chunks: decoded,
      status: isBashOutputStatus(stream.status) ? stream.status : "failed",
      ...(stream.exit_code !== null ? { exitCode: stream.exit_code } : {}),
      ...(stream.signal ? { signal: stream.signal } : {}),
      timedOut: stream.timed_out === 1,
      ...(stream.error ? { error: stream.error } : {}),
      returned: stream.returned === 1,
      startedAt: stream.started_at,
      ...(stream.finished_at ? { finishedAt: stream.finished_at } : {}),
    };
  }

  close(): void {
    this.database.close();
  }

  private nextSequence(outputId: string): number {
    const known = this.nextSequences.get(outputId);
    if (known !== undefined) {
      this.nextSequences.set(outputId, known + 1);
      return known;
    }
    const row = this.database.sqlite.prepare(
      "select coalesce(max(sequence), 0) as sequence from bash_output_chunks where output_id = ?",
    ).get(outputId) as { sequence: number };
    const sequence = row.sequence + 1;
    this.nextSequences.set(outputId, sequence + 1);
    return sequence;
  }
}

function decodeChunks(rows: BashOutputChunkRow[]): BashOutputChunk[] {
  const decoders = new Map<BashOutputChannel, StringDecoder>();
  const chunks: BashOutputChunk[] = [];
  const lastChunkIndex = new Map<BashOutputChannel, number>();

  for (const row of rows) {
    if (!isBashOutputChannel(row.channel)) {
      throw new Error(`Unknown Bash output channel: ${row.channel}`);
    }
    const decoder = decoders.get(row.channel) ?? new StringDecoder("utf8");
    decoders.set(row.channel, decoder);
    const data = decoder.write(row.data);
    chunks.push({ sequence: row.sequence, channel: row.channel, data });
    lastChunkIndex.set(row.channel, chunks.length - 1);
  }

  for (const [channel, decoder] of decoders) {
    const tail = decoder.end();
    if (!tail) continue;
    const index = lastChunkIndex.get(channel);
    if (index === undefined) continue;
    const chunk = chunks[index];
    if (chunk) chunk.data += tail;
  }

  return chunks;
}

function isBashOutputChannel(value: string): value is BashOutputChannel {
  return value === "stdout" || value === "stderr" || value === "pty" || value === "process";
}

function isBashOutputStatus(value: string): value is BashOutputRecord["status"] {
  return value === "running" || value === "done" || value === "failed";
}
