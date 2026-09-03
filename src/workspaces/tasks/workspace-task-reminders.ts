import type { WorkspaceTaskStore } from "./workspace-tasks.js";

const TASK_REMINDER =
  "Reminder: this Workspace has unfinished active Tasks. Review workspace.tasks and update Task state when material progress, requirements, blockers, or conclusions changed.";

export class WorkspaceTaskReminderTracker {
  private readonly callsSinceUpdate = new Map<string, number>();

  constructor(
    private readonly interval: number,
    private readonly tasks: Pick<WorkspaceTaskStore, "readSummary">,
  ) {}

  reset(workspaceId: string): void {
    this.callsSinceUpdate.delete(workspaceId);
  }

  forget(workspaceId: string): void {
    this.callsSinceUpdate.delete(workspaceId);
  }

  recordWork(workspaceId: string): string | undefined {
    if (this.interval === 0) return undefined;

    let summary: ReturnType<WorkspaceTaskStore["readSummary"]>;
    try {
      summary = this.tasks.readSummary(workspaceId);
    } catch {
      // Reminder delivery is advisory. Invalid external Task state must still be
      // surfaced by workspace.tasks itself, not turn unrelated work into failure.
      this.callsSinceUpdate.delete(workspaceId);
      return undefined;
    }

    const hasUnfinishedActiveTasks = summary.lists.some(
      (list) => list.state === "active" && list.unfinishedTaskCount > 0,
    );
    if (!hasUnfinishedActiveTasks) {
      this.callsSinceUpdate.delete(workspaceId);
      return undefined;
    }

    const next = (this.callsSinceUpdate.get(workspaceId) ?? 0) + 1;
    if (next < this.interval) {
      this.callsSinceUpdate.set(workspaceId, next);
      return undefined;
    }

    this.callsSinceUpdate.set(workspaceId, 0);
    return TASK_REMINDER;
  }
}
