import { ActivityLifecycle } from "../../../../activity/runtime/lifecycle.js";
import { BashOutputStore } from "../../../../activity/history/bash-output-store.js";
import { CapabilityError, createCapabilityRegistry } from "../../core/capability-registry.js";
import type { CodeIntelligenceManager } from "../../../../lsp/runtime/manager.js";
import type { ServerConfig } from "../../../../runtime/config/config.js";
import { deletePath, renamePath } from "../../../filesystem/file-mutations.js";
import { editFileTool, readFileTool, writeFileTool } from "../../../filesystem/filesystem-tools.js";
import { HookRunner, runToolWithHooks } from "../../../hooks/hooks.js";
import { toolNames } from "../../../server-instructions.js";
import { BatchExecutor } from "../../../operations/batch/executor.js";
import { NativeBulkMutationExecutor } from "../../../operations/native-bulk-mutations.js";
import {
  createCoreOperationExecutor,
  type CapabilityRunOperationInput,
  type CoreOperationContext,
  type DeleteOperationInput,
  type EditOperationInput,
  type ReadOperationInput,
  type RenameOperationInput,
  type ShellRunOperationInput,
  type WriteOperationInput,
} from "../../../operations/core-operation-executor.js";
import { ProcessManager } from "../../../process/process-sessions.js";
import { formatAgentsPath, WorkspaceRegistry } from "../../../../workspaces.js";
import {
  markReturnedOutput,
  processActivityOutcome,
  processToolResponse,
} from "../../../process/runtime.js";
import { capabilityActivityAuditRequest, capabilityActivityAuditResult } from "../../../../subagents/sessions/mcp/audit.js";
import {
  activityRelationFor,
  activityRequestFor,
  runActivityTool,
  runActivityToolWithHooks,
  standardActivityOutcome,
} from "../../core/activity-support.js";
import {
  capabilityContextFor,
  managedWorktreeRecoveryCapabilityContext,
  workspaceHookInvocation,
} from "../../core/capability-support.js";
import {
  assertWorkspaceInstructionsLoadedBeforeSideEffect,
  contentLineCount,
  contentText,
  countDiffStats,
  formatDiscoveredWorkspaceInstructions,
  logFailedToolResponse,
  logToolCall,
  newFilePatch,
  textBlock,
  textSummary,
  toolResultContent,
  toolResultIsError,
  toolResultText,
  workspaceLogContext,
} from "../../core/tool-support.js";
import { appendAutomaticMutationDiagnostics } from "./mutation-diagnostics.js";

export interface CreateOperationRuntimeOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  activityLifecycle: ActivityLifecycle;
  hooks: HookRunner;
  processSessions: ProcessManager;
  bashOutputStore: BashOutputStore;
  capabilityRegistry: ReturnType<typeof createCapabilityRegistry>;
  codeIntelligence: CodeIntelligenceManager;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
}

export function createOperationRuntime(options: CreateOperationRuntimeOptions) {
  const {
    config, workspaces, activityLifecycle, hooks, processSessions, bashOutputStore,
    capabilityRegistry, codeIntelligence, hostScopeIdFor,
  } = options;
  const coreOperations = createCoreOperationExecutor({
    read: async (input: ReadOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...readInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.read,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: readInput.path, offset: readInput.offset, limit: readInput.limit },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const readPath = workspaces.resolveReadPath(workspace, readInput.path);
            const discoveredInstructions = (await workspaces.discoverPathInstructions(
              workspace,
              readPath.absolutePath,
            )).filter((file) => file.path !== readPath.absolutePath);
            const response = await readFileTool(
              { ...readInput, path: readPath.absolutePath },
              {
                cwd: workspace.root,
                root: workspace.root,
                readRoots: readPath.readRoots,
              },
            );

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.read,
                ...workspaceLogContext(workspace, context.sessionId),
                path: readInput.path,
              }, response.content, startedAt);
              return response;
            }
            workspaces.markReadPathLoaded(workspace, readPath);

            const discoveredInstructionContent = discoveredInstructions.length > 0
              ? textBlock(formatDiscoveredWorkspaceInstructions(discoveredInstructions, workspace.root))
              : undefined;
            const content = discoveredInstructionContent
              ? [discoveredInstructionContent, ...response.content]
              : response.content;
            const summary = {
              ...textSummary(response.content),
              offset: readInput.offset ?? 1,
              limited: readInput.limit !== undefined,
            };
            logToolCall(config, {
              tool: toolNames.read,
              ...workspaceLogContext(workspace, context.sessionId),
              path: readInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              content,
              _meta: {
                tool: toolNames.read,
                card: {
                  workspaceId,
                  path: readInput.path,
                  summary,
                  payload: { content: response.content },
                },
              },
              structuredContent: {
                result: contentText(content),
                ...(discoveredInstructions.length > 0
                  ? {
                      agentsFiles: discoveredInstructions.map((file) => ({
                        path: formatAgentsPath(file.path, workspace.root),
                        content: file.content,
                      })),
                    }
                  : {}),
              },
            };
          },
        },
        activityRelationFor(context),
      );
    },
    write: async (input: WriteOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...writeInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.write,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: writeInput.path },
          isFailure: toolResultIsError,
          changedPaths: (result) => toolResultIsError(result) ? [] : [writeInput.path],
          operation: async () => {
            const startedAt = performance.now();
            await assertWorkspaceInstructionsLoadedBeforeSideEffect(
              workspaces,
              workspace,
              [writeInput.path],
            );
            const response = await writeFileTool(writeInput, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.write,
                ...workspaceLogContext(workspace, context.sessionId),
                path: writeInput.path,
              }, response.content, startedAt);
              return response;
            }

            const patch = newFilePatch(writeInput.path, writeInput.content);
            const stats = countDiffStats(patch);
            const summary = {
              ...stats,
              lines: contentLineCount(writeInput.content),
              characters: writeInput.content.length,
            };
            logToolCall(config, {
              tool: toolNames.write,
              ...workspaceLogContext(workspace, context.sessionId),
              path: writeInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return appendAutomaticMutationDiagnostics({
              ...response,
              _meta: {
                tool: toolNames.write,
                card: {
                  workspaceId,
                  path: writeInput.path,
                  summary,
                  payload: {
                    content: response.content,
                    patch,
                  },
                },
              },
              structuredContent: {
                result: contentText(response.content),
              },
            }, codeIntelligence, workspace.root, [writeInput.path], context.signal);
          },
        },
        activityRelationFor(context),
      );
    },
    edit: async (input: EditOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...editInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.edit,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: editInput.path, editCount: editInput.edits.length },
          isFailure: toolResultIsError,
          changedPaths: (result) => toolResultIsError(result) ? [] : [editInput.path],
          operation: async () => {
            const startedAt = performance.now();
            await assertWorkspaceInstructionsLoadedBeforeSideEffect(
              workspaces,
              workspace,
              [editInput.path],
            );
            const response = await editFileTool(editInput, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.edit,
                ...workspaceLogContext(workspace, context.sessionId),
                path: editInput.path,
              }, response.content, startedAt);
              return response;
            }

            const stats = countDiffStats(
              response.details?.patch ?? response.details?.diff,
            );
            const summary = {
              ...stats,
              editCount: editInput.edits.length,
            };
            const editResultText = `Edited ${editInput.path} (+${stats.additions} -${stats.removals}).`;
            const editContent = [textBlock(editResultText)];
            logToolCall(config, {
              tool: toolNames.edit,
              ...workspaceLogContext(workspace, context.sessionId),
              path: editInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return appendAutomaticMutationDiagnostics({
              content: editContent,
              _meta: {
                tool: toolNames.edit,
                card: {
                  workspaceId,
                  path: editInput.path,
                  summary,
                  payload: {
                    diff: response.details?.diff,
                    patch: response.details?.patch,
                  },
                },
              },
              structuredContent: {
                status: "applied" as const,
                result: contentText(editContent),
              },
            }, codeIntelligence, workspace.root, [editInput.path], context.signal);
          },
        },
        activityRelationFor(context),
      );
    },
    rename: async (input: RenameOperationInput, context: CoreOperationContext) => {
      const { workspaceId, path, newPath } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.rename,
          invocation: workspaceHookInvocation(workspace),
          payload: { path, newPath, paths: [path, newPath] },
          changedPaths: () => [path, newPath],
          operation: async () => {
            const startedAt = performance.now();
            try {
              await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                workspaces,
                workspace,
                [path, newPath],
              );
              await renamePath({ path, newPath }, {
                cwd: workspace.root,
                allowedRoots: workspaces.fileToolRoots(workspace),
              });
              const result = `Renamed ${path} to ${newPath}.`;
              const content = [textBlock(result)];
              logToolCall(config, {
                tool: toolNames.rename,
                ...workspaceLogContext(workspace, context.sessionId),
                path: `${path} -> ${newPath}`,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return appendAutomaticMutationDiagnostics({
                content,
                _meta: {
                  tool: toolNames.rename,
                  card: {
                    workspaceId,
                    path: newPath,
                    summary: { previousPath: path },
                    payload: { content },
                  },
                },
                structuredContent: {
                  result,
                  status: "renamed" as const,
                  path,
                  newPath,
                },
              }, codeIntelligence, workspace.root, [newPath], context.signal);
            } catch (error) {
              logToolCall(config, {
                tool: toolNames.rename,
                ...workspaceLogContext(workspace, context.sessionId),
                path: `${path} -> ${newPath}`,
                success: false,
                durationMs: Math.round(performance.now() - startedAt),
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        },
        activityRelationFor(context),
      );
    },
    delete: async (input: DeleteOperationInput, context: CoreOperationContext) => {
      const { workspaceId, path, recursive } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.delete,
          invocation: workspaceHookInvocation(workspace),
          payload: { path, recursive: recursive ?? false },
          changedPaths: () => [path],
          operation: async () => {
            const startedAt = performance.now();
            try {
              await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                workspaces,
                workspace,
                [path],
              );
              const deleted = await deletePath({ path, recursive }, {
                cwd: workspace.root,
                allowedRoots: workspaces.fileToolRoots(workspace),
              });
              const result = `Deleted ${path}${deleted.recursive ? " recursively" : ""}.`;
              const content = [textBlock(result)];
              logToolCall(config, {
                tool: toolNames.delete,
                ...workspaceLogContext(workspace, context.sessionId),
                path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return {
                content,
                _meta: {
                  tool: toolNames.delete,
                  card: {
                    workspaceId,
                    path,
                    summary: { recursive: deleted.recursive },
                    payload: { content },
                  },
                },
                structuredContent: {
                  result,
                  status: "deleted" as const,
                  path,
                  recursive: deleted.recursive,
                },
              };
            } catch (error) {
              logToolCall(config, {
                tool: toolNames.delete,
                ...workspaceLogContext(workspace, context.sessionId),
                path,
                success: false,
                durationMs: Math.round(performance.now() - startedAt),
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        },
        activityRelationFor(context),
      );
    },
    shellRun: async (input: ShellRunOperationInput, context: CoreOperationContext) => {
      const {
        workspaceId,
        command,
        surface,
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        timeoutMs,
        maxOutputTokens,
      } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      const activityRequest = surface === "exec_command"
        ? {
            workspaceId,
            cmd: command,
            tty,
            columns,
            rows,
            workingDirectory,
            yieldTimeMs,
            timeoutMs,
            maxOutputTokens,
          }
        : {
            workspaceId,
            action: "run" as const,
            command,
            tty,
            columns,
            rows,
            workingDirectory,
            yieldTimeMs,
            timeoutMs,
            maxOutputTokens,
          };
      let undeliveredProcessId: number | undefined;
      const activityResult = await runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        surface,
        activityRequestFor(activityRequest, context),
        async (activityContext) => {
          try {
            const result = await runToolWithHooks(hooks, {
              signal: context.signal,
              tool: surface,
              invocation: workspaceHookInvocation(workspace),
              payload: surface === "exec_command"
                ? { command, workingDirectory: workingDirectory ?? "." }
                : { action: "run", command, workingDirectory: workingDirectory ?? "." },
              ...(surface === "bash" ? { isFailure: toolResultIsError } : {}),
              operation: async () => {
                const startedAt = performance.now();
                const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
                await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                  workspaces,
                  workspace,
                  [cwd],
                );
                const snapshot = await processSessions.start({
                  workspaceId,
                  command,
                  cwd,
                  workspaceRoot: workspace.root,
                  tty,
                  columns,
                  rows,
                  yieldTimeMs,
                  timeoutMs,
                  maxOutputTokens,
                  ...(surface === "exec_command" ? { codexCi: true } : {}),
                  signal: context.signal,
                  audit: activityContext,
                });
                undeliveredProcessId = snapshot.running ? snapshot.processId : undefined;

                logToolCall(config, {
                  tool: surface,
                  ...workspaceLogContext(workspace, context.sessionId),
                  workingDirectory: workingDirectory ?? ".",
                  command,
                  commandLength: command.length,
                  exitCode: snapshot.exitCode,
                  running: snapshot.running,
                  processId: snapshot.processId,
                  success: surface === "exec_command"
                    ? snapshot.running || snapshot.exitCode === 0
                    : snapshot.running || (snapshot.exitCode === 0 && !snapshot.signal),
                  durationMs: Math.round(performance.now() - startedAt),
                });

                const response = processToolResponse(surface, workspaceId, snapshot, {
                  ...(surface === "bash" ? { action: "run" } : {}),
                  command,
                  workingDirectory: workingDirectory ?? ".",
                  running: snapshot.running,
                  exitCode: snapshot.exitCode,
                  wallTimeMs: snapshot.wallTimeMs,
                });
                return surface === "bash" && !snapshot.running && (snapshot.signal || snapshot.exitCode !== 0)
                  ? { ...response, isError: true as const }
                  : response;
              },
            });
            context.signal?.throwIfAborted();
            return result;
          } catch (error) {
            if (undeliveredProcessId !== undefined) {
              processSessions.discardUndelivered(workspaceId, undeliveredProcessId);
            }
            throw error;
          }
        },
        processActivityOutcome,
        activityRelationFor(context),
      );
      markReturnedOutput(bashOutputStore, activityResult);
      return activityResult;
    },
    capabilityRun: async (input: CapabilityRunOperationInput, context: CoreOperationContext) => {
      const { workspaceId, name, arguments: capabilityArguments, file } = input;
      if (name === "workspace.recovery") {
        const session = workspaces.getWorkspaceSession(workspaceId);
        if (session.status === "closed") {
          const startedAt = performance.now();
          try {
            const execution = await capabilityRegistry.run(
              name,
              capabilityArguments ?? {},
              managedWorktreeRecoveryCapabilityContext(session, config),
              {
                nativeFile: file,
                signal: context.signal,
                requestMeta: context.requestMeta,
                sessionId: context.sessionId,
                batch: context.batch,
              },
            );
            const result = {
              content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
              structuredContent: { name, action: "run" as const, result: execution.value },
            };
            logToolCall(config, {
              tool: toolNames.capability,
              workspaceId: session.id,
              capability: name,
              action: "run",
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return result;
          } catch (error) {
            const capabilityError = error instanceof CapabilityError
              ? error
              : new CapabilityError(
                  "execution_failed",
                  error instanceof Error ? error.message : String(error),
                );
            const result = {
              content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
              structuredContent: {
                name,
                action: "run" as const,
                error: { code: capabilityError.code, message: capabilityError.message },
              },
              isError: true as const,
            };
            logToolCall(config, {
              tool: toolNames.capability,
              workspaceId: session.id,
              capability: name,
              action: "run",
              success: false,
              durationMs: Math.round(performance.now() - startedAt),
              error: capabilityError.message,
            });
            return result;
          }
        }
      }
      const workspace = workspaces.getWorkspace(workspaceId);
      let changedPaths: string[] = [];
      return runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        toolNames.capability,
        activityRequestFor(capabilityActivityAuditRequest(input), context),
        (activityContext) => runToolWithHooks(hooks, {
          signal: context.signal,
          tool: toolNames.capability,
          invocation: workspaceHookInvocation(workspace),
          payload: { name, action: "run" },
          isFailure: toolResultIsError,
          changedPaths: () => changedPaths,
          afterCwd: () => workspaces.getWorkspaceSession(workspaceId).root,
          operation: async () => {
            const startedAt = performance.now();
            try {
              const execution = await capabilityRegistry.run(
                name,
                capabilityArguments ?? {},
                capabilityContextFor(workspace),
                {
                  nativeFile: file,
                  signal: context.signal,
                  requestMeta: context.requestMeta,
                  sessionId: context.sessionId,
                  batch: context.batch,
                  activityId: activityContext.activityId,
                },
              );
              changedPaths = execution.changedPaths ?? [];
              const result = {
                content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
                ...(execution.card
                  ? {
                      _meta: {
                        tool: toolNames.capability,
                        card: {
                          workspaceId,
                          capabilityName: name,
                          summary: execution.card.summary ?? {},
                          files: execution.card.files,
                          payload: execution.card.payload ?? {},
                        },
                      },
                    }
                  : {}),
                structuredContent: { name, action: "run" as const, result: execution.value },
              };
              logToolCall(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace, context.sessionId),
                capability: name,
                action: "run",
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return result;
            } catch (error) {
              const capabilityError = error instanceof CapabilityError
                ? error
                : new CapabilityError(
                    "execution_failed",
                    error instanceof Error ? error.message : String(error),
                  );
              const result = {
                content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
                structuredContent: {
                  name,
                  action: "run" as const,
                  error: { code: capabilityError.code, message: capabilityError.message },
                },
                isError: true as const,
              };
              logFailedToolResponse(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace, context.sessionId),
                capability: name,
                action: "run",
              }, result.content, startedAt);
              return result;
            }
          },
        }),
        standardActivityOutcome,
        activityRelationFor(context),
        (result) => capabilityActivityAuditResult(name, result),
      );
    },
  });

  const batchExecutor = new BatchExecutor({
    lifecycle: activityLifecycle,
    workspaces,
    coreOperations,
    resultIsError: toolResultIsError,
    capabilityBatchPolicy: (name) => capabilityRegistry.batchPolicy(name),
    shellSurface: "bash",
  });

  const nativeBulkMutations = new NativeBulkMutationExecutor({
    lifecycle: activityLifecycle,
    workspaces,
    coreOperations,
    preflightInstructions: (workspace, paths) =>
      assertWorkspaceInstructionsLoadedBeforeSideEffect(workspaces, workspace, paths),
    resultIsError: toolResultIsError,
    resultText: toolResultText,
    resultContent: toolResultContent,
  });

  return { coreOperations, batchExecutor, nativeBulkMutations };
}
