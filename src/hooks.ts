import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  name?: string;
  command: string;
  timeoutSeconds?: number;
  report?: boolean;
}

export interface HookHandler {
  name?: string;
  command: string;
  timeoutSeconds: number;
  report: boolean;
}

export interface HookMatcherInput {
  tool?: string;
  commandRegex?: string;
  pathRegex?: string;
  provider?: string;
  workspaceMode?: WorkspaceMode;
}

export interface HookMatcher {
  tool?: string;
  commandRegex?: string;
  pathRegex?: string;
  provider?: string;
  workspaceMode?: WorkspaceMode;
}

export interface HookRuleInput {
  matcher?: HookMatcherInput;
  handlers: HookHandlerInput[];
}

export interface HookRule {
  matcher?: HookMatcher;
  handlers: HookHandler[];
}

export type HookConfig = Partial<Record<HookEvent, HookRule[]>>;
export type HookConfigEntryInput = HookHandlerInput | HookRuleInput;
export type HookConfigInput = Partial<Record<HookEvent, HookConfigEntryInput[]>>;

export interface HookInvocation {
  workspaceId?: string;
  workspaceRoot: string;
  workspaceMode?: WorkspaceMode;
  sourceRoot?: string;
  cwd?: string;
  payload?: Record<string, unknown>;
}

export interface HookExecutionReport {
  event: HookEvent;
  name: string;
  scope: "global" | "project";
  status: "passed" | "failed";
  durationMs: number;
  report: boolean;
  error?: string;
}

export interface HookReportContainer {
  hookReports: HookExecutionReport[];
}

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
const MAX_HOOK_TIMEOUT_SECONDS = 300;
const PROJECT_HOOKS_PATH = join(".forgerelay", "hooks.json");
const PROJECT_HOOKS_DIR = join(".forgerelay", "hooks");
const MAX_CAPTURE_BYTES = 64 * 1024;
const BLOCKING_EVENTS = new Set<HookEvent>(["BeforeTool", "BeforeWorktreeClose"]);
const EVENT_SET = new Set<string>(HOOK_EVENTS);

export class HookExecutionError extends Error {
  constructor(
    readonly event: HookEvent,
    readonly handlerIndex: number,
    message: string,
    readonly executions: HookExecutionReport[] = [],
  ) {
    super(message);
    this.name = "HookExecutionError";
  }
}

export function mergeHookConfigs(...configs: HookConfig[]): HookConfig {
  const merged: HookConfig = {};
  for (const config of configs) {
    for (const event of HOOK_EVENTS) {
      const rules = config[event];
      if (!rules?.length) continue;
      merged[event] = [...(merged[event] ?? []), ...rules];
    }
  }
  return merged;
}

export function parseHookFile(value: unknown, hookName: string): HookConfig {
  if (!hookName.trim()) throw new Error("ForgeRelay hook filename must not be empty");
  if (!isRecord(value)) {
    throw new Error(`ForgeRelay hook ${hookName} must be a JSON object`);
  }

  const eventName = value.event;
  if (typeof eventName !== "string" || !EVENT_SET.has(eventName)) {
    throw new Error(`ForgeRelay hook ${hookName} event must be one of: ${HOOK_EVENTS.join(", ")}`);
  }
  const event = eventName as HookEvent;
  const knownKeys = new Set(["event", "matcher", "command", "timeoutSeconds", "report"]);
  const unknownKey = Object.keys(value).find((key) => !knownKeys.has(key));
  if (unknownKey) {
    throw new Error(`Unknown ForgeRelay hook ${hookName} field: ${unknownKey}`);
  }

  const matcher = parseHookMatcher(event, value.matcher, 0);
  const handler = parseHookHandler(event, {
    name: hookName,
    command: value.command,
    timeoutSeconds: value.timeoutSeconds,
    report: value.report,
  }, 0);
  return {
    [event]: [{ ...(matcher ? { matcher } : {}), handlers: [handler] }],
  };
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
      throw new Error(`Hook ${event} must be an array of hook rules or command handlers`);
    }

    config[event] = rawHandlers.map((entry, index) => parseHookRule(event, entry, index));
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
  const executions: HookExecutionReport[] = [];
  try {
    executions.push(...await runner.run("BeforeTool", {
      ...options.invocation,
      payload: basePayload,
    }));
    const result = await options.operation();
    const afterCwd = options.afterCwd?.(result);

    if (options.isFailure?.(result)) {
      executions.push(...await runner.run("AfterToolFailure", {
        ...options.invocation,
        cwd: afterCwd,
        payload: basePayload,
      }));
      return attachHookReports(result, executions);
    }

    executions.push(...await runner.run("AfterTool", {
      ...options.invocation,
      cwd: afterCwd,
      payload: basePayload,
    }));
    const changedPaths = options.changedPaths?.(result) ?? [];
    if (changedPaths.length > 0) {
      executions.push(...await runner.run("AfterFileChange", {
        ...options.invocation,
        cwd: afterCwd,
        payload: { ...basePayload, paths: changedPaths },
      }));
    }
    return attachHookReports(result, executions);
  } catch (error) {
    if (error instanceof HookExecutionError) {
      executions.push(...error.executions);
    }
    executions.push(...await runner.run("AfterToolFailure", {
      ...options.invocation,
      payload: {
        ...basePayload,
        errorType: error instanceof Error ? error.name : "Error",
      },
    }));
    throw appendHookReportsToError(error, executions);
  }
}

export function attachHookReports<T>(result: T, executions: HookExecutionReport[]): T {
  const summary = formatVisibleHookReports(executions);
  if (!summary || !isRecord(result) || !Array.isArray(result.content)) return result;

  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: summary,
      },
    ],
  } as T;
}

function appendHookReportsToError(
  error: unknown,
  executions: HookExecutionReport[],
): Error {
  const summary = formatVisibleHookReports(executions) ?? "";
  if (error instanceof Error) {
    if (summary && !error.message.includes(summary)) {
      error.message = `${error.message}\n\n${summary}`;
    }
    return error;
  }

  return new Error(summary ? `${String(error)}\n\n${summary}` : String(error));
}

function visibleHookReports(executions: HookExecutionReport[]): HookExecutionReport[] {
  return executions.filter((execution) =>
    execution.report ||
    (execution.status === "failed" && BLOCKING_EVENTS.has(execution.event))
  );
}

export function formatVisibleHookReports(executions: HookExecutionReport[]): string | undefined {
  const visible = visibleHookReports(executions);
  return visible.length > 0 ? formatHookReports(visible) : undefined;
}

function formatHookReports(executions: HookExecutionReport[]): string {
  return [
    "Hook results:",
    ...executions.map((execution) => {
      const marker = execution.status === "passed" ? "✓" : "✗";
      const result = execution.status === "passed"
        ? "passed"
        : `failed${execution.error ? `: ${execution.error}` : ""}`;
      return `${marker} ${execution.name} (${execution.event}, ${execution.scope}) ${result} in ${execution.durationMs}ms`;
    }),
  ].join("\n");
}

export class HookRunner {
  constructor(
    private readonly hooks: HookConfig,
    private readonly logging: LoggingConfig,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(event: HookEvent, invocation: HookInvocation): Promise<HookExecutionReport[]> {
    const projectRoot = event === "AfterWorktreeClose" && invocation.sourceRoot
      ? invocation.sourceRoot
      : invocation.workspaceRoot;
    const project = await loadProjectHookConfig(projectRoot);
    const handlers = [
      ...(this.hooks[event] ?? []).map((rule) => ({ scope: "global" as const, rule })),
      ...(project.hooks[event] ?? []).map((rule) => ({ scope: "project" as const, rule })),
    ]
      .filter(({ rule }) => hookRuleMatches(rule.matcher, invocation))
      .flatMap(({ scope, rule }) => rule.handlers.map((handler) => ({ scope, handler })));
    const blocking = BLOCKING_EVENTS.has(event);
    const executions: HookExecutionReport[] = project.diagnostic
      ? [{
          event,
          name: "Project hooks config",
          scope: "project",
          status: "failed",
          durationMs: 0,
          report: true,
          error: project.diagnostic,
        }]
      : [];

    for (const [index, { scope, handler }] of handlers.entries()) {
      const execution = await this.runHandler(event, handler, index, invocation, scope);
      executions.push(execution);
      logEvent(this.logging, execution.status === "passed" ? "info" : "warn", "hook_call", {
        hookEvent: event,
        hookName: execution.name,
        hookScope: execution.scope,
        workspaceId: invocation.workspaceId,
        success: execution.status === "passed",
        durationMs: execution.durationMs,
        error: execution.error,
        commandPreview: this.logging.shellCommands ? commandPreview(handler.command) : undefined,
      });
      if (execution.status === "failed" && blocking) {
        throw new HookExecutionError(event, index, execution.error ?? `Hook ${execution.name} failed`, executions);
      }
    }

    return executions;
  }

  private async runHandler(
    event: HookEvent,
    handler: HookHandler,
    index: number,
    invocation: HookInvocation,
    scope: HookExecutionReport["scope"],
  ): Promise<HookExecutionReport> {
    const startedAt = performance.now();
    const name = handler.name ?? `${event} handler ${index + 1}`;
    const shell = resolveShellCommand(handler.command, process.platform, this.baseEnv);
    const detached = process.platform !== "win32";
    const env = hookEnvironment(this.baseEnv, event, invocation);

    try {
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
        return {
          event,
          name,
          scope,
          status: "passed",
          durationMs,
          report: handler.report,
        };
      }

      const reason = result.timedOut
        ? `timed out after ${handler.timeoutSeconds}s`
        : result.signal
          ? `terminated by ${result.signal}`
          : `exited with code ${result.exitCode ?? "unknown"}`;
      const output = hookFailureOutput(result.stdout, result.stderr);
      return {
        event,
        name,
        scope,
        status: "failed",
        durationMs,
        report: handler.report,
        error: `Hook ${name} ${reason}${output ? `: ${output}` : ""}`,
      };
    } catch (error) {
      return {
        event,
        name,
        scope,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        report: handler.report,
        error: `Hook ${name} failed to start: ${errorMessage(error)}`,
      };
    }
  }
}

function parseHookRule(event: HookEvent, value: unknown, index: number): HookRule {
  if (!isRecord(value)) {
    throw new Error(`Hook ${event} entry ${index + 1} must be an object`);
  }

  if (!("handlers" in value)) {
    return {
      handlers: [parseHookHandler(event, value, index)],
    };
  }

  if (!Array.isArray(value.handlers) || value.handlers.length === 0) {
    throw new Error(`Hook ${event} rule ${index + 1} handlers must be a non-empty array`);
  }

  return {
    matcher: parseHookMatcher(event, value.matcher, index),
    handlers: value.handlers.map((handler, handlerIndex) =>
      parseHookHandler(event, handler, handlerIndex)
    ),
  };
}

function parseHookMatcher(
  event: HookEvent,
  value: unknown,
  index: number,
): HookMatcher | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Hook ${event} rule ${index + 1} matcher must be an object`);
  }

  const matcher: HookMatcher = {};
  if (value.tool !== undefined) {
    if (typeof value.tool !== "string" || value.tool.trim().length === 0) {
      throw new Error(`Hook ${event} matcher tool must be a non-empty string`);
    }
    matcher.tool = value.tool.trim();
  }
  if (value.commandRegex !== undefined) {
    if (typeof value.commandRegex !== "string" || value.commandRegex.length === 0) {
      throw new Error(`Hook ${event} matcher commandRegex must be a non-empty string`);
    }
    assertValidRegex(event, "commandRegex", value.commandRegex);
    matcher.commandRegex = value.commandRegex;
  }
  if (value.pathRegex !== undefined) {
    if (typeof value.pathRegex !== "string" || value.pathRegex.length === 0) {
      throw new Error(`Hook ${event} matcher pathRegex must be a non-empty string`);
    }
    assertValidRegex(event, "pathRegex", value.pathRegex);
    matcher.pathRegex = value.pathRegex;
  }
  if (value.provider !== undefined) {
    if (typeof value.provider !== "string" || value.provider.trim().length === 0) {
      throw new Error(`Hook ${event} matcher provider must be a non-empty string`);
    }
    matcher.provider = value.provider.trim();
  }
  if (value.workspaceMode !== undefined) {
    if (value.workspaceMode !== "checkout" && value.workspaceMode !== "worktree") {
      throw new Error(`Hook ${event} matcher workspaceMode must be checkout or worktree`);
    }
    matcher.workspaceMode = value.workspaceMode;
  }

  const knownKeys = new Set(["tool", "commandRegex", "pathRegex", "provider", "workspaceMode"]);
  const unknownKey = Object.keys(value).find((key) => !knownKeys.has(key));
  if (unknownKey) {
    throw new Error(`Unknown Hook ${event} matcher field: ${unknownKey}`);
  }

  return matcher;
}

function parseHookHandler(event: HookEvent, value: unknown, index: number): HookHandler {
  if (!isRecord(value)) {
    throw new Error(`Hook ${event} handler ${index + 1} must be an object`);
  }

  const name = value.name === undefined
    ? undefined
    : typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : null;
  if (name === null) {
    throw new Error(`Hook ${event} name must be a non-empty string when provided`);
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

  const report = value.report ?? true;
  if (typeof report !== "boolean") {
    throw new Error(`Hook ${event} report must be a boolean`);
  }

  return { name: name ?? undefined, command, timeoutSeconds, report };
}

function assertValidRegex(event: HookEvent, field: string, pattern: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new Error(`Hook ${event} matcher ${field} must be a valid regular expression`);
  }
}

export interface ProjectHookLoadResult {
  hooks: HookConfig;
  diagnostic?: string;
}

export async function loadProjectHookConfig(workspaceRoot: string): Promise<ProjectHookLoadResult> {
  let hooks: HookConfig = {};
  const diagnostics: string[] = [];
  const aggregatePath = join(workspaceRoot, PROJECT_HOOKS_PATH);

  try {
    const content = await readFile(aggregatePath, "utf8");
    hooks = mergeHookConfigs(hooks, parseHookConfig(JSON.parse(content)));
  } catch (error) {
    if (!(isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
      diagnostics.push(`Could not load project hooks at ${aggregatePath}: ${errorMessage(error)}`);
    }
  }

  const directory = join(workspaceRoot, PROJECT_HOOKS_DIR);
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        hooks = mergeHookConfigs(hooks, parseHookFile(value, entry.name.slice(0, -5)));
      } catch (error) {
        diagnostics.push(`Could not load project hook at ${path}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    if (!(isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
      diagnostics.push(`Could not read project hook directory at ${directory}: ${errorMessage(error)}`);
    }
  }

  return {
    hooks,
    ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join(" | ") } : {}),
  };
}

function hookRuleMatches(
  matcher: HookMatcher | undefined,
  invocation: HookInvocation,
): boolean {
  if (!matcher) return true;

  if (matcher.workspaceMode && invocation.workspaceMode !== matcher.workspaceMode) return false;

  if (matcher.tool) {
    if (typeof invocation.payload?.tool !== "string" || invocation.payload.tool !== matcher.tool) {
      return false;
    }
  }

  if (matcher.commandRegex) {
    const command = invocation.payload?.command;
    if (typeof command !== "string" || !new RegExp(matcher.commandRegex).test(command)) {
      return false;
    }
  }

  if (matcher.pathRegex) {
    const pathRegex = matcher.pathRegex;
    const pathPattern = new RegExp(pathRegex);
    const path = invocation.payload?.path;
    const paths = invocation.payload?.paths;
    const matchesPath = typeof path === "string" && pathPattern.test(path);
    const matchesPaths = Array.isArray(paths) && paths.some((entry) =>
      typeof entry === "string" && new RegExp(pathRegex).test(entry)
    );
    if (!matchesPath && !matchesPaths) return false;
  }

  if (matcher.provider) {
    if (
      typeof invocation.payload?.provider !== "string" ||
      invocation.payload.provider !== matcher.provider
    ) {
      return false;
    }
  }

  return true;
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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
