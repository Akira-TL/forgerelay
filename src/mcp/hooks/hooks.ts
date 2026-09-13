import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { WorkspaceMode } from "../../workspaces/state/workspace-store.js";
import type { LoggingConfig } from "../../runtime/logging/logger.js";
import { commandPreview, logEvent, workspaceLogLabel } from "../../runtime/logging/logger.js";
import { resolveCompatibilityCommandShellRuntime, snapshotCommandShellRuntime, type CommandShellRuntime } from "../../runtime/shell/command-shell-runtime.js";
import { resolveShellCommandForRuntime } from "../process/process-platform.js";
import { executeHookCommand, hookFailureOutput } from "./command-runner.js";
import { resolveProjectContext, type ProjectContext } from "../../workspaces/state/project-context.js";
import { effectiveHookConfigEntries, resolveHooksConfig } from "../../runtime/config/resolution/hooks.js";
import { compatibilityAllowProjectExecutionTrustPolicy, projectExecutionRequirement, type ProjectExecutionRequirement, type ProjectExecutionTrustPolicy } from "../../runtime/security/project-execution-trust.js";
import { ConfigSourceRuntime } from "../../runtime/config/runtime/source-refresh.js";
import { HOOK_EVENTS, type ResolvedHookEntryInput } from "./config.js";

export { HOOK_EVENTS } from "./config.js";
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
  capability?: string;
  externalServer?: string;
  externalTool?: string;
}

export interface HookMatcher {
  tool?: string;
  commandRegex?: string;
  pathRegex?: string;
  provider?: string;
  workspaceMode?: WorkspaceMode;
  capability?: string;
  externalServer?: string;
  externalTool?: string;
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

export interface HookExecutionPlanEntry {
  scope: HookExecutionReport["scope"];
  handler: HookHandler;
  invocation: HookInvocation;
  executionRequirement?: ProjectExecutionRequirement;
}

export interface HookExecutionPlan {
  handlers: HookExecutionPlanEntry[];
  resolution: Awaited<ReturnType<typeof resolveHooksConfig>>;
}

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
const MAX_HOOK_TIMEOUT_SECONDS = 300;
const BLOCKING_EVENTS = new Set<HookEvent>([
  "BeforeTool",
  "ExternalMcpBeforeForward",
  "ExternalMcpAfterForward",
  "BeforeWorktreeClose",
]);
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
  signal?: AbortSignal;
  operation: () => Promise<T>;
  isFailure?: (result: T) => boolean;
  changedPaths?: (result: T) => string[];
  afterCwd?: (result: T) => string | undefined;
}

function decorateToolResult<T>(runner: HookRunner, workspaceId: string | undefined, result: T): T {
  const decorator = (runner as { decorateResult?: (workspaceId: string, result: T) => T }).decorateResult;
  return workspaceId && typeof decorator === "function"
    ? decorator.call(runner, workspaceId, result)
    : result;
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
    }, options.signal));
    options.signal?.throwIfAborted();
    const result = await options.operation();
    const afterCwd = options.afterCwd?.(result);

    if (options.isFailure?.(result)) {
      executions.push(...await runner.run("AfterToolFailure", {
        ...options.invocation,
        cwd: afterCwd,
        payload: basePayload,
      }, options.signal));
      const reported = attachHookReports(result, executions);
      return decorateToolResult(runner, options.invocation.workspaceId, reported);
    }

    executions.push(...await runner.run("AfterTool", {
      ...options.invocation,
      cwd: afterCwd,
      payload: basePayload,
    }, options.signal));
    const changedPaths = options.changedPaths?.(result) ?? [];
    if (changedPaths.length > 0) {
      executions.push(...await runner.run("AfterFileChange", {
        ...options.invocation,
        cwd: afterCwd,
        payload: { ...basePayload, paths: changedPaths },
      }, options.signal));
    }
    const reported = attachHookReports(result, executions);
    return decorateToolResult(runner, options.invocation.workspaceId, reported);
  } catch (error) {
    if (error instanceof HookExecutionError) {
      executions.push(...error.executions);
    }
    if (!options.signal?.aborted) {
      executions.push(...await runner.run("AfterToolFailure", {
        ...options.invocation,
        payload: {
          ...basePayload,
          errorType: error instanceof Error ? error.name : "Error",
        },
      }, options.signal));
    }
    const reportedError = appendHookReportsToError(error, executions);
    throw decorateToolResult(runner, options.invocation.workspaceId, reportedError);
  }
}

export function attachHookReports<T>(result: T, executions: HookExecutionReport[]): T {
  const summary = formatVisibleHookReports(executions);
  if (!summary || !isRecord(result) || !Array.isArray(result.content)) return result;

  const structuredContent = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const structuredResult = typeof structuredContent?.result === "string"
    ? structuredContent.result
    : undefined;

  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: summary,
      },
    ],
    ...(structuredContent && structuredResult !== undefined
      ? {
          structuredContent: {
            ...structuredContent,
            result: `${structuredResult}\n\n${summary}`,
          },
        }
      : {}),
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

export async function resolveHookExecutionPlan(input: {
  event: HookEvent;
  invocation: HookInvocation;
  legacyUser: HookConfig;
  configDir?: string;
  project?: Pick<ProjectContext, "id" | "sharedConfigDir" | "localConfigDir">; sourceRuntime?: ConfigSourceRuntime;
}): Promise<HookExecutionPlan> {
  let projectRoot = input.event === "AfterWorktreeClose" && input.invocation.sourceRoot
    ? input.invocation.sourceRoot
    : input.invocation.workspaceRoot;
  let project = input.project;
  if (!project && input.configDir) {
    try {
      project = await resolveProjectContext(input.configDir, projectRoot);
    } catch (error) {
      const sourceRoot = input.invocation.sourceRoot;
      if (!sourceRoot || projectRoot === sourceRoot || !isMissingPath(error)) throw error;
      projectRoot = sourceRoot;
      project = await resolveProjectContext(input.configDir, projectRoot);
    }
  }
  const resolution = await resolveHooksConfig({
    ...(input.configDir ? { configDir: input.configDir } : {}),
    ...(project ? { project } : {}),
    projectSharedConfigDir: join(projectRoot, ".forgerelay"),
    legacyUser: input.legacyUser, ...(input.sourceRuntime ? { sourceRuntime: input.sourceRuntime } : {}),
  });
  const handlers = effectiveHookConfigEntries(resolution).flatMap((entry) =>
    entry.entries.flatMap((hook) => {
      if (hook.event !== input.event) return [];
      const matchedInvocation = matchHookRule(hook.matcher, input.invocation);
      if (!matchedInvocation) return [];
      const requirement = project ? projectExecutionRequirement({
        projectId: project.id, resolution, entryKey: `hooks.${entry.name}`,
        display: { kind: "hook", name: entry.name },
      }) : undefined;
      return [{
        scope: entry.scope === "user" ? "global" as const : "project" as const,
        handler: resolvedHookHandler(entry.name, hook), invocation: matchedInvocation,
        ...(requirement ? { executionRequirement: requirement } : {}),
      }];
    })
  );
  return { handlers, resolution };
}

export class HookRunner {
  private readonly commandShellRuntime: CommandShellRuntime;

  constructor(
    private readonly hooks: HookConfig,
    private readonly logging: LoggingConfig,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly resultDecorator?: (workspaceId: string, result: unknown) => unknown,
    commandShellRuntime?: CommandShellRuntime,
    private readonly configDir?: string, private readonly sourceRuntime: ConfigSourceRuntime = new ConfigSourceRuntime(),
    private readonly projectExecutionTrustPolicy: ProjectExecutionTrustPolicy = compatibilityAllowProjectExecutionTrustPolicy,
  ) {
    this.commandShellRuntime = snapshotCommandShellRuntime(
      commandShellRuntime ?? resolveCompatibilityCommandShellRuntime(process.platform, baseEnv),
    );
  }

  decorateResult<T>(workspaceId: string, result: T): T {
    return (this.resultDecorator?.(workspaceId, result) ?? result) as T;
  }

  async run(
    event: HookEvent,
    invocation: HookInvocation,
    signal?: AbortSignal,
  ): Promise<HookExecutionReport[]> {
    signal?.throwIfAborted();
    const plan = await resolveHookExecutionPlan({
      event,
      invocation,
      legacyUser: this.hooks,
      ...(this.configDir ? { configDir: this.configDir } : {}), sourceRuntime: this.sourceRuntime,
    });
    const blocking = BLOCKING_EVENTS.has(event);
    const executions: HookExecutionReport[] = hookResolutionReports(plan.resolution, event);

    const handlers = plan.handlers;

    for (const [index, { scope, handler, invocation: matchedInvocation, executionRequirement }] of handlers.entries()) {
      signal?.throwIfAborted();
      const execution = await this.runHandler(event, handler, index, matchedInvocation, scope, executionRequirement, signal);
      executions.push(execution);
      logEvent(this.logging, execution.status === "passed" ? "info" : "warn", "hook_call", {
        hookEvent: event,
        hookName: execution.name,
        hookScope: execution.scope,
        workspaceId: invocation.workspaceId,
        workspace: invocation.workspaceId
          ? workspaceLogLabel(invocation.workspaceRoot, invocation.workspaceId)
          : invocation.workspaceRoot,
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
    scope: HookExecutionReport["scope"], executionRequirement?: ProjectExecutionRequirement,
    signal?: AbortSignal,
  ): Promise<HookExecutionReport> {
    const startedAt = performance.now();
    const name = handler.name ?? `${event} handler ${index + 1}`;
    const shell = resolveShellCommandForRuntime(handler.command, this.commandShellRuntime);
    const detached = process.platform !== "win32";
    const env = hookEnvironment(this.baseEnv, event, invocation);

    try {
      if (executionRequirement) await this.projectExecutionTrustPolicy.authorize(executionRequirement);
      const result = await executeHookCommand({
        executable: shell.executable,
        args: shell.args,
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
        cwd: invocation.cwd ?? invocation.workspaceRoot,
        env,
        timeoutMs: handler.timeoutSeconds * 1_000,
        detached,
        signal,
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
      if (signal?.aborted) throw error;
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

function resolvedHookHandler(name: string, hook: ResolvedHookEntryInput): HookHandler {
  const legacySyntheticName = name.startsWith("@legacy/");
  return {
    ...((hook.name ?? (!legacySyntheticName ? name : undefined))
      ? { name: hook.name ?? name }
      : {}),
    command: hook.command,
    timeoutSeconds: hook.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
    report: hook.report ?? true,
  };
}

function hookResolutionReports(
  resolution: Awaited<ReturnType<typeof resolveHooksConfig>>,
  event: HookEvent,
): HookExecutionReport[] {
  const grouped = new Map<"global" | "project", string[]>();
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.severity !== "error" || diagnostic.diagnosticChanged === false) continue;
    const scope = diagnostic.source.scope === "user"
      ? "global"
      : diagnostic.source.scope === "project" || diagnostic.source.scope === "project-local"
        ? "project"
        : undefined;
    if (!scope) continue;
    const location = diagnostic.source.location ?? diagnostic.source.id;
    grouped.set(scope, [...(grouped.get(scope) ?? []), `${location}: ${diagnostic.message}`]);
  }
  return (["global", "project"] as const).flatMap((scope) => {
    const errors = grouped.get(scope);
    if (!errors?.length) return [];
    return [{
      event,
      name: scope === "global" ? "Global hooks config" : "Project hooks config",
      scope,
      status: "failed" as const,
      durationMs: 0,
      report: true,
      error: errors.join(" | "),
    }];
  });
}

function parseHookRule(event: HookEvent, value: unknown, index: number): HookRule {
  if (!isRecord(value)) {
    throw new Error(`Hook ${event} entry ${index + 1} must be an object`);
  }

  if (!("handlers" in value)) {
    return {
      matcher: parseHookMatcher(event, value.matcher, index),
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
  if (value.capability !== undefined) {
    if (typeof value.capability !== "string" || value.capability.trim().length === 0) {
      throw new Error(`Hook ${event} matcher capability must be a non-empty string`);
    }
    matcher.capability = value.capability.trim();
  }
  if (value.externalServer !== undefined) {
    if (typeof value.externalServer !== "string" || value.externalServer.trim().length === 0) {
      throw new Error(`Hook ${event} matcher externalServer must be a non-empty string`);
    }
    matcher.externalServer = value.externalServer.trim();
  }
  if (value.externalTool !== undefined) {
    if (typeof value.externalTool !== "string" || value.externalTool.trim().length === 0) {
      throw new Error(`Hook ${event} matcher externalTool must be a non-empty string`);
    }
    matcher.externalTool = value.externalTool.trim();
  }

  const knownKeys = new Set([
    "tool",
    "commandRegex",
    "pathRegex",
    "provider",
    "workspaceMode",
    "capability",
    "externalServer",
    "externalTool",
  ]);
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

export function matchHookRule(
  matcher: HookMatcher | undefined,
  invocation: HookInvocation,
): HookInvocation | undefined {
  if (!matcher) return invocation;

  if (matcher.workspaceMode && invocation.workspaceMode !== matcher.workspaceMode) return undefined;

  if (matcher.tool) {
    if (typeof invocation.payload?.tool !== "string" || invocation.payload.tool !== matcher.tool) {
      return undefined;
    }
  }

  let matchedInvocation = invocation;
  if (matcher.commandRegex) {
    const command = invocation.payload?.command;
    if (typeof command !== "string") return undefined;
    const commandMatch = new RegExp(matcher.commandRegex).exec(command);
    if (!commandMatch) return undefined;
    if (commandMatch[0] !== command) {
      matchedInvocation = {
        ...invocation,
        payload: {
          ...invocation.payload,
          command: commandMatch[0],
          originalCommand: command,
        },
      };
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
    if (!matchesPath && !matchesPaths) return undefined;
  }

  if (matcher.provider) {
    if (
      typeof invocation.payload?.provider !== "string" ||
      invocation.payload.provider !== matcher.provider
    ) {
      return undefined;
    }
  }

  if (matcher.capability) {
    if (invocation.payload?.capability !== matcher.capability) return undefined;
  }
  if (matcher.externalServer) {
    if (invocation.payload?.externalServer !== matcher.externalServer) return undefined;
  }
  if (matcher.externalTool) {
    if (invocation.payload?.externalTool !== matcher.externalTool) return undefined;
  }

  return matchedInvocation;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
