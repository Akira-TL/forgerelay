import { loadCapabilityGuides } from "./capabilities.js";
import { CapabilityError, type CapabilityContext, type WorkspaceTasksCapabilityInput } from "./capability-registry.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { formatPathForPrompt } from "../../../workspaces/resources/skills.js";
import { WorkspaceTaskStore } from "../../../workspaces/tasks/workspace-tasks.js";
import type { Workspace } from "../../../workspaces.js";

export function workspaceHookInvocation(workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    workspaceMode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
  };
}

export function capabilityContextFor(workspace: Workspace): CapabilityContext {
  return {
    workspaceId: workspace.id,
    workspaceKind: "workspace",
    workspaceRoot: workspace.root,
    workspaceMode: workspace.mode,
    workspaceManaged: workspace.worktree?.managed ?? false,
    guides: workspace.capabilityGuides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    })),
  };
}

export function compositeCapabilityContext(
  workspaceId: string,
  guides: ReturnType<typeof loadCapabilityGuides>,
): CapabilityContext {
  return {
    workspaceId,
    workspaceKind: "composite",
    guides: guides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    })),
  };
}

export function requireCapabilityWorkspaceRoot(context: CapabilityContext): string {
  if (!context.workspaceRoot) {
    throw new CapabilityError(
      "capability_unavailable",
      `Capability execution requires a filesystem-backed Workspace; ${context.workspaceId} is ${context.workspaceKind}.`,
    );
  }
  return context.workspaceRoot;
}

export function runWorkspaceTasksCapability(
  store: WorkspaceTaskStore,
  workspaceId: string,
  input: WorkspaceTasksCapabilityInput,
) {
  switch (input.operation) {
    case "get":
      if (input.level === "headers") return store.readHeaders(workspaceId, input.listId);
      if (input.level === "detail") return store.readTaskDetail(workspaceId, input.listId, input.taskId);
      return store.readSummary(workspaceId);
    case "list.create":
      store.createList(workspaceId, { name: input.name, position: input.position });
      return store.readSummary(workspaceId);
    case "list.update":
      store.updateList(workspaceId, input.listId, {
        name: input.name,
        state: input.state,
        position: input.position,
      });
      return store.readSummary(workspaceId);
    case "list.delete":
      store.deleteList(workspaceId, input.listId);
      return store.readSummary(workspaceId);
    case "task.create":
      store.createTask(workspaceId, input.listId, {
        subject: input.subject,
        content: input.content,
        status: input.status,
        position: input.position,
      });
      return store.readHeaders(workspaceId, input.listId);
    case "task.update":
      store.updateTask(workspaceId, input.listId, input.taskId, {
        subject: input.subject,
        content: input.content,
        status: input.status,
        position: input.position,
      });
      return store.readHeaders(workspaceId, input.listId);
    case "task.delete":
      store.deleteTask(workspaceId, input.listId, input.taskId);
      return store.readHeaders(workspaceId, input.listId);
  }
}

export async function reviewWorkspaceChanges(
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  workspace: Pick<Workspace, "id" | "root">,
) {
  return reviewCheckpoints.reviewChanges({
    workspaceId: workspace.id,
    root: workspace.root,
    markReviewed: true,
  });
}

