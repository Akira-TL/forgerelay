import type { ActivityWorkspaceSnapshot } from "../../../activity/history/audit-store.js";
import { ActivityLifecycle, type ActivityExecutionContext, type ActivityOutcome } from "../../../activity/runtime/lifecycle.js";
import { HookRunner, runToolWithHooks, type ToolHookOptions } from "../../../hooks.js";
import type { CoreOperationContext } from "../../operations/core-operation-executor.js";
import type { Workspace } from "../../../workspaces.js";
import { toolResultIsError } from "./tool-support.js";

export function workspaceActivitySnapshot(workspace: Workspace): ActivityWorkspaceSnapshot {
  return {
    id: workspace.id,
    root: workspace.root,
    mode: workspace.mode,
    ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
    ...(workspace.worktree?.branch ? { branch: workspace.worktree.branch } : {}),
    ...(workspace.worktree?.targetBranch ? { targetBranch: workspace.worktree.targetBranch } : {}),
  };
}

export function activityFailureMessage(result: unknown): string {
  if (typeof result !== "object" || result === null) return "Tool returned a failed result.";
  const record = result as { content?: unknown; structuredContent?: unknown };
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return "";
        const value = (entry as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof record.structuredContent === "object" && record.structuredContent !== null) {
    const value = (record.structuredContent as { result?: unknown }).result;
    if (typeof value === "string" && value) return value;
  }
  return "Tool returned a failed result.";
}

export function standardActivityOutcome(result: unknown): ActivityOutcome {
  return toolResultIsError(result)
    ? { type: "failed", error: activityFailureMessage(result) }
    : { type: "succeeded" };
}

export interface ActivityRelationContext {
  parentActivityId?: string;
  turnId?: string;
}

export function activityRelationFor(context: CoreOperationContext): ActivityRelationContext {
  return {
    ...(context.parentActivityId ? { parentActivityId: context.parentActivityId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

export function activityRequestFor(input: unknown, context: CoreOperationContext): unknown {
  if (!context.activityMember || !input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    member: context.activityMember,
  };
}

export function runActivityTool<T>(
  lifecycle: ActivityLifecycle,
  workspace: Workspace,
  conversationScopeId: string,
  tool: string,
  request: unknown,
  operation: (context: ActivityExecutionContext) => Promise<T>,
  outcome: (result: T) => ActivityOutcome = standardActivityOutcome,
  relation: ActivityRelationContext = {},
  auditResult?: (result: T) => unknown,
): Promise<T> {
  return lifecycle.run({
    tool,
    workspace: workspaceActivitySnapshot(workspace),
    conversationScopeId,
    request,
    operation,
    outcome,
    ...(auditResult ? { auditResult } : {}),
    ...relation,
  });
}

export function runActivityToolWithHooks<T>(
  lifecycle: ActivityLifecycle,
  hooks: HookRunner,
  workspace: Workspace,
  conversationScopeId: string,
  request: unknown,
  hookOptions: ToolHookOptions<T>,
  relation: ActivityRelationContext = {},
): Promise<T> {
  return runActivityTool(
    lifecycle,
    workspace,
    conversationScopeId,
    hookOptions.tool,
    request,
    () => runToolWithHooks(hooks, hookOptions),
    standardActivityOutcome,
    relation,
  );
}

