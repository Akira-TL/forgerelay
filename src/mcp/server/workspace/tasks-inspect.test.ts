import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/audit-store.js";
import { BashOutputStore } from "../../../activity/bash-output-store.js";
import { HostTurnStore } from "../../../activity/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/lifecycle.js";
import { ActivityQueryService } from "../../../activity/query-service.js";
import { buildCapabilityFingerprint } from "../../../capabilities.js";
import { loadConfig } from "../../../config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../db/client.js";
import type { IncomingArtifactAdapter } from "../../../incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../../review-checkpoints.js";
import { ProcessManager } from "../../../process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../../remote-auth.js";
import { createMcpServer, createServer } from "../../../server.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  responseCard,
  responseText,
  structuredContent,
  waitForCompletedProcess,
  waitForToolText,
} from "../../../test-support/server-fixture.js";
import { SqliteWorkspaceStore } from "../../../workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const canonicalToolNames = [
  "open_workspace",
  "activity_panel",
  "activity_snapshot",
  "activity_index",
  "activity_detail",
  "activity_output",
  "workspace_instruction",
  "capability",
  "close_workspace",
  "read",
  "write",
  "edit",
  "rename",
  "delete",
  "bash",
] as const;

test("workspace.tasks persists checkout Task state across close/reopen and removes it only on Workspace delete", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-task-checkout");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name?: string }>;
  assert.equal(catalog.some((entry) => entry.name === "workspace.tasks"), true);
  const taskStatePath = join(context.stateDir, "workspaces", workspaceId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Release" },
    },
  });
  assert.equal(createdList.isError, undefined, allResponseText(createdList));
  const createdSnapshot = structuredContent(createdList).result as Record<string, unknown>;
  const releaseList = (createdSnapshot.lists as Array<Record<string, unknown>>)[0]!;
  const listId = String(releaseList.id);

  const createdTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Publish 0.8.3",
        content: "Run the release gate before pushing the tag.",
        status: "in_progress",
      },
    },
  });
  assert.equal(createdTask.isError, undefined, allResponseText(createdTask));
  const taskOnlyReopen = await callOpen(context.client, context.project, "chat-task-checkout");
  assert.equal(
    structuredContent(taskOnlyReopen).contextFingerprint,
    structuredContent(opened).contextFingerprint,
  );
  assert.equal(structuredContent(taskOnlyReopen).agentsFiles, undefined);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal((await stat(taskStatePath)).isFile(), true);
  const closedRead = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "workspace.tasks", action: "run", arguments: { operation: "get" } },
  });
  assert.equal(closedRead.isError, true);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-task-checkout" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  const restored = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "workspace.tasks", action: "run", arguments: { operation: "get" } },
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  const restoredResult = structuredContent(restored).result as Record<string, unknown>;
  assert.equal(restoredResult.level, "summary");
  const restoredLists = restoredResult.lists as Array<Record<string, unknown>>;
  assert.equal(restoredLists[0]?.id, listId);
  assert.equal(restoredLists[0]?.taskCount, 1);
  assert.equal(restoredLists[0]?.unfinishedTaskCount, 1);
  assert.equal(restoredLists[0]?.tasks, undefined);
  assert.doesNotMatch(JSON.stringify(restoredResult), /Run the release gate/);

  const restoredHeaders = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId },
    },
  });
  assert.equal(restoredHeaders.isError, undefined, allResponseText(restoredHeaders));
  const restoredHeaderLists = (structuredContent(restoredHeaders).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  const restoredTasks = restoredHeaderLists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(restoredTasks[0]?.subject, "Publish 0.8.3");
  assert.equal(restoredTasks[0]?.status, "in_progress");
  assert.equal(restoredTasks[0]?.content, undefined);
  const firstTaskId = String(restoredTasks[0]?.id);

  const restoredDetail = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "detail", listId, taskId: firstTaskId },
    },
  });
  assert.equal(restoredDetail.isError, undefined, allResponseText(restoredDetail));
  assert.equal(
    ((structuredContent(restoredDetail).result as Record<string, unknown>).task as Record<string, unknown>).content,
    "Run the release gate before pushing the tag.",
  );

  const secondTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.create", listId, subject: "Verify package", position: 0 },
    },
  });
  const secondTasks = (((structuredContent(secondTask).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  const secondTaskId = String(secondTasks[0]?.id);
  const completedAndReordered = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.update",
        listId,
        taskId: firstTaskId,
        status: "completed",
        content: "Published and verified.",
        position: 0,
      },
    },
  });
  const updatedTasks = (((structuredContent(completedAndReordered).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  assert.equal(updatedTasks[0]?.id, firstTaskId);
  assert.equal(updatedTasks[0]?.status, "completed");

  const archived = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "archived", name: "Release 0.8.3" },
    },
  });
  assert.equal(
    (((structuredContent(archived).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.state),
    "archived",
  );
  const reactivated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "active" },
    },
  });
  assert.equal(
    (((structuredContent(reactivated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.state),
    "active",
  );
  const removedTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.delete", listId, taskId: secondTaskId },
    },
  });
  const remainingTasks = (((structuredContent(removedTask).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(remainingTasks.map((task) => task.id), [firstTaskId]);
  const scratch = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Scratch", position: 0 },
    },
  });
  const scratchListId = String(
    ((structuredContent(scratch).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const removedList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.delete", listId: scratchListId },
    },
  });
  assert.equal(
    ((structuredContent(removedList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>).length,
    1,
  );

  const activityStatePath = join(context.stateDir, "workspaces", workspaceId, "activity");
  assert.equal((await stat(activityStatePath)).isDirectory(), true);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
  await assert.rejects(stat(activityStatePath), /ENOENT/);
});

test("open_workspace inspect reads bounded ordinary Workspace metadata without opening, binding, or leaking bootstrap context", async (t) => {
  const context = await fixture(t);
  const otherProject = join(dirname(context.project), "inspection-target");
  await mkdir(join(otherProject, ".forgerelay", "agents"), { recursive: true });
  await writeFile(join(otherProject, "AGENTS.md"), "INSPECTION_BOOTSTRAP_SECRET\n");
  await writeFile(join(otherProject, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: inspection-reviewer",
    "description: Inspection-only reviewer.",
    "provider: codex",
    "---",
    "SUBAGENT_BODY_SECRET",
  ].join("\n"));

  const targetOpen = await callOpen(context.client, otherProject, "inspection-target-chat");
  const targetWorkspaceId = String(structuredContent(targetOpen).workspaceId);
  assert.equal(JSON.stringify(targetOpen).includes("INSPECTION_BOOTSTRAP_SECRET"), true);
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: targetWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Inspection coordination" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: targetWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Safe header",
        content: "TASK_BODY_SECRET",
        status: "in_progress",
      },
    },
  });

  const callerOpen = await callOpen(context.client, context.project, "inspection-caller-chat");
  const callerWorkspaceId = String(structuredContent(callerOpen).workspaceId);
  assert.notEqual(callerWorkspaceId, targetWorkspaceId);
  const beforeSession = context.store.getSession(targetWorkspaceId);
  assert.ok(beforeSession);
  const beforeBindings = structuredClone(context.store.listConversationBindings());
  const targetBinding = beforeBindings.find((binding) =>
    binding.conversationScopeId === "inspection-target-chat" && binding.workspaceSessionId === targetWorkspaceId
  );
  assert.ok(targetBinding);
  const beforeDelivery = context.store.getContextDelivery(
    targetBinding.conversationScopeId,
    targetBinding.targetKey,
  );
  assert.ok(beforeDelivery);

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: targetWorkspaceId },
    _meta: { "openai/session": "inspection-caller-chat" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const inspectedStructured = structuredContent(inspected);
  assert.equal(inspectedStructured.action, "inspect");
  assert.equal(inspectedStructured.workspaceId, targetWorkspaceId);
  const projection = inspectedStructured.inspection as Record<string, unknown>;
  assert.equal(projection.kind, "workspace");
  assert.equal(projection.location, "local");
  assert.equal(projection.root, otherProject);
  assert.equal(projection.mode, "checkout");
  assert.equal(projection.rootValid, true);
  const taskSummary = projection.taskSummary as Record<string, unknown>;
  const lists = taskSummary.lists as Array<Record<string, unknown>>;
  assert.equal(lists[0]?.name, "Inspection coordination");
  assert.equal(lists[0]?.taskCount, 1);
  assert.equal(lists[0]?.unfinishedTaskCount, 1);

  const serialized = JSON.stringify(inspected);
  for (const forbidden of [
    "INSPECTION_BOOTSTRAP_SECRET",
    "SUBAGENT_BODY_SECRET",
    "TASK_BODY_SECRET",
    "agentsFiles",
    "availableAgentsFiles",
    "capabilityGuides",
    "skillDiagnostics",
    "agentProviders",
    "contextFingerprint",
    "capabilityFingerprint",
    "fingerprint",
    "memberContext",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `inspect leaked forbidden value/key: ${forbidden}`);
  }
  assert.deepEqual(context.store.getSession(targetWorkspaceId), beforeSession);
  assert.deepEqual(context.store.listConversationBindings(), beforeBindings);
  assert.deepEqual(
    context.store.getContextDelivery(targetBinding.conversationScopeId, targetBinding.targetKey),
    beforeDelivery,
  );
});

test("open_workspace inspect observes a closed managed worktree without recreating its backing", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "inspection-worktree-chat", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const worktreePath = String(worktree.path);
  const targetBranch = String(worktree.targetBranch);

  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Managed inspection" },
    },
  });
  assert.equal(listCreated.isError, undefined, allResponseText(listCreated));
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close inspected worktree" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await assert.rejects(stat(worktreePath), /ENOENT/);
  const beforeSession = context.store.getSession(workspaceId);
  assert.equal(beforeSession?.status, "closed");

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const projection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(projection.workspaceId, workspaceId);
  assert.equal(projection.mode, "worktree");
  assert.equal(projection.managed, true);
  assert.equal(projection.state, "closed");
  assert.equal(projection.rootValid, false);
  assert.equal(projection.targetBranch, targetBranch);
  assert.ok(projection.taskSummary);
  await assert.rejects(stat(worktreePath), /ENOENT/);
  assert.deepEqual(context.store.getSession(workspaceId), beforeSession);
});

test("open_workspace inspect projects Composite members and Tasks without touching Composite lifecycle state", async (t) => {
  const context = await fixture(t);
  const memberOpen = await callOpen(context.client, context.project, "inspection-composite-member-chat");
  const memberWorkspaceId = String(structuredContent(memberOpen).workspaceId);
  const compositeOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "inspection-composite", context: "none" },
  });
  const compositeId = String(structuredContent(compositeOpen).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Primary code", workspaceId: memberWorkspaceId },
    },
  });
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite coordination" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Coordinate",
        content: "COMPOSITE_TASK_BODY_SECRET",
      },
    },
  });
  const beforeList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId },
  });
  const beforeComposite = (structuredContent(beforeList).compositeWorkspaces as Array<Record<string, unknown>>)[0]!;

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: compositeId },
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const projection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(projection.kind, "composite");
  assert.equal(projection.name, "inspection-composite");
  const members = projection.members as Array<Record<string, unknown>>;
  assert.deepEqual(members, [{
    name: "code",
    purpose: "Primary code",
    workspaceId: memberWorkspaceId,
    known: true,
    location: "local",
    state: "active",
    status: "active",
    mode: "checkout",
    rootValid: true,
  }]);
  assert.equal(JSON.stringify(inspected).includes("COMPOSITE_TASK_BODY_SECRET"), false);
  const afterList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId },
  });
  const afterComposite = (structuredContent(afterList).compositeWorkspaces as Array<Record<string, unknown>>)[0]!;
  assert.equal(afterComposite.lastUsedAt, beforeComposite.lastUsedAt);
  assert.deepEqual(afterComposite.members, beforeComposite.members);
});

