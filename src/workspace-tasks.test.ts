import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceTaskStore } from "./workspace-tasks.js";

test("Workspace Task state is file-backed, ordered, revisioned, and restart-safe", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-workspace-tasks-"));
  const projectDir = await mkdtemp(join(tmpdir(), "forgerelay-workspace-tasks-project-"));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  const workspaceId = "ws_1234567890";
  const workspaceStateDir = join(stateDir, "workspaces", workspaceId);
  const statePath = join(workspaceStateDir, "tasks.json");
  const store = new WorkspaceTaskStore(stateDir);

  const initial = store.ensureWorkspace(workspaceId);
  assert.equal(initial.version, 1);
  assert.equal(initial.revision, 0);
  assert.match(initial.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(initial.lists, []);
  assert.equal((await readFile(statePath, "utf8")).includes('"version": 1'), true);
  await assert.rejects(readFile(join(projectDir, "tasks.json"), "utf8"), /ENOENT/);

  const firstList = store.createList(workspaceId, { name: "Release" });
  const releaseId = firstList.lists[0]!.id;
  assert.match(releaseId, /^tl_[a-f0-9]{10}$/);
  assert.equal(firstList.revision, 1);
  assert.equal(firstList.lists[0]!.revision, 1);

  const secondList = store.createList(workspaceId, { name: "Investigation", position: 0 });
  const investigationId = secondList.lists[0]!.id;
  assert.deepEqual(secondList.lists.map((list) => list.name), ["Investigation", "Release"]);
  assert.equal(secondList.revision, 2);

  const firstTask = store.createTask(workspaceId, releaseId, {
    subject: "Publish package",
    content: "Run the release gate before pushing the tag.",
    status: "in_progress",
  });
  const publishTaskId = firstTask.lists.find((list) => list.id === releaseId)!.tasks[0]!.id;
  assert.match(publishTaskId, /^tsk_[a-f0-9]{10}$/);
  assert.equal(firstTask.revision, 3);
  assert.equal(firstTask.lists.find((list) => list.id === releaseId)!.revision, 2);

  const secondTask = store.createTask(workspaceId, releaseId, {
    subject: "Verify npm",
    position: 0,
  });
  const releaseListAfterCreate = secondTask.lists.find((list) => list.id === releaseId)!;
  assert.deepEqual(releaseListAfterCreate.tasks.map((task) => task.subject), ["Verify npm", "Publish package"]);
  assert.equal(releaseListAfterCreate.revision, 3);

  const updatedTask = store.updateTask(workspaceId, releaseId, publishTaskId, {
    status: "completed",
    content: "Published and verified.",
    position: 0,
  });
  const updatedRelease = updatedTask.lists.find((list) => list.id === releaseId)!;
  assert.equal(updatedRelease.tasks[0]!.id, publishTaskId);
  assert.equal(updatedRelease.tasks[0]!.status, "completed");
  assert.equal(updatedRelease.tasks[0]!.content, "Published and verified.");
  assert.equal(updatedRelease.revision, 4);
  assert.equal(updatedTask.revision, 5);

  const archived = store.updateList(workspaceId, investigationId, {
    name: "Investigation notes",
    state: "archived",
    position: 1,
  });
  assert.deepEqual(archived.lists.map((list) => [list.name, list.state]), [
    ["Release", "active"],
    ["Investigation notes", "archived"],
  ]);
  assert.equal(archived.revision, 6);

  const noOp = store.updateList(workspaceId, investigationId, {
    name: "Investigation notes",
    state: "archived",
    position: 1,
  });
  assert.equal(noOp.revision, archived.revision);
  assert.equal(noOp.fingerprint, archived.fingerprint);

  const restored = new WorkspaceTaskStore(stateDir).read(workspaceId);
  assert.deepEqual(restored, noOp);
  assert.deepEqual(await readdir(workspaceStateDir), ["tasks.json"]);
});

test("Workspace Task state reloads valid external changes and refuses malformed state", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-workspace-tasks-external-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const workspaceId = "ws_abcdef1234";
  const statePath = join(stateDir, "workspaces", workspaceId, "tasks.json");
  const store = new WorkspaceTaskStore(stateDir);
  const createdList = store.createList(workspaceId, { name: "Current" });
  const listId = createdList.lists[0]!.id;
  const createdTask = store.createTask(workspaceId, listId, {
    subject: "Original subject",
    content: "Original content",
  });
  const beforeExternal = store.read(workspaceId);

  const external = JSON.parse(await readFile(statePath, "utf8"));
  external.lists[0].tasks[0].subject = "Externally changed subject";
  await writeFile(statePath, `${JSON.stringify(external, null, 2)}\n`);

  const reloaded = store.read(workspaceId);
  assert.equal(reloaded.revision, beforeExternal.revision);
  assert.notEqual(reloaded.fingerprint, beforeExternal.fingerprint);
  assert.equal(reloaded.lists[0]!.tasks[0]!.subject, "Externally changed subject");

  const malformed = "{ definitely not valid json\n";
  await writeFile(statePath, malformed);
  assert.throws(() => store.read(workspaceId), /not valid JSON/i);
  assert.throws(() => store.createList(workspaceId, { name: "Must not overwrite" }), /not valid JSON/i);
  assert.equal(await readFile(statePath, "utf8"), malformed);

  await writeFile(statePath, `${JSON.stringify(external, null, 2)}\n`);
  const recovered = store.updateTask(
    workspaceId,
    listId,
    createdTask.lists[0]!.tasks[0]!.id,
    { status: "completed" },
  );
  assert.equal(recovered.lists[0]!.tasks[0]!.status, "completed");
  assert.equal(recovered.revision, beforeExternal.revision + 1);
});

test("Workspace Task mutations validate identities, bounds, deletion, and private-state cleanup", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-workspace-tasks-validation-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const workspaceId = "cws_1234567890";
  const workspaceStateDir = join(stateDir, "workspaces", workspaceId);
  const statePath = join(workspaceStateDir, "tasks.json");
  const store = new WorkspaceTaskStore(stateDir);

  assert.throws(() => store.read("../escape"), /Workspace ID is not valid/i);
  assert.throws(() => store.createList(workspaceId, { name: "   " }), /must not be empty/i);

  const withList = store.createList(workspaceId, { name: "Composite tasks" });
  const listId = withList.lists[0]!.id;
  assert.throws(
    () => store.createTask(workspaceId, listId, { subject: "Task", position: 2 }),
    /position must be an integer between 0 and 0/i,
  );

  const withTasks = store.createTask(workspaceId, listId, { subject: "First" });
  const firstId = withTasks.lists[0]!.tasks[0]!.id;
  const withSecond = store.createTask(workspaceId, listId, { subject: "Second" });
  const secondId = withSecond.lists[0]!.tasks[1]!.id;
  const reordered = store.updateTask(workspaceId, listId, secondId, { position: 0 });
  assert.deepEqual(reordered.lists[0]!.tasks.map((task) => task.id), [secondId, firstId]);

  const removedTask = store.deleteTask(workspaceId, listId, firstId);
  assert.deepEqual(removedTask.lists[0]!.tasks.map((task) => task.id), [secondId]);
  const reactivated = store.updateList(workspaceId, listId, { state: "archived" });
  assert.equal(reactivated.lists[0]!.state, "archived");
  assert.equal(store.updateList(workspaceId, listId, { state: "active" }).lists[0]!.state, "active");
  assert.deepEqual(store.deleteList(workspaceId, listId).lists, []);

  await mkdir(workspaceStateDir, { recursive: true });
  await writeFile(join(workspaceStateDir, "future-state.json"), "{}\n");
  store.deleteWorkspace(workspaceId);
  await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  assert.equal(await readFile(join(workspaceStateDir, "future-state.json"), "utf8"), "{}\n");
});
