import { resolve } from "node:path";
import type { ActivityWorkspaceSnapshot } from "../../activity/audit-store.js";
import {
  ActivityLifecycle,
  type ActivityExecutionContext,
  type ActivityOutcome,
} from "../../activity/lifecycle.js";
import { openAiConversationScopeId } from "../../request-meta.js";
import type { Workspace, WorkspaceRegistry } from "../../workspaces.js";
import type {
  CapabilityRunOperationInput,
  CoreOperationContext,
  DeleteOperationInput,
  EditOperationInput,
  ReadOperationInput,
  RenameOperationInput,
  ShellRunOperationInput,
  WriteOperationInput,
} from "../core-operation-executor.js";
import { BatchScheduler, type BatchResourceClaim, type BatchScheduledTask } from "./scheduler.js";
import type {
  BatchChildResult,
  BatchCoreTask,
  BatchExecuteInput,
  BatchExecuteValue,
} from "./types.js";

interface BatchCoreOperations {
  read(input: ReadOperationInput, context: CoreOperationContext): Promise<unknown>;
  write(input: WriteOperationInput, context: CoreOperationContext): Promise<unknown>;
  edit(input: EditOperationInput, context: CoreOperationContext): Promise<unknown>;
  rename(input: RenameOperationInput, context: CoreOperationContext): Promise<unknown>;
  delete(input: DeleteOperationInput, context: CoreOperationContext): Promise<unknown>;
  shellRun(input: ShellRunOperationInput, context: CoreOperationContext): Promise<unknown>;
  capabilityRun(input: CapabilityRunOperationInput, context: CoreOperationContext): Promise<unknown>;
}

export interface BatchExecutorDependencies {
  lifecycle: ActivityLifecycle;
  workspaces: WorkspaceRegistry;
  coreOperations: BatchCoreOperations;
  resultIsError: (result: unknown) => boolean;
  scheduler?: BatchScheduler;
  shellSurface?: "bash" | "exec_command";
}

interface TaskExecutionValue {
  response: unknown;
  failed: boolean;
}

interface ParentSummary {
  childCount: number;
  completed: number;
  failed: number;
}

export class BatchExecutor {
  private readonly scheduler: BatchScheduler;
  private readonly shellSurface: "bash" | "exec_command";

  constructor(private readonly dependencies: BatchExecutorDependencies) {
    this.scheduler = dependencies.scheduler ?? new BatchScheduler();
    this.shellSurface = dependencies.shellSurface ?? "bash";
  }

  async run(
    workspaceId: string,
    input: BatchExecuteInput,
    context: CoreOperationContext,
  ): Promise<BatchExecuteValue> {
    const workspace = this.dependencies.workspaces.getWorkspace(workspaceId);
    let response: BatchExecuteValue | undefined;
    await this.dependencies.lifecycle.run({
      tool: "batch",
      workspace: workspaceSnapshot(workspace),
      conversationScopeId: openAiConversationScopeId(context.requestMeta),
      request: {
        workspaceId,
        concurrency: input.concurrency ?? Math.min(input.tasks.length, 10),
        tasks: input.tasks.map((task) => ({ id: task.id, operation: task.operation })),
      },
      operation: async (parentContext) => {
        const scheduled = input.tasks.map((task) => this.scheduledTask(
          workspace,
          task,
          context,
          parentContext,
        ));
        const results = await this.scheduler.run(scheduled, {
          concurrency: input.concurrency,
          signal: context.signal,
        });
        const children: BatchChildResult[] = results.map((result, index) => {
          const task = input.tasks[index]!;
          if (result.status === "error") {
            return {
              id: task.id,
              operation: task.operation,
              status: "error",
              error: result.error,
            };
          }
          const childResult = sanitizeChildResult(result.value.response);
          return {
            id: task.id,
            operation: task.operation,
            status: result.value.failed ? "error" : "done",
            result: childResult,
            ...(result.value.failed
              ? { error: childFailureMessage(result.value.response) }
              : {}),
          };
        });
        const failed = children.filter((child) => child.status === "error").length;
        response = {
          status: failed > 0 ? "partial" : "done",
          tasks: children.length,
          completed: children.length - failed,
          failed,
          results: children,
        };
        return {
          childCount: children.length,
          completed: children.length - failed,
          failed,
        };
      },
      outcome: batchParentOutcome,
    });
    if (!response) throw new Error("Batch execution completed without a response.");
    return response;
  }

  private scheduledTask(
    workspace: Workspace,
    task: BatchCoreTask,
    context: CoreOperationContext,
    parent: ActivityExecutionContext,
  ): BatchScheduledTask<TaskExecutionValue> {
    return {
      id: task.id,
      claims: taskClaims(workspace.root, task),
      ...(task.operation === "bash.run" ? { exclusive: true } : {}),
      run: async (signal) => {
        const response = await this.runCoreTask(
          workspace.id,
          task,
          {
            ...context,
            signal,
            parentActivityId: parent.activityId,
            turnId: parent.turnId,
          },
        );
        return {
          response,
          failed: this.dependencies.resultIsError(response),
        };
      },
    };
  }

  private runCoreTask(
    workspaceId: string,
    task: BatchCoreTask,
    context: CoreOperationContext,
  ): Promise<unknown> {
    switch (task.operation) {
      case "read":
        return this.dependencies.coreOperations.read({
          workspaceId,
          path: task.path,
          offset: task.offset,
          limit: task.limit,
        }, context);
      case "write":
        return this.dependencies.coreOperations.write({
          workspaceId,
          path: task.path,
          content: task.content,
        }, context);
      case "edit":
        return this.dependencies.coreOperations.edit({
          workspaceId,
          path: task.path,
          edits: task.edits,
        }, context);
      case "rename":
        return this.dependencies.coreOperations.rename({
          workspaceId,
          path: task.path,
          newPath: task.newPath,
        }, context);
      case "delete":
        return this.dependencies.coreOperations.delete({
          workspaceId,
          path: task.path,
          recursive: task.recursive,
        }, context);
      case "bash.run":
        return this.dependencies.coreOperations.shellRun({
          workspaceId,
          command: task.command,
          surface: this.shellSurface,
          tty: task.tty,
          columns: task.columns,
          rows: task.rows,
          workingDirectory: task.workingDirectory,
          yieldTimeMs: task.yieldTimeMs,
          timeoutMs: task.timeoutMs,
          maxOutputTokens: task.maxOutputTokens,
        }, context);
    }
  }
}

function batchParentOutcome(summary: ParentSummary): ActivityOutcome {
  return summary.failed > 0
    ? { type: "failed", error: `${summary.failed} of ${summary.childCount} Batch tasks failed.` }
    : { type: "succeeded" };
}

function taskClaims(root: string, task: BatchCoreTask): BatchResourceClaim[] {
  switch (task.operation) {
    case "read":
      return [{ key: batchPathKey(root, task.path), mode: "read" }];
    case "write":
    case "edit":
    case "delete":
      return [{ key: batchPathKey(root, task.path), mode: "write" }];
    case "rename":
      return [
        { key: batchPathKey(root, task.path), mode: "write" },
        { key: batchPathKey(root, task.newPath), mode: "write" },
      ];
    case "bash.run":
      return [];
  }
}

function batchPathKey(root: string, path: string): string {
  const resolved = resolve(root, path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sanitizeChildResult(result: unknown): NonNullable<BatchChildResult["result"]> {
  if (typeof result !== "object" || result === null) {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const record = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const content = Array.isArray(record.content) ? record.content : [];
  const structuredContent = typeof record.structuredContent === "object" &&
      record.structuredContent !== null &&
      !Array.isArray(record.structuredContent)
    ? record.structuredContent as Record<string, unknown>
    : undefined;
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(record.isError === true ? { isError: true as const } : {}),
  };
}

function childFailureMessage(result: unknown): string {
  const sanitized = sanitizeChildResult(result);
  const text = sanitized.content.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = (entry as { text?: unknown }).text;
    return typeof value === "string" ? [value] : [];
  }).join("\n").trim();
  return text || "Batch child returned an error result.";
}

function workspaceSnapshot(workspace: Workspace): ActivityWorkspaceSnapshot {
  return {
    id: workspace.id,
    root: workspace.root,
    mode: workspace.mode,
    ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
    ...(workspace.worktree?.branch ? { branch: workspace.worktree.branch } : {}),
    ...(workspace.worktree?.targetBranch ? { targetBranch: workspace.worktree.targetBranch } : {}),
  };
}
