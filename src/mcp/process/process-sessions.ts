import { spawn } from "node:child_process";
import type { ProcessAuditContext, ProcessOutputAuditSink, ProcessOutputChannel } from "../../activity/runtime/process-output-audit.js";
import { resolveShellCommandForRuntime, terminateProcessTree } from "./process-platform.js";
import { resolveCompatibilityCommandShellRuntime, snapshotCommandShellRuntime, type CommandShellRuntime } from "../../runtime/shell/command-shell-runtime.js";
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
export const DEFAULT_POLL_YIELD_MS = 60_000;
const MAX_START_YIELD_MS = 300_000;
const MAX_COMMAND_YIELD_MS = 300_000;
const MAX_POLL_YIELD_MS = 300_000;
const MAX_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 256_000;
const DEFAULT_MAX_ACTIVE_PROCESSES = 64;
const DEFAULT_MAX_COMPLETED_PROCESSES = 128;
const COMPLETED_PROCESS_TTL_MS = 5 * 60 * 1_000;
const COMPACT_COMPLETION_TTL_MS = 24 * 60 * 60 * 1_000;
const COMPACT_COMPLETION_CHARACTERS = 16 * 1024;
const COMPACT_COMPLETION_OUTPUT_TOKENS = COMPACT_COMPLETION_CHARACTERS / 4;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  audit?: ProcessAuditContext;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  codexCi?: boolean;
  signal?: AbortSignal;
}
export interface WriteStdinInput {
  workspaceId: string;
  processId?: number;
  /** @deprecated Use processId. */
  sessionId?: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ProcessSnapshot {
  processId?: number;
  /** @deprecated Use processId. */
  sessionId?: number;
  outputId?: string;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  wallTimeMs: number;
}

export interface CompletedProcessSnapshot extends ProcessSnapshot {
  processId: number;
  /** @deprecated Use processId. */
  sessionId: number;
  command: string;
}

export interface ProcessManagerStats {
  total: number;
  running: number;
  completed: number;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface ProcessEntry {
  id: number;
  workspaceId: string;
  command: string;
  outputId?: string;
  auditFinished: boolean;
  process?: ManagedProcess;
  startedAtMonotonic: number;
  finishedAtMonotonic?: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  outputWasTruncated: boolean;
  background: boolean;
  discardOnFinish: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  executionTimeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
}

export interface ProcessManagerOptions {
  maxBufferCharacters?: number;
  maxActiveProcesses?: number;
  maxCompletedProcesses?: number;
  completedProcessTtlMs?: number;
  /** @deprecated Use completedProcessTtlMs. */
  completedSessionTtlMs?: number;
  maxStartYieldMs?: number;
  monotonicNow?: () => number;
  outputAudit?: ProcessOutputAuditSink;
  commandShellRuntime?: CommandShellRuntime;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return Math.min(fallback, maximum);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function optionalExecutionTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error(`Execution timeout must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_MS}ms.`);
  }
  return value;
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

export function resolveProcessId(
  processId: number | undefined,
  legacySessionId: number | undefined,
): number {
  if (processId !== undefined && legacySessionId !== undefined && processId !== legacySessionId) {
    throw new Error("processId and deprecated sessionId must identify the same process when both are provided.");
  }

  const resolved = processId ?? legacySessionId;
  if (resolved === undefined) {
    throw new Error("A processId is required. Deprecated sessionId remains accepted for compatibility.");
  }
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error("processId must be a positive integer.");
  }
  return resolved;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
  codexCi?: boolean;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && (input?.codexCi || entry[0] !== "CODEX_CI")
      ),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    ...(input?.codexCi ? { CODEX_CI: "1" } : {}),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { FORGERELAY_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { FORGERELAY_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  let characters = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) index += 1;
    }
    characters += 1;
  }
  return characters;
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  let index = 0;
  let characters = 0;
  while (index < value.length && characters < count) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      index + 1 < value.length
    ) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      index += nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff ? 2 : 1;
    } else {
      index += 1;
    }
    characters += 1;
  }
  return value.slice(0, index);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  let index = value.length;
  let characters = 0;
  while (index > 0 && characters < count) {
    index -= 1;
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xdc00 && codeUnit <= 0xdfff &&
      index > 0
    ) {
      const previousCodeUnit = value.charCodeAt(index - 1);
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) index -= 1;
    }
    characters += 1;
  }
  return value.slice(index);
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const outputCharacters = codePointLength(output);
    const previousTotal = this.totalCharacters;
    this.totalCharacters += outputCharacters;

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const previousHead = this.head;
      this.head = previousTotal >= budget.head
        ? takeHead(previousHead, budget.head)
        : previousHead + takeHead(output, budget.head - previousTotal);
      this.tail = outputCharacters >= budget.tail
        ? takeTail(output, budget.tail)
        : takeTail(previousHead, budget.tail - outputCharacters) + output;
      return;
    }

    if (outputCharacters >= budget.tail) {
      this.tail = takeTail(output, budget.tail);
      return;
    }
    this.tail = takeTail(this.tail, budget.tail - outputCharacters) + output;
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessManager {
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly completedByWorkspace = new Map<string, number[]>();
  private readonly completedProcessIds: number[] = [];
  private readonly maxBufferCharacters: number;
  private readonly maxActiveProcesses: number;
  private readonly maxCompletedProcesses: number;
  private readonly completedProcessTtlMs: number;
  private readonly maxStartYieldMs: number;
  private readonly monotonicNow: () => number;
  private readonly outputAudit?: ProcessOutputAuditSink;
  private readonly commandShellRuntime: CommandShellRuntime;
  private nextProcessId = 1;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.maxActiveProcesses = options.maxActiveProcesses ?? DEFAULT_MAX_ACTIVE_PROCESSES;
    if (!Number.isInteger(this.maxActiveProcesses) || this.maxActiveProcesses < 1) {
      throw new Error("Active process limit must be a positive integer.");
    }
    this.maxCompletedProcesses = options.maxCompletedProcesses ?? DEFAULT_MAX_COMPLETED_PROCESSES;
    if (!Number.isInteger(this.maxCompletedProcesses) || this.maxCompletedProcesses < 1) {
      throw new Error("Completed process limit must be a positive integer.");
    }
    this.completedProcessTtlMs = options.completedProcessTtlMs
      ?? options.completedSessionTtlMs
      ?? COMPLETED_PROCESS_TTL_MS;
    this.maxStartYieldMs = options.maxStartYieldMs ?? MAX_START_YIELD_MS;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.outputAudit = options.outputAudit;
    this.commandShellRuntime = snapshotCommandShellRuntime(options.commandShellRuntime ?? resolveCompatibilityCommandShellRuntime());
  }
  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    input.signal?.throwIfAborted();
    if (this.stats().running >= this.maxActiveProcesses) {
      throw new Error(
        `Active process limit reached (${this.maxActiveProcesses}). Poll, interrupt, or wait for an existing process before starting another.`,
      );
    }
    const executionTimeoutMs = optionalExecutionTimeout(input.timeoutMs);
    const processEntry = this.createProcess(input);
    this.processes.set(processEntry.id, processEntry);

    try {
      if (input.tty) await this.startPty(processEntry, input);
      else this.startPipe(processEntry, input);
    } catch (error) {
      this.finishAudit(processEntry, {
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      this.processes.delete(processEntry.id);
      throw error;
    }

    this.armExecutionTimeout(processEntry, executionTimeoutMs);
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, this.maxStartYieldMs);
    try {
      await this.waitForExit(processEntry, yieldTimeMs, input.signal);
      input.signal?.throwIfAborted();
    } catch (error) {
      if (input.signal?.aborted) {
        processEntry.discardOnFinish = true;
        this.stopProcess(processEntry, "SIGTERM");
      }
      throw error;
    }

    if (processEntry.running) processEntry.background = true;
    const snapshot = this.consume(processEntry, input.maxOutputTokens);
    if (!snapshot.running) this.removeProcess(processEntry.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const processId = resolveProcessId(input.processId, input.sessionId);
    const processEntry = this.getOwnedProcess(input.workspaceId, processId);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      processEntry.columns = terminalSize(input.columns, processEntry.columns);
      processEntry.rows = terminalSize(input.rows, processEntry.rows);
      if (!processEntry.process?.resize) {
        throw new Error(`Process ${processEntry.id} is not a PTY and cannot be resized.`);
      }
      processEntry.process.resize(processEntry.columns, processEntry.rows);
    }

    const interruptRequested = chars.includes("\u0003") && processEntry.running;
    if (interruptRequested) {
      processEntry.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && processEntry.running) processEntry.process?.write(writableChars);

    const explicitWaitRequested = input.yieldTimeMs !== undefined;
    if ((explicitWaitRequested || interactionRequested || !processEntry.buffer.hasOutput()) && processEntry.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const maximum = interactionRequested ? MAX_COMMAND_YIELD_MS : MAX_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, maximum);
      await this.waitForExit(processEntry, yieldTimeMs, input.signal);
    }

    const snapshot = this.consume(processEntry, input.maxOutputTokens);
    if (!processEntry.running) this.removeProcess(processEntry.id);
    return snapshot;
  }

  activeWorkspaceIds(): Set<string> {
    return new Set(
      [...this.processes.values()]
        .filter((processEntry) => processEntry.running)
        .map((processEntry) => processEntry.workspaceId),
    );
  }

  stats(): ProcessManagerStats {
    let running = 0;
    let completed = 0;
    for (const processEntry of this.processes.values()) {
      if (processEntry.running) running += 1;
      else completed += 1;
    }
    return { total: this.processes.size, running, completed };
  }

  takeCompleted(
    workspaceId: string,
    maxOutputTokens?: number,
    excludeProcessId?: number,
  ): CompletedProcessSnapshot[] {
    const processIds = this.completedByWorkspace.get(workspaceId) ?? [];
    if (processIds.length === 0) return [];

    const completed: CompletedProcessSnapshot[] = [];
    for (const processId of processIds) {
      if (processId === excludeProcessId) continue;
      const processEntry = this.processes.get(processId);
      if (!processEntry || processEntry.running) continue;
      const snapshot = this.consume(processEntry, maxOutputTokens);
      completed.push({
        ...snapshot,
        processId: processEntry.id,
        sessionId: processEntry.id,
        command: processEntry.command,
      });
      this.removeProcess(processEntry.id);
    }
    return completed;
  }

  terminate(workspaceId: string, processId: number): void {
    const processEntry = this.getOwnedProcess(workspaceId, processId);
    if (processEntry.running) processEntry.process?.kill("SIGTERM");
  }

  discardUndelivered(workspaceId: string, processId: number): void {
    const processEntry = this.getOwnedProcess(workspaceId, processId);
    processEntry.discardOnFinish = true;
    if (processEntry.running) this.stopProcess(processEntry, "SIGTERM");
    else this.removeProcess(processEntry.id);
  }

  shutdown(): void {
    for (const processEntry of this.processes.values()) {
      this.clearProcessTimers(processEntry);
      if (processEntry.running) {
        this.finishAudit(processEntry, {
          signal: "shutdown",
          timedOut: false,
          error: "ForgeRelay shut down while the process was still running.",
        });
        processEntry.process?.kill("SIGTERM");
      }
    }
    this.processes.clear();
    this.completedByWorkspace.clear();
    this.completedProcessIds.length = 0;
  }

  private async waitForExit(
    processEntry: ProcessEntry,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const waits: Promise<void>[] = [
        processEntry.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ];
      if (signal) {
        waits.push(new Promise<void>((_resolve, reject) => {
          abortListener = () => reject(signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error("Process wait cancelled by Host."), { name: "AbortError" }));
          signal.addEventListener("abort", abortListener, { once: true });
        }));
      }
      await Promise.race(waits);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  private createProcess(input: StartCommandInput): ProcessEntry {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const id = this.nextProcessId++;
    const outputId = this.outputAudit && input.audit
      ? this.outputAudit.begin({
          activityId: input.audit.activityId,
          turnId: input.audit.turnId,
          ...(input.audit.conversationScopeId ? { conversationScopeId: input.audit.conversationScopeId } : {}),
          processId: id,
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot ?? input.cwd,
          command: input.command,
          tty: input.tty === true,
        })
      : undefined;

    return {
      id,
      workspaceId: input.workspaceId,
      command: input.command,
      ...(outputId ? { outputId } : {}),
      auditFinished: false,
      startedAtMonotonic: this.monotonicNow(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      timedOut: false,
      outputWasTruncated: false,
      background: false,
      discardOnFinish: false,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(processEntry: ProcessEntry, input: StartCommandInput): void {
    const shell = resolveShellCommandForRuntime(input.command, this.commandShellRuntime);
    const detached = process.platform !== "win32";
    const child = spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        codexCi: input.codexCi,
      }),
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      detached,
    });

    processEntry.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
    };
    child.stdout.on("data", (data: Buffer) => this.append(processEntry, "stdout", data));
    child.stderr.on("data", (data: Buffer) => this.append(processEntry, "stderr", data));
    child.on("error", (error) => this.append(processEntry, "process", `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(processEntry, code ?? undefined, signal ?? undefined));
  }

  private async startPty(processEntry: ProcessEntry, input: StartCommandInput): Promise<void> {
    let nodePty: typeof import("node-pty");
    try {
      nodePty = await import("node-pty");
    } catch {
      throw new Error("PTY support requires the optional node-pty dependency.");
    }

    const shell = resolveShellCommandForRuntime(input.command, this.commandShellRuntime, { interactive: true });
    const pty = nodePty.spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        codexCi: input.codexCi,
      }),
      name: "xterm-256color",
      cols: processEntry.columns,
      rows: processEntry.rows,
    });
    processEntry.process = {
      write: (data) => pty.write(data),
      kill: (signal = "SIGTERM") => process.platform === "win32"
        ? terminateProcessTree({ pid: pty.pid, kill: (fallbackSignal) => { pty.kill(fallbackSignal); return true; } }, signal, false)
        : pty.kill(signal),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => this.append(processEntry, "pty", data));
    pty.onExit(({ exitCode, signal }) => {
      this.finish(processEntry, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private finish(processEntry: ProcessEntry, exitCode?: number, signal?: string): void {
    if (!processEntry.running) return;
    processEntry.running = false;
    processEntry.exitCode = exitCode;
    processEntry.signal = signal;
    processEntry.finishedAtMonotonic = this.monotonicNow();
    processEntry.process = undefined;
    this.finishAudit(processEntry, {
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
      timedOut: processEntry.timedOut,
    });
    if (processEntry.executionTimeoutTimer) clearTimeout(processEntry.executionTimeoutTimer);
    if (processEntry.forceKillTimer) clearTimeout(processEntry.forceKillTimer);
    processEntry.resolveExit();
    if (processEntry.discardOnFinish) {
      this.removeProcess(processEntry.id);
      return;
    }
    processEntry.cleanupTimer = setTimeout(
      () => this.compactCompletedProcess(processEntry),
      this.completedProcessTtlMs,
    );
    processEntry.cleanupTimer.unref();
    if (processEntry.background) {
      const completed = this.completedByWorkspace.get(processEntry.workspaceId) ?? [];
      if (!completed.includes(processEntry.id)) {
        completed.push(processEntry.id);
        this.completedByWorkspace.set(processEntry.workspaceId, completed);
        this.completedProcessIds.push(processEntry.id);
      }
      while (this.completedProcessIds.length > this.maxCompletedProcesses) {
        const oldestProcessId = this.completedProcessIds[0];
        if (oldestProcessId === undefined) break;
        this.removeProcess(oldestProcessId);
      }
    }
  }

  private compactCompletedProcess(processEntry: ProcessEntry): void {
    if (processEntry.running || !this.processes.has(processEntry.id)) return;
    const compacted = this.consume(processEntry, COMPACT_COMPLETION_OUTPUT_TOKENS);
    processEntry.buffer = new HeadTailBuffer(COMPACT_COMPLETION_CHARACTERS);
    processEntry.buffer.append(compacted.output);
    processEntry.outputWasTruncated = compacted.outputTruncated;
    const remainingMs = Math.max(1, COMPACT_COMPLETION_TTL_MS - this.completedProcessTtlMs);
    processEntry.cleanupTimer = setTimeout(() => this.removeProcess(processEntry.id), remainingMs);
    processEntry.cleanupTimer.unref();
  }

  private append(processEntry: ProcessEntry, channel: ProcessOutputChannel, output: Uint8Array | string): void {
    if (processEntry.outputId && !processEntry.auditFinished) {
      this.outputAudit?.append(processEntry.outputId, channel, output);
    }
    processEntry.buffer.append(typeof output === "string" ? output : Buffer.from(output).toString("utf8"));
  }

  private finishAudit(
    processEntry: ProcessEntry,
    input: {
      exitCode?: number;
      signal?: string;
      timedOut: boolean;
      error?: string;
    },
  ): void {
    if (!processEntry.outputId || processEntry.auditFinished) return;
    processEntry.auditFinished = true;
    this.outputAudit?.finish(processEntry.outputId, input);
  }

  private consume(processEntry: ProcessEntry, maxOutputTokens?: number): ProcessSnapshot {
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = processEntry.buffer.drain(maxCharacters);
    if (buffered.truncated) processEntry.outputWasTruncated = true;
    const processId = processEntry.running ? processEntry.id : undefined;
    const endedAt = processEntry.finishedAtMonotonic ?? this.monotonicNow();

    return {
      processId,
      sessionId: processId,
      ...(processEntry.outputId ? { outputId: processEntry.outputId } : {}),
      output: buffered.output,
      outputTruncated: processEntry.outputWasTruncated,
      running: processEntry.running,
      exitCode: processEntry.exitCode,
      signal: processEntry.signal,
      timedOut: processEntry.timedOut,
      wallTimeMs: Math.max(
        0,
        Math.round(endedAt - processEntry.startedAtMonotonic),
      ),
    };
  }

  private armExecutionTimeout(processEntry: ProcessEntry, timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) return;
    processEntry.executionTimeoutTimer = setTimeout(() => {
      if (!processEntry.running) return;
      processEntry.timedOut = true;
      this.stopProcess(processEntry, "SIGTERM");
    }, timeoutMs);
    processEntry.executionTimeoutTimer.unref();
  }

  private stopProcess(processEntry: ProcessEntry, signal: NodeJS.Signals): void {
    if (!processEntry.running) return;
    processEntry.process?.kill(signal);
    if (processEntry.forceKillTimer) clearTimeout(processEntry.forceKillTimer);
    processEntry.forceKillTimer = setTimeout(() => {
      if (processEntry.running) processEntry.process?.kill("SIGKILL");
    }, 500);
    processEntry.forceKillTimer.unref();
  }

  private clearProcessTimers(processEntry: ProcessEntry): void {
    if (processEntry.cleanupTimer) clearTimeout(processEntry.cleanupTimer);
    if (processEntry.executionTimeoutTimer) clearTimeout(processEntry.executionTimeoutTimer);
    if (processEntry.forceKillTimer) clearTimeout(processEntry.forceKillTimer);
  }

  private getOwnedProcess(workspaceId: string, processId: number): ProcessEntry {
    const processEntry = this.processes.get(processId);
    if (!processEntry) throw new Error(`Unknown process: ${processId}`);
    if (processEntry.workspaceId !== workspaceId) {
      throw new Error(`Process ${processId} does not belong to workspace ${workspaceId}.`);
    }
    return processEntry;
  }

  private removeProcess(processId: number): void {
    const processEntry = this.processes.get(processId);
    if (processEntry) this.clearProcessTimers(processEntry);
    this.processes.delete(processId);
    const completedIndex = this.completedProcessIds.indexOf(processId);
    if (completedIndex >= 0) this.completedProcessIds.splice(completedIndex, 1);
    if (!processEntry) return;
    const completed = this.completedByWorkspace.get(processEntry.workspaceId);
    if (!completed) return;
    const remaining = completed.filter((id) => id !== processId);
    if (remaining.length > 0) this.completedByWorkspace.set(processEntry.workspaceId, remaining);
    else this.completedByWorkspace.delete(processEntry.workspaceId);
  }
}

/** @deprecated Use ProcessManager. */
export { ProcessManager as ProcessSessionManager };
