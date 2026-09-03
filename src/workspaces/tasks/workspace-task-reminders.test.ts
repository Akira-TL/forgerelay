import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceTaskReminderTracker } from "./workspace-task-reminders.js";
import { WorkspaceTaskStore } from "./workspace-tasks.js";

test("Workspace Task reminder fires every configured semantic-work interval and resets on Task mutation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-task-reminder-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new WorkspaceTaskStore(stateDir);
  const workspaceId = "ws_1234567890";
  const list = store.createList(workspaceId, { name: "Current" });
  const listId = list.lists[0]!.id;
  store.createTask(workspaceId, listId, {
    subject: "Keep Task state current",
    content: "secret body that must never appear in reminders",
    status: "in_progress",
  });
  const tracker = new WorkspaceTaskReminderTracker(2, store);

  assert.equal(tracker.recordWork(workspaceId), undefined);
  const firstReminder = tracker.recordWork(workspaceId);
  assert.match(firstReminder ?? "", /unfinished active Tasks/i);
  assert.doesNotMatch(firstReminder ?? "", /secret body/);
  assert.equal(tracker.recordWork(workspaceId), undefined);
  assert.match(tracker.recordWork(workspaceId) ?? "", /workspace\.tasks/i);

  tracker.reset(workspaceId);
  assert.equal(tracker.recordWork(workspaceId), undefined);
  assert.match(tracker.recordWork(workspaceId) ?? "", /unfinished active Tasks/i);
});

test("Workspace Task reminder ignores archived or completed work and interval zero disables it", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-task-reminder-inactive-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new WorkspaceTaskStore(stateDir);
  const workspaceId = "cws_1234567890";
  const created = store.createList(workspaceId, { name: "Archive" });
  const listId = created.lists[0]!.id;
  const task = store.createTask(workspaceId, listId, { subject: "Old work" });
  const taskId = task.lists[0]!.tasks[0]!.id;
  const tracker = new WorkspaceTaskReminderTracker(1, store);

  store.updateList(workspaceId, listId, { state: "archived" });
  assert.equal(tracker.recordWork(workspaceId), undefined);

  store.updateList(workspaceId, listId, { state: "active" });
  store.updateTask(workspaceId, listId, taskId, { status: "completed" });
  assert.equal(tracker.recordWork(workspaceId), undefined);

  store.updateTask(workspaceId, listId, taskId, { status: "pending" });
  assert.match(tracker.recordWork(workspaceId) ?? "", /unfinished active Tasks/i);

  const disabled = new WorkspaceTaskReminderTracker(0, store);
  for (let call = 0; call < 50; call += 1) {
    assert.equal(disabled.recordWork(workspaceId), undefined);
  }
});

test("Workspace Task reminder is advisory and malformed external Task state never blocks semantic work", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-task-reminder-malformed-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new WorkspaceTaskStore(stateDir);
  const workspaceId = "ws_abcdef1234";
  store.initializeWorkspace(workspaceId);
  await writeFile(join(stateDir, "workspaces", workspaceId, "tasks.json"), "{ invalid json\n");
  const tracker = new WorkspaceTaskReminderTracker(1, store);

  assert.doesNotThrow(() => tracker.recordWork(workspaceId));
  assert.equal(tracker.recordWork(workspaceId), undefined);
});
