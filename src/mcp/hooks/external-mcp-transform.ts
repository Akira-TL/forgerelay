import { performance } from "node:perf_hooks";
import type { LoggingConfig } from "../../runtime/logging/logger.js";
import { ConfigSourceRuntime } from "../../runtime/config/runtime/source-refresh.js";
import { commandPreview, logEvent, workspaceLogLabel } from "../../runtime/logging/logger.js";
import {
  resolveCompatibilityCommandShellRuntime,
  snapshotCommandShellRuntime,
  type CommandShellRuntime,
} from "../../runtime/shell/command-shell-runtime.js";
import type { WorkspaceMode } from "../../workspaces/state/workspace-store.js";
import type { ProjectContext } from "../../workspaces/state/project-context.js";
import { resolveShellCommandForRuntime } from "../process/process-platform.js";
import { executeHookCommand } from "./command-runner.js";
import {
  resolveHookExecutionPlan,
  type HookConfig,
  type HookEvent,
  type HookExecutionReport,
  type HookHandler,
  type HookInvocation,
} from "./hooks.js";

export type ExternalMcpTransformPhase = "request" | "result";

export interface ExternalMcpTransformContext {
  workspaceId: string;
  workspaceRoot: string;
  workspaceMode?: WorkspaceMode;
  project?: Pick<ProjectContext, "sharedConfigDir" | "localConfigDir">;
  server: string;
  tool: string;
}

export interface ExternalMcpTransformSummary {
  phase: ExternalMcpTransformPhase;
  name: string;
  scope: "global" | "project";
  status: "passed";
}

export interface ExternalMcpTransformResult<T> {
  value: T;
  transforms: ExternalMcpTransformSummary[];
}

export class ExternalMcpTransformError extends Error {
  constructor(
    readonly server: string,
    readonly tool: string,
    readonly hookName: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalMcpTransformError";
  }
}

const TRANSFORM_PROTOCOL_VERSION = 1;
const MIN_TRANSFORM_CAPTURE_BYTES = 1024 * 1024;
const TRANSFORM_CAPTURE_OVERHEAD_BYTES = 256 * 1024;

export class ExternalMcpTransformRunner {
  private readonly commandShellRuntime: CommandShellRuntime;
  private readonly maxCaptureBytes: number;

  constructor(
    private readonly hooks: HookConfig,
    private readonly logging: LoggingConfig,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    commandShellRuntime?: CommandShellRuntime,
    mediaMaxBytes = 20 * 1024 * 1024,
    private readonly configDir?: string,
    private readonly sourceRuntime: ConfigSourceRuntime = new ConfigSourceRuntime(),
  ) {
    this.commandShellRuntime = snapshotCommandShellRuntime(
      commandShellRuntime ?? resolveCompatibilityCommandShellRuntime(process.platform, baseEnv),
    );
    this.maxCaptureBytes = Math.max(
      MIN_TRANSFORM_CAPTURE_BYTES,
      Math.ceil((mediaMaxBytes * 4) / 3) + TRANSFORM_CAPTURE_OVERHEAD_BYTES,
    );
  }

  async transformRequest(
    context: ExternalMcpTransformContext,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExternalMcpTransformResult<Record<string, unknown>>> {
    return this.run("request", context, arguments_, signal) as Promise<
      ExternalMcpTransformResult<Record<string, unknown>>
    >;
  }

  async transformResult<T>(
    context: ExternalMcpTransformContext,
    result: T,
    signal?: AbortSignal,
  ): Promise<ExternalMcpTransformResult<T>> {
    return this.run("result", context, result, signal) as Promise<ExternalMcpTransformResult<T>>;
  }

  private async run(
    phase: ExternalMcpTransformPhase,
    context: ExternalMcpTransformContext,
    initialValue: unknown,
    signal?: AbortSignal,
  ): Promise<ExternalMcpTransformResult<unknown>> {
    signal?.throwIfAborted();
    const event: HookEvent = phase === "request"
      ? "ExternalMcpBeforeForward"
      : "ExternalMcpAfterForward";
    const invocation: HookInvocation = {
      workspaceId: context.workspaceId,
      workspaceRoot: context.workspaceRoot,
      workspaceMode: context.workspaceMode,
      payload: transformMetadata(context, phase),
    };
    const plan = await resolveHookExecutionPlan({
      event,
      invocation,
      legacyUser: this.hooks,
      ...(this.configDir ? { configDir: this.configDir } : {}),
      ...(context.project ? { project: context.project } : {}),
      sourceRuntime: this.sourceRuntime,
    });
    const handlers = plan.handlers;

    let value = initialValue;
    const transforms: ExternalMcpTransformSummary[] = [];
    for (const [index, entry] of handlers.entries()) {
      signal?.throwIfAborted();
      const execution = await this.runHandler(
        event,
        phase,
        context,
        entry.handler,
        entry.scope,
        index,
        value,
        signal,
      );
      value = execution.value;
      transforms.push({
        phase,
        name: execution.report.name,
        scope: execution.report.scope,
        status: "passed",
      });
    }
    return { value, transforms };
  }

  private async runHandler(
    event: HookEvent,
    phase: ExternalMcpTransformPhase,
    context: ExternalMcpTransformContext,
    handler: HookHandler,
    scope: "global" | "project",
    index: number,
    currentValue: unknown,
    signal?: AbortSignal,
  ): Promise<{ value: unknown; report: HookExecutionReport }> {
    const startedAt = performance.now();
    const name = handler.name ?? `${event} handler ${index + 1}`;
    const shell = resolveShellCommandForRuntime(handler.command, this.commandShellRuntime);
    const detached = process.platform !== "win32";
    const metadata = transformMetadata(context, phase);
    const env: NodeJS.ProcessEnv = {
      ...this.baseEnv,
      FORGERELAY_HOOK_EVENT: event,
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify(metadata),
      FORGERELAY_WORKSPACE_ROOT: context.workspaceRoot,
      FORGERELAY_WORKSPACE_ID: context.workspaceId,
      FORGERELAY_WORKSPACE_MODE: context.workspaceMode,
      FORGERELAY_TOOL_NAME: "capability",
      FORGERELAY_CAPABILITY_NAME: "mcp.external",
      FORGERELAY_EXTERNAL_MCP_SERVER: context.server,
      FORGERELAY_EXTERNAL_MCP_TOOL: context.tool,
      FORGERELAY_TRANSFORM_PHASE: phase,
    };
    const stdin = JSON.stringify(transformInput(phase, context, currentValue));

    try {
      const result = await executeHookCommand({
        executable: shell.executable,
        args: shell.args,
        windowsVerbatimArguments: shell.windowsVerbatimArguments,
        cwd: context.workspaceRoot,
        env,
        timeoutMs: handler.timeoutSeconds * 1_000,
        detached,
        signal,
        stdin,
        maxCaptureBytes: this.maxCaptureBytes,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      if (result.exitCode !== 0 || result.timedOut || result.signal) {
        const reason = result.timedOut
          ? `timed out after ${handler.timeoutSeconds}s`
          : result.signal
            ? `terminated by ${result.signal}`
            : `exited with code ${result.exitCode ?? "unknown"}`;
        this.logTransform(event, name, scope, context, false, durationMs, reason, handler.command);
        throw this.error(context, name, `transform Hook ${name} ${reason}.`);
      }

      let value: unknown;
      try {
        value = parseTransformOutput(phase, result.stdout);
      } catch {
        this.logTransform(
          event,
          name,
          scope,
          context,
          false,
          durationMs,
          "invalid structured transform output",
          handler.command,
        );
        throw this.error(
          context,
          name,
          `transform Hook ${name} returned invalid structured transform output.`,
        );
      }
      this.logTransform(event, name, scope, context, true, durationMs, undefined, handler.command);
      return {
        value,
        report: {
          event,
          name: boundedName(name),
          scope,
          status: "passed",
          durationMs,
          report: handler.report,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ExternalMcpTransformError) throw error;
      const durationMs = Math.round(performance.now() - startedAt);
      this.logTransform(event, name, scope, context, false, durationMs, "failed to start", handler.command);
      throw this.error(context, name, `transform Hook ${name} failed to start.`);
    }
  }

  private error(
    context: ExternalMcpTransformContext,
    name: string,
    detail: string,
  ): ExternalMcpTransformError {
    return new ExternalMcpTransformError(
      context.server,
      context.tool,
      boundedName(name),
      `External MCP ${context.server} tool ${context.tool} ${detail}`,
    );
  }

  private logTransform(
    event: HookEvent,
    name: string,
    scope: "global" | "project",
    context: ExternalMcpTransformContext,
    success: boolean,
    durationMs: number,
    error: string | undefined,
    command: string,
  ): void {
    logEvent(this.logging, success ? "info" : "warn", "hook_call", {
      hookEvent: event,
      hookName: boundedName(name),
      hookScope: scope,
      workspaceId: context.workspaceId,
      workspace: workspaceLogLabel(context.workspaceRoot, context.workspaceId),
      capability: "mcp.external",
      externalServer: context.server,
      externalTool: context.tool,
      success,
      durationMs,
      error,
      commandPreview: this.logging.shellCommands ? commandPreview(command) : undefined,
    });
  }
}

function transformMetadata(
  context: ExternalMcpTransformContext,
  phase: ExternalMcpTransformPhase,
): Record<string, unknown> {
  return {
    tool: "capability",
    capability: "mcp.external",
    externalServer: context.server,
    externalTool: context.tool,
    transformPhase: phase,
  };
}

function transformInput(
  phase: ExternalMcpTransformPhase,
  context: ExternalMcpTransformContext,
  value: unknown,
): Record<string, unknown> {
  const base = {
    version: TRANSFORM_PROTOCOL_VERSION,
    phase,
    capability: "mcp.external",
    server: context.server,
    tool: context.tool,
  };
  return phase === "request"
    ? { ...base, request: { arguments: value } }
    : { ...base, result: value };
}

function parseTransformOutput(phase: ExternalMcpTransformPhase, stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("empty transform output");
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.version !== TRANSFORM_PROTOCOL_VERSION) {
    throw new Error("invalid transform envelope");
  }
  const allowedKeys = phase === "request"
    ? new Set(["version", "request"])
    : new Set(["version", "result"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("unexpected transform envelope field");
  }
  if (phase === "request") {
    if (!isRecord(value.request) || !isRecord(value.request.arguments)) {
      throw new Error("invalid request transform output");
    }
    if (Object.keys(value.request).some((key) => key !== "arguments")) {
      throw new Error("unexpected request transform field");
    }
    return value.request.arguments;
  }
  if (!isRecord(value.result)) throw new Error("invalid result transform output");
  return value.result;
}

function boundedName(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
