import type { ActivityWorkspaceSnapshot } from "../activity/audit-store.js";
import {
  ActivityLifecycle,
  type ActivityExecutionContext,
  type ActivityOutcome,
} from "../activity/lifecycle.js";
import { preflightDeletePaths } from "../file-mutations.js";
import { preflightEditFiles } from "../filesystem-tools.js";
import { openAiConversationScopeId } from "../request-meta.js";
import type { Workspace, WorkspaceRegistry } from "../workspaces.js";
import { executeSequentialBulkMutation } from "./bulk-mutation.js";
import type {
  CoreOperationContext,
  DeleteOperationInput,
  EditOperationInput,
} from "./core-operation-executor.js";

export type NativeBulkContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface MutationCoreOperations {
  edit(input: EditOperationInput, context: CoreOperationContext): Promise<unknown>;
  delete(input: DeleteOperationInput, context: CoreOperationContext): Promise<unknown>;
}

interface NativeBulkMutationDependencies {
  lifecycle: ActivityLifecycle;
  workspaces: WorkspaceRegistry;
  coreOperations: MutationCoreOperations;
  preflightInstructions: (workspace: Workspace, paths: string[]) => Promise<void>;
  resultIsError: (result: unknown) => boolean;
  resultText: (result: unknown) => string;
  resultContent: (result: unknown) => NativeBulkContent[];
}

export interface NativeBulkMutationItemResult {
  path: string;
  status: "done" | "error" | "unexecuted";
  result?: string;
}

export interface NativeBulkMutationResponse {
  [key: string]: unknown;
  content: NativeBulkContent[];
  structuredContent: {
    result: string;
    status: "applied" | "deleted" | "partial";
    results: NativeBulkMutationItemResult[];
    completed: number;
    failed: number;
    unexecuted: number;
    files?: number;
    paths?: number;
  };
  isError?: true;
}

interface ParentSummary {
  childCount: number;
  requested: number;
  completed: number;
  failed: number;
  unexecuted: number;
}

export class NativeBulkMutationExecutor {
  constructor(private readonly dependencies: NativeBulkMutationDependencies) {}

  async edit(
    input: { workspaceId: string; paths: string[]; edits: EditOperationInput["edits"] },
    context: CoreOperationContext,
  ): Promise<NativeBulkMutationResponse> {
    const { workspaceId, paths, edits } = input;
    const workspace = this.dependencies.workspaces.getWorkspace(workspaceId);
    let response: NativeBulkMutationResponse | undefined;
    await this.runParent(
      workspace,
      context,
      "edit",
      { workspaceId, paths, edits },
      async (parentContext) => {
        await this.dependencies.preflightInstructions(workspace, paths);
        await preflightEditFiles(
          paths,
          edits,
          {
            cwd: workspace.root,
            root: workspace.root,
            fileRoots: this.dependencies.workspaces.fileToolRoots(workspace),
          },
          context.signal,
        );
        const execution = await executeSequentialBulkMutation({
          paths,
          signal: context.signal,
          run: (path) => this.dependencies.coreOperations.edit(
            { workspaceId, path, edits },
            childContext(context, parentContext),
          ),
          isError: this.dependencies.resultIsError,
          resultText: this.dependencies.resultText,
        });
        response = buildResponse(
          paths.length,
          execution,
          "applied",
          this.dependencies.resultContent,
        );
        return summary(paths.length, execution.completed, execution.failed, execution.unexecuted);
      },
      mutationParentOutcome("Edit"),
    );
    if (!response) throw new Error("Bulk Edit completed without a response.");
    return response;
  }

  async delete(
    input: { workspaceId: string; paths: string[]; recursive?: boolean },
    context: CoreOperationContext,
  ): Promise<NativeBulkMutationResponse> {
    const { workspaceId, paths, recursive } = input;
    const workspace = this.dependencies.workspaces.getWorkspace(workspaceId);
    let response: NativeBulkMutationResponse | undefined;
    await this.runParent(
      workspace,
      context,
      "delete",
      { workspaceId, paths, recursive: recursive ?? false },
      async (parentContext) => {
        await this.dependencies.preflightInstructions(workspace, paths);
        await preflightDeletePaths(
          paths.map((path) => ({ path, recursive })),
          {
            cwd: workspace.root,
            allowedRoots: this.dependencies.workspaces.fileToolRoots(workspace),
          },
        );
        const execution = await executeSequentialBulkMutation({
          paths,
          signal: context.signal,
          run: (path) => this.dependencies.coreOperations.delete(
            { workspaceId, path, recursive },
            childContext(context, parentContext),
          ),
          isError: this.dependencies.resultIsError,
          resultText: this.dependencies.resultText,
        });
        response = buildResponse(
          paths.length,
          execution,
          "deleted",
          this.dependencies.resultContent,
        );
        return summary(paths.length, execution.completed, execution.failed, execution.unexecuted);
      },
      mutationParentOutcome("Delete"),
    );
    if (!response) throw new Error("Bulk Delete completed without a response.");
    return response;
  }

  private runParent<T>(
    workspace: Workspace,
    context: CoreOperationContext,
    tool: "edit" | "delete",
    request: unknown,
    operation: (parentContext: ActivityExecutionContext) => Promise<T>,
    outcome: (result: T) => ActivityOutcome,
  ): Promise<T> {
    return this.dependencies.lifecycle.run({
      tool,
      workspace: workspaceSnapshot(workspace),
      conversationScopeId: openAiConversationScopeId(context.requestMeta),
      request,
      operation,
      outcome,
    });
  }
}

function childContext(
  context: CoreOperationContext,
  parent: ActivityExecutionContext,
): CoreOperationContext {
  return {
    ...context,
    parentActivityId: parent.activityId,
    turnId: parent.turnId,
  };
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

function summary(
  requested: number,
  completed: number,
  failed: number,
  unexecuted: number,
): ParentSummary {
  return {
    childCount: completed + failed,
    requested,
    completed,
    failed,
    unexecuted,
  };
}

function mutationParentOutcome(tool: "Edit" | "Delete") {
  return (result: ParentSummary): ActivityOutcome => result.failed > 0
    ? {
        type: "failed",
        error: `${result.failed} child ${tool} failed; ${result.unexecuted} target(s) were not executed.`,
      }
    : { type: "succeeded" };
}

function buildResponse<T>(
  requested: number,
  execution: {
    items: Array<{
      path: string;
      status: "done" | "error" | "unexecuted";
      result?: string;
      response?: T;
    }>;
    completed: number;
    failed: number;
    unexecuted: number;
  },
  successStatus: "applied" | "deleted",
  resultContent: (result: unknown) => NativeBulkContent[],
): NativeBulkMutationResponse {
  const content = execution.items.flatMap((item): NativeBulkContent[] => [
    { type: "text", text: `--- ${item.path} · ${item.status} ---` },
    ...(item.response
      ? resultContent(item.response)
      : item.result
        ? [{ type: "text" as const, text: item.result }]
        : []),
  ]);
  const result = content
    .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
  return {
    content,
    structuredContent: {
      result,
      status: execution.failed > 0 ? "partial" : successStatus,
      results: execution.items.map(({ path, status, result: itemResult }) => ({
        path,
        status,
        ...(itemResult !== undefined ? { result: itemResult } : {}),
      })),
      ...(successStatus === "applied" ? { files: requested } : { paths: requested }),
      completed: execution.completed,
      failed: execution.failed,
      unexecuted: execution.unexecuted,
    },
    ...(execution.failed > 0 ? { isError: true as const } : {}),
  };
}
