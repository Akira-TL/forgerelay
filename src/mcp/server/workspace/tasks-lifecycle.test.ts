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
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import { buildCapabilityFingerprint } from "../core/capabilities.js";
import { loadConfig } from "../../../runtime/config/config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../runtime/state/db/client.js";
import type { IncomingArtifactAdapter } from "../../artifacts/incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { ProcessManager } from "../../process/process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../../workspaces/relay/auth/remote-auth.js";
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
} from "../../../runtime/testing/server-fixture.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
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

test("workspace.tasks reminder counts semantic work, excludes lifecycle/process follow-ups, and resets on Task mutation", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_TASK_REMINDER_INTERVAL: "2" },
  });
  await writeFile(join(context.project, "reminder.txt"), "semantic work\n");
  const opened = await callOpen(context.client, context.project, "chat-task-reminder");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Current" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const taskCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Keep current",
        content: "secret reminder body",
      },
    },
  });
  const taskId = String(
    ((((structuredContent(taskCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>)[0]?.id,
  );

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.doesNotMatch(allResponseText(inventory), /unfinished active Tasks/i);
  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-task-reminder" },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(allResponseText(panel), /unfinished active Tasks/i);
  const taskSummary = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.doesNotMatch(allResponseText(taskSummary), /unfinished active Tasks/i);

  const firstRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(firstRead), /unfinished active Tasks/i);
  const secondRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(secondRead), /unfinished active Tasks/i);
  assert.doesNotMatch(allResponseText(secondRead), /secret reminder body/);

  const oneMoreRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(oneMoreRead), /unfinished active Tasks/i);
  const reset = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.update", listId, taskId, subject: "Still current" },
    },
  });
  assert.doesNotMatch(allResponseText(reset), /unfinished active Tasks/i);
  const batchWork = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "batch.execute",
      action: "run",
      arguments: {
        tasks: [
          { id: "read-a", operation: "read", path: "reminder.txt", limit: 1 },
          { id: "read-b", operation: "read", path: "reminder.txt", limit: 1 },
        ],
      },
    },
  });
  assert.doesNotMatch(allResponseText(batchWork), /unfinished active Tasks/i);
  const afterBatch = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(afterBatch), /unfinished active Tasks/i);

  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.update", listId, taskId, subject: "Current after batch" },
    },
  });
  const afterResetFirst = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(afterResetFirst), /unfinished active Tasks/i);

  const background = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('task-reminder-process'), 100)"`,
      yieldTimeMs: 0,
    },
  });
  assert.match(allResponseText(background), /unfinished active Tasks/i);
  const processId = Number(structuredContent(background).processId);
  const processFollowUp = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  assert.doesNotMatch(allResponseText(processFollowUp), /unfinished active Tasks/i);
  const outputId = String(structuredContent(processFollowUp).outputId);
  const outputFollowUp = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "output", outputId },
  });
  assert.doesNotMatch(allResponseText(outputFollowUp), /unfinished active Tasks/i);

  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "archived" },
    },
  });
  for (let call = 0; call < 3; call += 1) {
    const read = await context.client.callTool({
      name: "read",
      arguments: { workspaceId, path: "reminder.txt", limit: 1 },
    });
    assert.doesNotMatch(allResponseText(read), /unfinished active Tasks/i);
  }
});

test("workspace.tasks reminder follows the Composite identity during explicit member work", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_TASK_REMINDER_INTERVAL: "1" },
  });
  await writeFile(join(context.project, "reminder.txt"), "composite semantic work\n");
  const memberOpen = await callOpen(context.client, context.project, "chat-composite-task-reminder-member");
  const memberWorkspaceId = String(structuredContent(memberOpen).workspaceId);
  const compositeOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "task-reminder-composite", context: "none" },
  });
  const compositeId = String(structuredContent(compositeOpen).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Semantic work", workspaceId: memberWorkspaceId },
    },
  });
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite current" },
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
        subject: "Keep Composite Task current",
        content: "composite secret body",
      },
    },
  });

  const memberRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(memberRead), /unfinished active Tasks/i);
  assert.doesNotMatch(allResponseText(memberRead), /composite secret body/);
});

test("workspace.tasks belongs to Composite Workspace itself and survives Composite close/reopen", async (t) => {
  const context = await fixture(t);
  const opened = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "task-composite", context: "none" },
  });
  const compositeId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name?: string }>;
  assert.deepEqual(catalog.map((entry) => entry.name), ["workspace.tasks"]);
  const guides = structuredContent(opened).capabilityGuides as Array<Record<string, unknown>>;
  const taskGuide = guides.find((guide) => guide.name === "workspace-tasks");
  assert.ok(taskGuide);
  const guideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: taskGuide.path },
  });
  assert.equal(guideRead.isError, undefined, allResponseText(guideRead));
  assert.match(allResponseText(guideRead), /workspace\.tasks/);
  const taskStatePath = join(context.stateDir, "workspaces", compositeId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const created = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite work" },
    },
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const createdLists = (structuredContent(created).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(createdLists[0]?.name, "Composite work");

  const memberScoped = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "anything",
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.equal(memberScoped.isError, true);
  assert.match(allResponseText(memberScoped), /Composite Workspace itself|does not accept member/i);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const closedGuideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: taskGuide.path },
  });
  assert.equal(closedGuideRead.isError, true);
  assert.match(allResponseText(closedGuideRead), /closed.*reopen|reopen.*closed/i);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  const restored = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  const restoredLists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(restoredLists[0]?.name, "Composite work");

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
});

test("workspace.tasks survives MCP server restart through the same persistent Workspace identity", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-task-restart");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Restart work" },
    },
  });
  const listId = String(
    ((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Resume after restart",
        content: "The Task file is the durable truth.",
      },
    },
  });
  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredAuditStore = new ActivityAuditStore(context.stateDir);
  const restoredBashOutputStore = new BashOutputStore(context.stateDir);
  const restoredHostTurnStore = new HostTurnStore(context.stateDir);
  const restoredActivityQueries = new ActivityQueryService(
    restoredHostTurnStore,
    restoredAuditStore,
    restoredBashOutputStore,
  );
  const restoredActivityLifecycle = new ActivityLifecycle(restoredAuditStore, {
    turnIdForConversation: (conversationScopeId, targetWorkspaceId) =>
      restoredActivityQueries.currentTurnId(conversationScopeId, targetWorkspaceId),
  });
  const restoredCodeIntelligence = new CodeIntelligenceManager(context.config);
  const restoredProcessSessions = new ProcessManager({ outputAudit: restoredBashOutputStore });
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    restoredProcessSessions,
    [],
    [],
    restoredCodeIntelligence,
    restoredActivityLifecycle,
    restoredBashOutputStore,
    restoredActivityQueries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "task-restart-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    await restoredCodeIntelligence.shutdown();
    restoredProcessSessions.shutdown();
    restoredHostTurnStore.close();
    restoredBashOutputStore.close();
    restoredAuditStore.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(clientTransport),
      restoredServer.connect(serverTransport),
    ]);
    const reopened = await restoredClient.callTool({
      name: "open_workspace",
      arguments: { workspaceId, context: "none" },
      _meta: { "openai/session": "chat-task-restart-restored" },
    } as Parameters<Client["callTool"]>[0]);
    assert.equal(reopened.isError, undefined, allResponseText(reopened));
    assert.equal(structuredContent(reopened).workspaceId, workspaceId);
    const restored = await restoredClient.callTool({
      name: "capability",
      arguments: {
        workspaceId,
        name: "workspace.tasks",
        action: "run",
        arguments: { operation: "get", level: "headers", listId },
      },
    });
    assert.equal(restored.isError, undefined, allResponseText(restored));
    const lists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
    assert.equal(lists[0]?.name, "Restart work");
    const tasks = lists[0]?.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks[0]?.subject, "Resume after restart");
    assert.equal(tasks[0]?.content, undefined);
  } finally {
    await closeRestored();
  }
});

test("workspace.tasks survives managed-worktree backing replacement and never enters Git contents", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-task-worktree", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const firstWorktreePath = String(worktree.path);
  const taskStatePath = join(context.stateDir, "workspaces", workspaceId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Isolated release" },
    },
  });
  const listId = String(
    ((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.create", listId, subject: "Keep across backing replacement" },
    },
  });
  const worktreeStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: firstWorktreePath });
  assert.equal(worktreeStatus.stdout.trim(), "");

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close task worktree" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await assert.rejects(stat(firstWorktreePath), /ENOENT/);
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-task-worktree" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  const reopenedWorktree = structuredContent(reopened).worktree as Record<string, unknown>;
  assert.notEqual(reopenedWorktree.path, firstWorktreePath);
  const restored = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId },
    },
  });
  const lists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(lists[0]?.id, listId);
  const tasks = lists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks[0]?.subject, "Keep across backing replacement");
  assert.equal(tasks[0]?.content, undefined);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      action: "delete",
      commitMessage: "test: delete task worktree",
    },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
});

