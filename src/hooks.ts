import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { WorkspaceMode } from "./workspace-store.js";
import type { LoggingConfig } from "./logger.js";
import { commandPreview, logEvent } from "./logger.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

export const HOOK_EVENTS = [
  "WorkspaceOpen",
  "BeforeTool",
  "AfterTool",
  "AfterToolFailure",
  "AfterFileChange",
  "BeforeWorktreeClose",
  "AfterWorktreeClose",
  "SubagentStart",
  "SubagentStop",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookHandlerInput {
  command: string;
  timeoutSeconds?: number;
}

export interface HookHandler {
  command: string;
  timeoutSeconds: number;
}

export type HookConfig = Partial<Record<HookEvent, HookHandler[]>>;
export type HookConfigInput = Partial<Record<HookEvent, HookHandlerInput[]>>;

export interface HookInvocation {
  workspaceId?: string;
  workspaceRoot: string;
  workspaceMode?: WorkspaceMode;
  sourceRoot?: string;
  cwd?: string;
  payload?: Record<string, unknown>;
}

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
const MAX_HOOK_TIMEOUT_SECONDS = 300;
const MAX_CAPTURE_BYTES = 64 * 1024;
const BLOCKING_EVENTS = new Set<HookEvent>(["BeforeTool", "BeforeWorktreeClose"]);
const EVENT_SET = new Set<string>(HOOK_EVENTS);

export class HookExecutionError extends Error {
  constructor(
    readonly event: HookEvent,
    readonly handlerIndex: number,
    message: string,
  ) {
    super(message);
    this.name = "HookExecutionError";
  }
}

export function parseHookConfig(value: unknown): HookConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error("ForgeRelay hooks must be an object keyed by hook event name");
  }

  const config: HookConfig = {};
  for (const [eventName, rawHandlers] of Object.entries(value)) {
    if (!EVENT_SET.has(eventName)) {
      throw new Error(`Unknown ForgeRelay hook event: ${eventName}`);
    }
    const event = eventName as HookEvent;
    if (!Array.isArray(rawHandlers)) {
      throw new Error(`Hook ${event} must be an array of command handlers`);
    }

    config[event] = rawHandlers.map((rawHandler, index) => parseHookHandler(event, rawHandler, index));
  }

  return config;
}

export interface ToolHookOptions<T> {
  tool: string;
  invocation: Omit<HookInvocation, "payload" | "cwd">;
  payload?: Record<string, unknown>;
  operation: () => Promise<T>;
  isFailure?: (result: T) => boolean;
  changedPaths?: (result: T) => string[];
  afterCwd?: (result: T) => string | undefined;
}

export async function runToolWithHooks<T>(
  runner: HookRunner,
  options: ToolHookOptions<T>,
): Promise<T> {
  const basePayload = { tool: options.tool, ...(options.payload ?? {}) };
  try {
    await runner.run("BeforeTool", {
      ...options.invocation,
      payload: basePayload,
    });
    const result = await options.operation();
    const afterCwd = options.afterCwd?.(result);

    if (options.isFailure?.(result)) {
      await runner.run("AfterToolFailure", {
        ...options.invocation,
        cwd: afterCwd,
        payload: basePayload,
      });
      return result;
    }

    await runner.run("AfterTool", {
      ...options.invocation,
      cwd: afterCwd,
      payload: basePayload,
    });
    const changedPaths = options.changedPaths?.(result) ?? [];
    if (changedPaths.length > 0) {
      await runner.run("AfterFileChange", {
        ...options.invocation,
        cwd: afterCwd,
        payload: { ...basePayload, paths: changedPaths },
      });
    }
    return result;
  } catch (error) {
    await runner.run("AfterToolFailure", {
      ...options.invocation,
      payload: {
        ...basePayload,
        errorType: error instanceof Error ? error.name : "Error",
      },
    });
    throw error;
  }
}

export class HookRunner {
  constructor(
    private readonly hooks: HookConfig,
    private readonly logging: LoggingConfig,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(event: HookEvent, invocation: HookInvocation): Promise<void> {
    const handlers = this.hooks[event] ?? [];
    const blocking = BLOCKING_EVENTS.has(event);

    for (const [index, handler] of handlers.entries()) {
      try {
        await this.runHandler(event, handler, index, invocation);
      } catch (error) {
        logEvent(this.logging, "warn", "hook_call", {
          hookEvent: event,
          workspaceId: invocation.workspaceId,
          success: false,
          error: errorMessage(error),
        });
        if (blocking) throw error;
      }
    }
  }

  private async runHandler(
    event: HookEvent,
    handler: HookHandler,
    index: number,
    invocation: HookInvocation,
  ): Promise<void> {
    const startedAt = performance.now();
    const shell = resolveShellCommand(handler.command, process.platform, this.baseEnv);
    const detached = process.platform !== "win32";
    const env = hookEnvironment(this.baseEnv, event, invocation);

    const result = await executeHookCommand({
      executable: shell.executable,
      args: shell.args,
      cwd: invocation.cwd ?? invocation.workspaceRoot,
      env,
      timeoutMs: handler.timeoutSeconds * 1_000,
      detached,
    });

    const durationMs = Math.round(performance.now() - startedAt);
    if (result.exitCode === 0 && !result.timedOut) {
      logEvent(this.logging, "info", "hook_call", {
        hookEvent: event,
        workspaceId: invocation.workspaceId,
        success: true,
        durationMs,
        commandPreview: this.logging.shellCommands ? commandPreview(handler.command) : undefined,
      });
      return;
    }

    const reason = result.timedOut
      ? `timed out after ${handler.timeoutSeconds}s`
      : result.signal
        ? `terminated by ${result.signal}`
        : `exited with code ${result.exitCode ?? "unknown"}`;
    const output = hookFailureOutput(result.stdout, result.stderr);
    throw new HookExecutionError(
      event,
      index,
      `Hook ${event} handler ${index + 1} ${reason}${output ? `: ${output}` : ""}`,
    );
  }
}

function parseHookHandler(event: HookEvent, value: unknown, index: number): HookHandler {
  if (!isRecord(value)) {
    throw new Error(`Hook ${event} handler ${index + 1} must be an object`);
  }

  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) {
    throw new Error(`Hook ${event} command must be a non-empty string`);
  }

  const timeoutSeconds = value.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_HOOK_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `Hook ${event} timeoutSeconds must be an integer between 1 and ${MAX_HOOK_TIMEOUT_SECONDS}`,
    );
  }

  return { command, timeoutSeconds };
}

function hookEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  event: HookEvent,
  invocation: HookInvocation,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    FORGERELAY_HOOK_EVENT: event,
    FORGERELAY_HOOK_PAYLOAD: JSON.stringify(invocation.payload ?? {}),
    FORGERELAY_WORKSPACE_ROOT: invocation.workspaceRoot,
    FORGERELAY_WORKSPACE_ID: invocation.workspaceId,
    FORGERELAY_WORKSPACE_MODE: invocation.workspaceMode,
    FORGERELAY_SOURCE_ROOT: invocation.sourceRoot,
    FORGERELAY_TOOL_NAME:
      typeof invocation.payload?.tool === "string" ? invocation.payload.tool : undefined,
  };
}

interface ExecuteHookCommandInput {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  detached: boolean;
}

interface ExecuteHookCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function executeHookCommand(input: ExecuteHookCommandInput): Promise<ExecuteHookCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: input.detached,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendCaptured(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", input.detached);
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", input.detached);
      }, 500);
      forceKillTimer.unref();
    }, input.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function appendCaptured(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next).subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
}

function hookFailureOutput(stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
  return output.length > 1_000 ? `${output.slice(0, 997)}...` : output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
