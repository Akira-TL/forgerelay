import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ActivityLifecycle } from "../../activity/runtime/lifecycle.js";
import type { BashOutputStore } from "../../activity/history/bash-output-store.js";
import type { ServerConfig } from "../../runtime/config/config.js";
import { HookRunner, runToolWithHooks } from "../hooks/hooks.js";
import { commandPreview, logEvent, workspaceLogLabel } from "../../runtime/logging/logger.js";
import type {
  CoreOperationContext,
  ShellRunOperationInput,
} from "../operations/core-operation-executor.js";
import { ProcessManager, resolveProcessId } from "./process-sessions.js";
import type { Workspace, WorkspaceRegistry } from "../../workspaces.js";
import { buildShellMutationPolicy, toolNames } from "../server-instructions.js";
import {
  durableOutputResponse,
  processToolResponse,
  readWorkspaceBashOutput,
  recordBashCompletion,
  toolResultIsError,
  type ProcessToolResponse,
} from "./runtime.js";

const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export type ProcessExecutionTarget =
  | {
      executionWorkspaceId: string;
      compositeWorkspaceId?: undefined;
      memberName?: undefined;
    }
  | {
      executionWorkspaceId: string;
      compositeWorkspaceId: string;
      memberName: string;
    };

export interface ProcessToolRouting {
  resolve: (workspaceId: string, member?: string) => ProcessExecutionTarget;
  prepare: (
    target: ProcessExecutionTarget,
    requestMeta: unknown,
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
  ) => Promise<CoreOperationContext>;
  present: <T>(result: T, target: ProcessExecutionTarget) => T;
  presentSemantic: <T>(result: T, target: ProcessExecutionTarget, conversationScopeId?: string) => T;
  isRemote: (workspaceId: string) => boolean;
  bashRemote: (
    workspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId: string,
  ) => Promise<CallToolResult>;
  execCommandRemote: (
    workspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId: string,
  ) => Promise<CallToolResult>;
  writeStdinRemote: (
    workspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId: string,
  ) => Promise<CallToolResult>;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
}

export type SharedShellRun = (
  input: ShellRunOperationInput,
  context: CoreOperationContext,
) => Promise<ProcessToolResponse & { isError?: true }>;

export interface RegisterProcessToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessManager;
  hooks: HookRunner;
  activityLifecycle: ActivityLifecycle;
  bashOutputStore: BashOutputStore;
  shellRun: SharedShellRun;
  routing: ProcessToolRouting;
  descriptions: {
    shell: string;
    shellCommand: string;
  };
}

/**
 * Register the complete process surface behind one seam. Bash and Codex-style
 * process adapters intentionally share the same durable-output and completion
 * runtime so tool-mode changes cannot fork process semantics.
 */
export function registerProcessTools(options: RegisterProcessToolsOptions): void {
  if (options.config.toolMode === "codex") registerCodexProcessTools(options);
  else registerBashTool(options);
}

function registerBashTool(options: RegisterProcessToolsOptions): void {
  const {
    server,
    config,
    workspaces,
    processSessions,
    hooks,
    activityLifecycle,
    bashOutputStore,
    shellRun,
    routing,
    descriptions,
  } = options;

  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: descriptions.shell,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this process operation."),
        action: z.enum(["run", "process", "output"]).optional().describe("Defaults to run. Use process with a returned processId to poll/interact, or output with outputId to retrieve complete durable output."),
        command: z.string().optional().describe(`${descriptions.shellCommand} Required for action=run.`),
        processId: z.number().int().positive().optional().describe("Process identifier returned by a previous bash action=run call. Required for action=process."),
        outputId: z.string().optional().describe("Stable output identifier returned by a Bash run. Required for action=output."),
        input: z.string().optional().describe("Characters to write for action=process. Omit to poll/wait without input."),
        interrupt: z.boolean().optional().describe("For action=process, send SIGINT to the process. Cannot be combined with input."),
        tty: z.boolean().optional().describe("For action=run, allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width for action=run, or resize width for action=process."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height for action=run, or resize height for action=process."),
        workingDirectory: z.string().optional().describe("For action=run, working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z.number().int().min(0).max(300_000).optional().describe("Maximum feedback wait, not a minimum delay: if the process finishes sooner, the call returns immediately. For long-running commands or wait-only action=process calls, set a long window near the Host request deadline (60000ms when supported) instead of repeated short polling. For action=run, use 0 for immediate background handoff; otherwise defaults to 10000ms. For action=process, wait-only calls default to 60000ms and interaction to 250ms."),
        timeoutMs: z.number().int().min(1).max(86_400_000).optional().describe("For action=run, total execution timeout from process start. On expiry ForgeRelay terminates the process. Omit for no ForgeRelay execution deadline."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      // The unified Activity Panel is mounted by activity_panel. Process tools
      // remain headless and feed it through durable Activity state instead.
      _meta: {},
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspaceId,
      member,
      action = "run",
      command,
      processId,
      outputId,
      input,
      interrupt,
      tty,
      columns,
      rows,
      workingDirectory,
      yieldTimeMs,
      timeoutMs,
      maxOutputTokens,
    }, extra) => {
      const target = routing.resolve(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await routing.prepare(target, extra._meta, extra.signal, extra.sessionId);

      if (routing.isRemote(executionWorkspaceId)) {
        const response = await routing.bashRemote(executionWorkspaceId, {
          action,
          ...(command !== undefined ? { command } : {}),
          ...(processId !== undefined ? { processId } : {}),
          ...(outputId !== undefined ? { outputId } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(interrupt !== undefined ? { interrupt } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...(columns !== undefined ? { columns } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(workingDirectory !== undefined ? { workingDirectory } : {}),
          ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        }, routing.hostScopeIdFor(extra._meta, extra.sessionId));
        return action === "run"
          ? routing.presentSemantic(response, target, routing.hostScopeIdFor(extra._meta, extra.sessionId))
          : routing.present(response, target);
      }

      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      if (action === "run") {
        if (!command) throw new Error("bash action=run requires command.");
        if (processId !== undefined || outputId !== undefined || input !== undefined || interrupt !== undefined) {
          throw new Error("bash action=run does not accept processId, outputId, input, or interrupt.");
        }
        return routing.presentSemantic(await shellRun({
          workspaceId: executionWorkspaceId,
          command,
          surface: "bash",
          tty,
          columns,
          rows,
          workingDirectory,
          yieldTimeMs,
          timeoutMs,
          maxOutputTokens,
        }, executionContext), target, routing.hostScopeIdFor(extra._meta, extra.sessionId));
      }

      if (action === "output") {
        if (!outputId) throw new Error("bash action=output requires outputId.");
        if (
          command !== undefined || processId !== undefined || input !== undefined || interrupt !== undefined ||
          tty !== undefined || columns !== undefined || rows !== undefined || workingDirectory !== undefined ||
          yieldTimeMs !== undefined || timeoutMs !== undefined || maxOutputTokens !== undefined
        ) {
          throw new Error("bash action=output accepts only workspaceId and outputId.");
        }
        return runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.shell,
          invocation: workspaceHookInvocation(workspace),
          payload: { action, outputId },
          operation: async () => durableOutputResponse(
            toolNames.shell,
            executionWorkspaceId,
            readWorkspaceBashOutput(bashOutputStore, executionWorkspaceId, outputId),
          ),
        }).then((result) => routing.present(result, target));
      }

      if (outputId !== undefined) throw new Error("bash action=process does not accept outputId.");
      if (command !== undefined || workingDirectory !== undefined || tty !== undefined || timeoutMs !== undefined) {
        throw new Error("bash action=process does not accept command, workingDirectory, tty, or timeoutMs.");
      }
      if (processId === undefined) throw new Error("bash action=process requires processId.");
      if (interrupt && input !== undefined) {
        throw new Error("bash action=process cannot combine interrupt with input.");
      }

      return runToolWithHooks(hooks, {
        signal: extra.signal,
        tool: toolNames.shell,
        invocation: workspaceHookInvocation(workspace),
        payload: {
          action,
          processId,
          inputLength: input?.length ?? 0,
          interrupt: interrupt ?? false,
          columns,
          rows,
        },
        isFailure: toolResultIsError,
        operation: async () => {
          const startedAt = performance.now();
          const snapshot = await processSessions.write({
            workspaceId: executionWorkspaceId,
            processId,
            chars: interrupt ? "\u0003" : input,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            signal: extra.signal,
          });
          logProcessToolCall(config, workspace, {
            tool: toolNames.shell,
            exitCode: snapshot.exitCode,
            running: snapshot.running,
            processId: snapshot.processId,
            success: snapshot.running || snapshot.exitCode === 0,
            durationMs: Math.round(performance.now() - startedAt),
          });
          const response = processToolResponse(toolNames.shell, executionWorkspaceId, snapshot, {
            action,
            processId,
            inputLength: input?.length ?? 0,
            interrupt: interrupt ?? false,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          });
          if (!snapshot.running) {
            recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId);
          }
          return routing.present(response, target);
        },
      });
    },
  );
}

function registerCodexProcessTools(options: RegisterProcessToolsOptions): void {
  const {
    server,
    config,
    workspaces,
    processSessions,
    hooks,
    activityLifecycle,
    bashOutputStore,
    shellRun,
    routing,
  } = options;

  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        `Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a processId for write_stdin. Use this for file inspection, tests, builds, package scripts, generators, formatters, and long-running processes. ${buildShellMutationPolicy()} Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this process."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z.boolean().optional().describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z.string().optional().describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z.number().int().min(0).max(300_000).optional().describe("Feedback window before returning a processId. Use 0 for immediate background handoff. Defaults to 10000ms."),
        timeoutMs: z.number().int().min(1).max(86_400_000).optional().describe("Total execution timeout from process start. On expiry ForgeRelay terminates the process. Omit for no ForgeRelay execution deadline."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      _meta: {},
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, timeoutMs, maxOutputTokens }, extra) => {
      const target = routing.resolve(workspaceId, member);
      const context = await routing.prepare(target, extra._meta, extra.signal, extra.sessionId);
      if (routing.isRemote(target.executionWorkspaceId)) {
        return routing.presentSemantic(await routing.execCommandRemote(
          target.executionWorkspaceId,
          {
            cmd,
            ...(tty !== undefined ? { tty } : {}),
            ...(columns !== undefined ? { columns } : {}),
            ...(rows !== undefined ? { rows } : {}),
            ...(workingDirectory !== undefined ? { workingDirectory } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          },
          routing.hostScopeIdFor(extra._meta, extra.sessionId),
        ), target, routing.hostScopeIdFor(extra._meta, extra.sessionId));
      }
      return routing.presentSemantic(await shellRun({
        workspaceId: target.executionWorkspaceId,
        command: cmd,
        surface: "exec_command",
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        timeoutMs,
        maxOutputTokens,
      }, context), target, routing.hostScopeIdFor(extra._meta, extra.sessionId));
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a running process returned by exec_command, or retrieve complete durable process output by outputId. Omit chars or pass an empty string to poll. Waiting never kills the process; pass \\u0003 to explicitly send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns the process."),
        processId: z.number().int().positive().optional().describe("Canonical process identifier returned by bash or exec_command."),
        sessionId: z.number().int().positive().optional().describe("Deprecated alias for processId. Retained for compatibility."),
        outputId: z.string().optional().describe("Stable output identifier returned by exec_command. When supplied, retrieve the complete durable output instead of controlling a process."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z.number().int().min(0).max(300_000).optional().describe("Milliseconds to keep waiting before returning again, max 300000. Polling defaults to 60000; interaction defaults to 250."),
        maxOutputTokens: z.number().int().positive().max(100_000).optional().describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      _meta: {},
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, processId, sessionId, outputId, chars, columns, rows, yieldTimeMs, maxOutputTokens }, extra) => {
      const target = routing.resolve(workspaceId, member);
      await routing.prepare(target, extra._meta, extra.signal, extra.sessionId);
      if (routing.isRemote(target.executionWorkspaceId)) {
        return routing.present(await routing.writeStdinRemote(
          target.executionWorkspaceId,
          {
            ...(processId !== undefined ? { processId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(outputId !== undefined ? { outputId } : {}),
            ...(chars !== undefined ? { chars } : {}),
            ...(columns !== undefined ? { columns } : {}),
            ...(rows !== undefined ? { rows } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          },
          routing.hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }

      const executionWorkspaceId = target.executionWorkspaceId;
      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      if (outputId !== undefined) {
        if (
          processId !== undefined || sessionId !== undefined || chars !== undefined || columns !== undefined ||
          rows !== undefined || yieldTimeMs !== undefined || maxOutputTokens !== undefined
        ) {
          throw new Error("write_stdin outputId lookup cannot be combined with process control fields.");
        }
        return runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: "write_stdin",
          invocation: workspaceHookInvocation(workspace),
          payload: { outputId },
          operation: async () => durableOutputResponse(
            "write_stdin",
            executionWorkspaceId,
            readWorkspaceBashOutput(bashOutputStore, executionWorkspaceId, outputId),
          ),
        }).then((result) => routing.present(result, target));
      }

      const resolvedProcessId = resolveProcessId(processId, sessionId);
      return runToolWithHooks(hooks, {
        signal: extra.signal,
        tool: "write_stdin",
        invocation: workspaceHookInvocation(workspace),
        payload: {
          processId: resolvedProcessId,
          charactersWritten: chars?.length ?? 0,
          columns,
          rows,
        },
        operation: async () => {
          const startedAt = performance.now();
          const snapshot = await processSessions.write({
            workspaceId: executionWorkspaceId,
            processId: resolvedProcessId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            signal: extra.signal,
          });
          logProcessToolCall(config, workspace, {
            tool: "write_stdin",
            exitCode: snapshot.exitCode,
            running: snapshot.running,
            processId: snapshot.processId,
            success: snapshot.running || snapshot.exitCode === 0,
            durationMs: Math.round(performance.now() - startedAt),
          });
          const response = processToolResponse("write_stdin", executionWorkspaceId, snapshot, {
            processId: resolvedProcessId,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          });
          if (!snapshot.running) {
            recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId);
          }
          return response;
        },
      }).then((result) => routing.present(result, target));
    },
  );
}

function processOutputSchema(): z.ZodRawShape {
  return {
    result: z.string().describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
    processId: z.number().int().positive().optional().describe("Canonical process handle for bash(action=\"process\") or the active command adapter."),
    sessionId: z.number().int().positive().optional().describe("Deprecated alias of processId for compatibility."),
    outputId: z.string().optional().describe("Stable local audit identifier for retrieving the complete original process output."),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  };
}

function workspaceHookInvocation(workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    workspaceMode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
  };
}

interface ProcessLogFields {
  tool: string;
  command?: string;
  exitCode?: number;
  running?: boolean;
  processId?: number;
  success: boolean;
  durationMs: number;
}

function logProcessToolCall(
  config: ServerConfig,
  workspace: Workspace,
  fields: ProcessLogFields,
): void {
  if (!config.logging.toolCalls) return;
  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    workspaceId: workspace.id,
    workspace: workspaceLogLabel(workspace.root, workspace.id),
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}
