import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { ActivityQueryService } from "../../../../activity/query-service.js";
import { ActivityLifecycle } from "../../../../activity/lifecycle.js";
import { loadCapabilityGuides } from "../../../../capabilities.js";
import { CapabilityError, createCapabilityRegistry } from "../../../../capability-registry.js";
import type { ServerConfig } from "../../../../config.js";
import { CodeIntelligenceManager } from "../../../../lsp/runtime/manager.js";
import { attachHookReports, HookRunner, runToolWithHooks } from "../../../../hooks.js";
import { toolNames } from "../../../server-instructions.js";
import { CoreOperationExecutor, type CoreOperationContext } from "../../../../operations/core-operation-executor.js";
import { ProcessManager } from "../../../../process-sessions.js";
import { createReviewCheckpointManager } from "../../../../review-checkpoints.js";
import { CompositeActivityCoordinator } from "../../../../composite-activity.js";
import { CompositeWorkspaceRegistry } from "../../../../composite-workspaces.js";
import { RemoteWorkspaceRelay } from "../../../../remote-workspace-relay.js";
import { WorkspaceTaskReminderTracker } from "../../../../workspace-task-reminders.js";
import { WorkspaceTaskStore } from "../../../../workspace-tasks.js";
import { formatAgentsPath, WorkspaceRegistry } from "../../../../workspaces.js";
import type { ProcessExecutionTarget } from "../../../process/tools.js";
import {
  activityRelationFor,
  activityRequestFor,
  runActivityToolWithHooks,
} from "../../core/activity-support.js";
import {
  capabilityContextFor,
  compositeCapabilityContext,
  workspaceHookInvocation,
} from "../../core/capability-support.js";
import { capabilityErrorOutputSchema, resultOutputSchema } from "../../core/schemas.js";
import {
  logFailedToolResponse,
  logToolCall,
  textBlock,
  toolResultIsError,
  workspaceLogContext,
} from "../../core/tool-support.js";

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export interface RegisterWorkspaceAuxiliaryToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  remoteWorkspaces: RemoteWorkspaceRelay;
  compositeWorkspaces: CompositeWorkspaceRegistry;
  compositeTaskGuides: ReturnType<typeof loadCapabilityGuides>;
  capabilityRegistry: ReturnType<typeof createCapabilityRegistry>;
  coreOperations: CoreOperationExecutor<any>;
  activityLifecycle: ActivityLifecycle;
  hooks: HookRunner;
  workspaceTasks: WorkspaceTaskStore;
  taskReminders: WorkspaceTaskReminderTracker;
  activityQueries: ActivityQueryService;
  compositeActivity: CompositeActivityCoordinator;
  workspacePanelStates: Map<string, Record<string, unknown>>;
  processSessions: ProcessManager;
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  codeIntelligence: CodeIntelligenceManager;
  resolveExecutionTarget: (workspaceId: string, member?: string) => ProcessExecutionTarget;
  prepareExecutionContext: (target: ProcessExecutionTarget, requestMeta: unknown, signal: AbortSignal | undefined, sessionId: string | undefined) => Promise<CoreOperationContext>;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
  presentExecutionResult: <T>(result: T, target: ProcessExecutionTarget) => T;
  presentSemanticWorkResult: <T>(result: T, target: ProcessExecutionTarget) => T;
}

export function registerWorkspaceAuxiliaryTools(options: RegisterWorkspaceAuxiliaryToolsOptions): void {
  const {
    server, config, workspaces, remoteWorkspaces, compositeWorkspaces, compositeTaskGuides, capabilityRegistry,
    coreOperations, activityLifecycle, hooks, workspaceTasks, taskReminders, activityQueries, compositeActivity,
    workspacePanelStates, processSessions, reviewCheckpoints, codeIntelligence, resolveExecutionTarget,
    prepareExecutionContext, hostScopeIdFor, presentExecutionResult, presentSemanticWorkResult,
  } = options;
  registerAppTool(
    server,
    "workspace_instruction",
    {
      title: "Read Workspace instruction",
      description:
        "App-only lazy data source for one instruction file already advertised by the Workspace presentation. Reading through this UI source does not activate nested instructions or create an Activity.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
      },
      outputSchema: {
        path: z.string(),
        content: z.string(),
        status: z.enum(["loaded", "available"]),
      },
      _meta: { ui: { visibility: ["app"] } },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, path }, extra) => {
      if (remoteWorkspaces.has(workspaceId)) {
        return remoteWorkspaces.workspaceInstruction(
          workspaceId,
          path,
          hostScopeIdFor(extra._meta, extra.sessionId),
        );
      }
      if (compositeWorkspaces.has(workspaceId)) {
        throw new Error(
          "Composite Workspace instructions belong to a selected member; open that member context before viewing its instruction files.",
        );
      }

      const workspace = workspaces.getWorkspace(workspaceId);
      const instruction = await workspaces.readAdvertisedInstruction(workspace, path);
      return {
        content: [],
        structuredContent: {
          path: formatAgentsPath(instruction.path, workspace.root),
          content: instruction.content,
          status: instruction.status,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.capability,
    {
      title: "Use optional capability",
      description:
        "Describe or run one optional ForgeRelay capability advertised by open_workspace. Use describe when the capability contract is unfamiliar, then read its advertised guide if needed. Run dispatches only explicitly registered capabilities; it cannot invoke arbitrary shell commands, URLs, or methods.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name whose capability surface is used."),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
          .describe("Stable dotted capability name advertised by open_workspace."),
        action: z.enum(["describe", "run"]),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Capability-specific JSON arguments. Omit for describe and for capabilities with no arguments."),
        file: z
          .unknown()
          .optional()
          .describe("Host-native file value. Only capabilities whose describe result advertises native-file transport may consume it."),
      },
      outputSchema: {
        name: z.string(),
        action: z.enum(["describe", "run"]),
        member: z.string().optional(),
        capability: z.unknown().optional(),
        result: z.unknown().optional(),
        error: capabilityErrorOutputSchema.optional(),
      },
      _meta: {
        "openai/fileParams": ["file"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, member, name, action, arguments: capabilityArguments, file }, extra) => {
      if (name === "workspace.tasks" && compositeWorkspaces.has(workspaceId)) {
        if (member !== undefined) {
          throw new Error(
            `workspace.tasks belongs to Composite Workspace ${workspaceId} itself and does not accept member.`,
          );
        }
        if (!compositeWorkspaces.isActive(workspaceId)) {
          throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before use.`);
        }
        const startedAt = performance.now();
        const context = compositeCapabilityContext(workspaceId, compositeTaskGuides);
        try {
          if (action === "run") {
            const execution = await capabilityRegistry.run(
              name,
              capabilityArguments ?? {},
              context,
              {
                nativeFile: file,
                signal: extra.signal,
                requestMeta: extra._meta,
                sessionId: extra.sessionId,
              },
            );
            const result = {
              content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
              structuredContent: { name, action, result: execution.value },
            };
            logToolCall(config, {
              tool: toolNames.capability,
              capability: name,
              action,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return result;
          }

          const capability = capabilityRegistry.describe(name, context);
          const result = {
            content: [textBlock([
              `${capability.name}: ${capability.description}`,
              `Available: ${capability.available}`,
              `Guide: ${capability.guide.path}`,
              capability.guide.readBeforeFirstUse
                ? "Read the guide before first use when this contract is unfamiliar."
                : undefined,
            ].filter(Boolean).join("\n"))],
            structuredContent: { name, action, capability },
          };
          logToolCall(config, {
            tool: toolNames.capability,
            capability: name,
            action,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return result;
        } catch (error) {
          if (extra.signal.aborted) throw error;
          const capabilityError = error instanceof CapabilityError
            ? error
            : new CapabilityError(
                "execution_failed",
                error instanceof Error ? error.message : String(error),
              );
          return {
            content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
            structuredContent: {
              name,
              action,
              error: { code: capabilityError.code, message: capabilityError.message },
            },
            isError: true as const,
          };
        }
      }

      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(
        target,
        extra._meta,
        extra.signal,
        extra.sessionId,
      );
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        const response = await remoteWorkspaces.capability(executionWorkspaceId, {
          name,
          action,
          ...(capabilityArguments !== undefined ? { arguments: capabilityArguments } : {}),
          ...(file !== undefined ? { file } : {}),
        }, hostScopeIdFor(extra._meta, extra.sessionId));
        return action === "run" && name !== "workspace.tasks"
          ? presentSemanticWorkResult(response, target)
          : presentExecutionResult(response, target);
      }
      if (action === "run" && name === "batch.execute") {
        const workspace = workspaces.getWorkspace(executionWorkspaceId);
        const startedAt = performance.now();
        try {
          const execution = await capabilityRegistry.run(
            name,
            capabilityArguments ?? {},
            capabilityContextFor(workspace),
            {
              nativeFile: file,
              signal: extra.signal,
              requestMeta: extra._meta,
              sessionId: extra.sessionId,
            },
          );
          const result = {
            content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
            structuredContent: { name, action, result: execution.value },
          };
          logToolCall(config, {
            tool: toolNames.capability,
            ...workspaceLogContext(workspace, extra.sessionId),
            capability: name,
            action,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return presentSemanticWorkResult(result, target);
        } catch (error) {
          if (extra.signal.aborted) throw error;
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
              action,
              error: { code: capabilityError.code, message: capabilityError.message },
            },
            isError: true as const,
          };
          logFailedToolResponse(config, {
            tool: toolNames.capability,
            ...workspaceLogContext(workspace, extra.sessionId),
            capability: name,
            action,
          }, result.content, startedAt);
          return presentExecutionResult(result, target);
        }
      }

      if (action === "run") {
        const response = await coreOperations.capabilityRun(
          { workspaceId: executionWorkspaceId, name, arguments: capabilityArguments, file },
          executionContext,
        );
        return name === "workspace.tasks"
          ? presentExecutionResult(response, target)
          : presentSemanticWorkResult(response, target);
      }

      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(extra._meta, extra.sessionId),
        activityRequestFor(
          { workspaceId: executionWorkspaceId, name, action, arguments: capabilityArguments, file },
          executionContext,
        ),
        {
          signal: extra.signal,
          tool: toolNames.capability,
          invocation: workspaceHookInvocation(workspace),
          payload: { name, action },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            try {
              const capability = capabilityRegistry.describe(name, capabilityContextFor(workspace));
              const result = {
                content: [textBlock([
                  `${capability.name}: ${capability.description}`,
                  `Available: ${capability.available}`,
                  `Guide: ${capability.guide.path}`,
                  capability.guide.readBeforeFirstUse
                    ? "Read the guide before first use when this contract is unfamiliar."
                    : undefined,
                ].filter(Boolean).join("\n"))],
                structuredContent: { name, action, capability },
              };
              logToolCall(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace),
                capability: name,
                action,
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
                  action,
                  error: { code: capabilityError.code, message: capabilityError.message },
                },
                isError: true as const,
              };
              logFailedToolResponse(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace),
                capability: name,
                action,
              }, result.content, startedAt);
              return result;
            }
          },
        },
        activityRelationFor(executionContext),
      ).then((result) => presentExecutionResult(result, target));
    },
  );

  registerAppTool(
    server,
    toolNames.closeWorkspace,
    {
      title: "Close workspace",
      description:
        "Close or explicitly delete one Workspace after the user chooses cleanup. action=close (default) preserves checkout, managed-worktree, Composite, and relayed identity for later reopen. action=delete permanently removes ForgeRelay-owned state. Managed-worktree-backed Workspaces still finalize safely when active and require commitMessage. Composite delete dissolves only Composite-owned state and never closes member Workspaces. Checkout project files are never deleted.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier to close or delete."),
        action: z
          .enum(["close", "delete"])
          .optional()
          .describe("Defaults to close. close preserves checkout identity, managed-worktree identity, and Composite identity for later reopen; delete removes ForgeRelay-owned state. Composite delete dissolves only the Composite relationship. Active managed worktrees still require safe finalization and commitMessage; checkout project files are never deleted."),
        commitMessage: z
          .string()
          .min(1)
          .optional()
          .describe("Required only for a managed-worktree-backed workspace; concise Git commit message for remaining worktree changes."),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        action: z.enum(["close", "delete"]).optional(),
        kind: z.enum(["workspace", "composite"]).optional(),
        mode: z.enum(["checkout", "worktree"]).optional(),
        name: z.string().optional(),
        members: z.array(z.object({
          name: z.string(),
          purpose: z.string(),
          workspaceId: z.string(),
        })).optional(),
        status: z.enum(["active", "closed"]).optional(),
        dissolved: z.boolean().optional(),
        sourceRoot: z.string().optional(),
        branch: z.string().optional(),
        targetBranch: z.string().optional(),
        commitSha: z.string().optional(),
        mergedSha: z.string().optional(),
        committed: z.boolean().optional(),
        cleanupWarning: z.string().optional(),
      }),
      _meta: {},
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, action = "close", commitMessage }, extra) => {
      if (compositeWorkspaces.has(workspaceId)) {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not valid for a Composite Workspace.");
        }
        const composite = action === "delete"
          ? compositeWorkspaces.dissolve(workspaceId)
          : compositeWorkspaces.close(workspaceId);
        if (action === "delete") {
          workspaceTasks.deleteWorkspace(workspaceId);
          taskReminders.forget(workspaceId);
          activityQueries.deleteWorkspaceHistory(config.stateDir, workspaceId);
        }
        compositeActivity.forgetComposite(workspaceId);
        workspacePanelStates.delete(workspaceId);
        const result = [
          action === "delete"
            ? `Deleted Composite Workspace ${composite.name} (${workspaceId}); its Composite relationship and ForgeRelay-owned Composite state were dissolved.`
            : `Closed Composite Workspace ${composite.name} (${workspaceId}); its identity and member topology were preserved for later reopen.`,
          composite.members.length > 0
            ? `Preserved member Workspaces: ${composite.members.map((member) => `${member.name} [${member.workspaceId}]`).join(", ")}.`
            : "The Composite Workspace had no members.",
          "Member Workspace handles, managed worktrees, processes, files, and Workspace Relay routes were not closed, finalized, deleted, or otherwise mutated.",
        ].join("\n");
        return {
          content: [textBlock(result)],
          _meta: {
            tool: toolNames.closeWorkspace,
            card: {
              workspaceId,
              action,
              kind: "composite" as const,
              name: composite.name,
              members: composite.members,
              ...(action === "close" ? { status: "closed" as const } : {}),
              dissolved: action === "delete",
              payload: { content: [textBlock(result)] },
            },
          },
          structuredContent: {
            result,
            workspaceId,
            action,
            kind: "composite" as const,
            name: composite.name,
            members: composite.members,
            ...(action === "close" ? { status: "closed" as const } : {}),
            dissolved: action === "delete",
          },
        };
      }
      if (remoteWorkspaces.has(workspaceId)) {
        const response = await remoteWorkspaces.closeWorkspace(
          workspaceId,
          { action, ...(commitMessage !== undefined ? { commitMessage } : {}) },
          hostScopeIdFor(extra._meta, extra.sessionId),
        );
        if (action === "delete") {
          activityQueries.deleteWorkspaceHistory(config.stateDir, workspaceId);
        }
        workspacePanelStates.delete(workspaceId);
        return response;
      }
      const session = workspaces.getWorkspaceSession(workspaceId);
      if (action === "delete" && session.mode === "checkout") {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not valid with action=delete for a checkout Workspace.");
        }
        if (processSessions.activeWorkspaceIds().has(session.id)) {
          throw new Error(
            `Workspace ${session.id} still owns a running process. Poll, interrupt, or wait for it before deleting this Workspace.`,
          );
        }
        const response = await runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.closeWorkspace,
          invocation: {
            workspaceId: session.id,
            workspaceRoot: session.root,
            workspaceMode: session.mode,
            sourceRoot: session.sourceRoot,
          },
          payload: { workspaceId: session.id, action: "delete", mode: session.mode },
          operation: async () => {
            workspaces.deleteWorkspace(session.id);
            workspaceTasks.deleteWorkspace(session.id);
            taskReminders.forget(session.id);
            activityQueries.deleteWorkspaceHistory(config.stateDir, session.id);
            await reviewCheckpoints.releaseWorkspace(session.id);
            const result = `Deleted ForgeRelay Workspace ${session.id}. Physical project files were not removed.`;
            return {
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: session.id,
                  action: "delete" as const,
                  mode: "checkout",
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: session.id,
                action: "delete" as const,
                mode: "checkout" as const,
              },
            };
          },
        });
        workspacePanelStates.delete(session.id);
        return response;
      }
      if (action === "delete" && session.mode === "worktree" && session.status === "closed") {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not needed when deleting an already-closed managed-worktree Workspace.");
        }
        const hookRoot = session.sourceRoot ?? session.root;
        const response = await runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.closeWorkspace,
          invocation: {
            workspaceId: session.id,
            workspaceRoot: hookRoot,
            workspaceMode: session.mode,
            sourceRoot: session.sourceRoot,
          },
          payload: { workspaceId: session.id, action: "delete", mode: session.mode },
          operation: async () => {
            workspaces.deleteWorkspace(session.id);
            workspaceTasks.deleteWorkspace(session.id);
            taskReminders.forget(session.id);
            activityQueries.deleteWorkspaceHistory(config.stateDir, session.id);
            await reviewCheckpoints.releaseWorkspace(session.id);
            const result = `Deleted closed managed-worktree Workspace ${session.id}. Its already-removed worktree backing was not recreated.`;
            return {
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: session.id,
                  action: "delete" as const,
                  mode: "worktree",
                  sourceRoot: session.sourceRoot,
                  targetBranch: session.targetBranch,
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: session.id,
                action: "delete" as const,
                mode: "worktree" as const,
                sourceRoot: session.sourceRoot,
                targetBranch: session.targetBranch,
              },
            };
          },
        });
        workspacePanelStates.delete(session.id);
        return response;
      }
      const workspace = workspaces.getWorkspace(session.id);
      const response = await runToolWithHooks(hooks, {
        signal: extra.signal,
        tool: toolNames.closeWorkspace,
        invocation: workspaceHookInvocation(workspace),
        payload: { workspaceId: workspace.id, action, commitMessage, mode: workspace.mode },
        afterCwd: (response) =>
          "sourceRoot" in response.structuredContent &&
          typeof response.structuredContent.sourceRoot === "string"
            ? response.structuredContent.sourceRoot
            : undefined,
        operation: async () => {
          if (workspace.mode === "worktree") {
            if (!commitMessage) {
              throw new Error(
                `Managed-worktree-backed Workspace ${workspace.id} requires commitMessage when ${action === "delete" ? "deleting active work" : "closing"}.`,
              );
            }
            const physicalWorkspaceIds = workspaces.workspaceIdsForPhysicalWorkspace(workspace);
            const busyWorkspaceIds = physicalWorkspaceIds
              .filter((id) => processSessions.activeWorkspaceIds().has(id));
            if (busyWorkspaceIds.length > 0) {
              throw new Error(
                `Cannot close this worktree-backed Workspace while Workspace processes are still running: ${busyWorkspaceIds.join(", ")}.`,
              );
            }
            const startedAt = performance.now();
            const retirement = await codeIntelligence.retireWorkspaceRoot(workspace.root);
            let closed: Awaited<ReturnType<WorkspaceRegistry["closeWorktree"]>>;
            try {
              closed = await workspaces.closeWorktree(workspace.id, commitMessage);
            } finally {
              codeIntelligence.restoreWorkspaceRoot(retirement.root);
            }
            await Promise.all(
              physicalWorkspaceIds.map((id) => reviewCheckpoints.releaseWorkspace(id)),
            );
            if (action === "delete") {
              workspaces.deleteWorkspace(workspace.id);
              workspaceTasks.deleteWorkspace(workspace.id);
              taskReminders.forget(workspace.id);
              activityQueries.deleteWorkspaceHistory(config.stateDir, workspace.id);
            }
            const result = [
              action === "delete"
                ? `Safely finalized and deleted managed-worktree Workspace ${workspace.id}.`
                : `Closed managed-worktree-backed Workspace ${workspace.id}; its identity was preserved for later reopen.`,
              `Merged ${closed.branch} into ${closed.targetBranch} by fast-forward.`,
              `Source checkout: ${closed.sourceRoot}`,
              `Commit: ${closed.commitSha}`,
              closed.cleanupWarning
                ? `Cleanup warning: ${closed.cleanupWarning}`
                : "The managed worktree directory and branch were removed.",
            ].join("\n");
            logToolCall(config, {
              tool: toolNames.closeWorkspace,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: closed.sourceRoot,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return attachHookReports({
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: workspace.id,
                  action,
                  mode: "worktree",
                  sourceRoot: closed.sourceRoot,
                  branch: closed.branch,
                  targetBranch: closed.targetBranch,
                  commitSha: closed.commitSha,
                  mergedSha: closed.mergedSha,
                  committed: closed.committed,
                  cleanupWarning: closed.cleanupWarning,
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: workspace.id,
                action,
                mode: "worktree" as const,
                sourceRoot: closed.sourceRoot,
                branch: closed.branch,
                targetBranch: closed.targetBranch,
                commitSha: closed.commitSha,
                mergedSha: closed.mergedSha,
                committed: closed.committed,
                cleanupWarning: closed.cleanupWarning,
              },
            }, closed.hookReports);
          }

          if (commitMessage !== undefined) {
            throw new Error("close_workspace commitMessage is only valid for managed-worktree-backed workspaces.");
          }
          const checkoutWorkspaceId = workspace.id;
          if (processSessions.activeWorkspaceIds().has(checkoutWorkspaceId)) {
            throw new Error(
              `Workspace ${checkoutWorkspaceId} still owns a running process. Poll, interrupt, or wait for it before closing this workspace.`,
            );
          }
          workspaces.closeWorkspace(checkoutWorkspaceId);
          await reviewCheckpoints.releaseWorkspace(checkoutWorkspaceId);
          const result = `Closed checkout-backed Workspace ${checkoutWorkspaceId}; its ForgeRelay identity was preserved for later reopen. Physical project files were not removed.`;
          return {
            content: [textBlock(result)],
            _meta: {
              tool: toolNames.closeWorkspace,
              card: {
                workspaceId: checkoutWorkspaceId,
                action: "close" as const,
                mode: "checkout",
                payload: { content: [textBlock(result)] },
              },
            },
            structuredContent: {
              result,
              workspaceId: checkoutWorkspaceId,
              action: "close" as const,
              mode: "checkout" as const,
            },
          };
        },
      });
      workspacePanelStates.delete(workspace.id);
      return response;
    },
  );

}
