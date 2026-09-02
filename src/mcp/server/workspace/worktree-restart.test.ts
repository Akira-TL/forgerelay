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

test("close_workspace finalizes a managed-worktree-backed workspace and supports commit-message retry", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-1", "worktree");
  const workspaceId = structuredContent(opened).workspaceId;
  assert.equal(typeof workspaceId, "string");
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  assert.equal(worktree.detached, false);
  assert.match(String(worktree.branch), /^forgerelay\//);
  assert.equal(typeof worktree.targetBranch, "string");

  await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "feature.txt",
      content: "finished\n",
    },
  });
  const missingMessage = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(missingMessage.isError, true);
  assert.match(allResponseText(missingMessage), /requires commitMessage/);
  assert.equal(await readFile(join(String(worktree.path), "feature.txt"), "utf8"), "finished\n");

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      commitMessage: "feat: finish isolated work",
    },
  });
  const structured = structuredContent(closed);

  assert.equal(structured.workspaceId, workspaceId);
  assert.equal(structured.mode, "worktree");
  assert.equal(structured.committed, true);
  assert.equal(structured.branch, worktree.branch);
  assert.equal(structured.targetBranch, worktree.targetBranch);
  assert.equal(
    (await readFile(join(context.project, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "finished\n",
  );
  assert.equal(structured.action, "close");
  assert.match(responseText(closed), /fast-forward/);
  const originalWorktreePath = String(worktree.path);
  await assert.rejects(stat(originalWorktreePath), /ENOENT/);

  const closedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const closedEntry = (structuredContent(closedInventory).workspaces as Array<Record<string, unknown>>)[0];
  assert.equal(closedEntry?.workspaceId, workspaceId);
  assert.equal(closedEntry?.state, "closed");

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "feature.txt" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  const reopenedWorktree = structuredContent(reopened).worktree as Record<string, unknown>;
  assert.notEqual(reopenedWorktree.path, originalWorktreePath);
  assert.notEqual(reopenedWorktree.branch, worktree.branch);
  assert.equal(reopenedWorktree.targetBranch, worktree.targetBranch);
  assert.equal((await stat(String(reopenedWorktree.path))).isDirectory(), true);

  const reclosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close reopened managed worktree" },
  });
  assert.equal(reclosed.isError, undefined, allResponseText(reclosed));

  const deletedClosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(deletedClosed.isError, undefined, allResponseText(deletedClosed));
  assert.equal(structuredContent(deletedClosed).workspaceId, workspaceId);
  assert.equal(structuredContent(deletedClosed).action, "delete");
  assert.match(allResponseText(deletedClosed), /already-removed worktree backing was not recreated/);

  const deletedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.equal(
    (structuredContent(deletedInventory).workspaces as Array<Record<string, unknown>>).length,
    0,
  );

  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "close_worktree"), false);
});

test("close_workspace delete safely finalizes an active managed-worktree Workspace before deleting identity", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-delete-worktree", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "delete-feature.txt", content: "preserve through finalize\n" },
  });

  const unsafeDelete = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(unsafeDelete.isError, true);
  assert.match(allResponseText(unsafeDelete), /requires commitMessage/);
  assert.equal(
    await readFile(join(String(worktree.path), "delete-feature.txt"), "utf8"),
    "preserve through finalize\n",
  );

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      action: "delete",
      commitMessage: "test: safely finalize deleted worktree",
    },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).workspaceId, workspaceId);
  assert.equal(structuredContent(deleted).action, "delete");
  assert.equal(structuredContent(deleted).mode, "worktree");
  assert.match(allResponseText(deleted), /Safely finalized and deleted/);
  assert.equal(
    (await readFile(join(context.project, "delete-feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "preserve through finalize\n",
  );
  await assert.rejects(stat(String(worktree.path)), /ENOENT/);

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.equal((structuredContent(inventory).workspaces as Array<Record<string, unknown>>).length, 0);
});

test("failed managed-worktree reopen leaves the Workspace closed through MCP", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-failed-reopen", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const targetBranch = String(worktree.targetBranch);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close before failed reopen" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await git(context.project, ["switch", "-c", "replacement-target"]);
  await git(context.project, ["branch", "-D", targetBranch]);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-failed-reopen" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, true);
  assert.match(allResponseText(reopened), /baseRef|local branch|managed worktree/i);

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const entry = (structuredContent(inventory).workspaces as Array<Record<string, unknown>>)[0];
  assert.equal(entry?.workspaceId, workspaceId);
  assert.equal(entry?.state, "closed");
});

test("worktree lifecycle hook reports are visible on close_workspace", async (t) => {
  const context = await fixture(t, { git: true });
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-verification.json"),
    JSON.stringify({
      event: "BeforeWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-integrated.json"),
    JSON.stringify({
      event: "AfterWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await git(context.project, ["add", ".forgerelay/hooks"]);
  await git(context.project, ["commit", "-m", "Add project hooks"]);

  const opened = await callOpen(context.client, context.project, "chat-hook-close-report", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "feature.txt", content: "hook report\n" },
  });
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close with hook reports" },
  });
  const visible = allResponseText(closed);

  assert.match(visible, /worktree-verification \(BeforeWorktreeClose, project\) passed/);
  assert.match(visible, /worktree-integrated \(AfterWorktreeClose, project\) passed/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same directory previously opened/);
});

test("open_workspace auto returns only changed bootstrap components", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-incremental-bootstrap");
  const firstContent = structuredContent(first);
  assert.ok(Array.isArray(firstContent.agentsFiles));
  assert.ok(Array.isArray(firstContent.capabilityGuides));

  await writeFile(join(context.project, "AGENTS.md"), "updated project instructions only\n");

  const updated = await callOpen(context.client, context.project, "chat-incremental-bootstrap");
  const updatedContent = structuredContent(updated);
  const updatedAgentsFiles = updatedContent.agentsFiles as Array<{ path?: string; content?: string }>;
  assert.equal(
    updatedAgentsFiles.some((file) =>
      file.path === "AGENTS.md" && file.content === "updated project instructions only\n"
    ),
    true,
  );
  assert.equal(updatedContent.availableAgentsFiles, undefined);
  assert.equal(updatedContent.skills, undefined);
  assert.equal(updatedContent.skillDiagnostics, undefined);
  assert.equal(updatedContent.capabilityGuides, undefined);
  assert.equal(updatedContent.agentProviders, undefined);
  assert.equal(updatedContent.agents, undefined);
});

test("open_workspace context none does not acknowledge changed bootstrap components", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-incremental-none");
  const workspaceId = String(structuredContent(first).workspaceId);

  await writeFile(join(context.project, "AGENTS.md"), "changed while bootstrap is suppressed\n");
  const suppressed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-incremental-none" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(suppressed).agentsFiles, undefined);

  const automatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "auto" },
    _meta: { "openai/session": "chat-incremental-none" },
  } as Parameters<Client["callTool"]>[0]);
  const automaticContent = structuredContent(automatic);
  assert.match(JSON.stringify(automaticContent.agentsFiles), /changed while bootstrap is suppressed/);
  assert.equal(automaticContent.skills, undefined);
  assert.equal(automaticContent.capabilityGuides, undefined);
  assert.equal(automaticContent.agents, undefined);
});

test("open_workspace auto returns an empty changed component when bootstrap content is removed", async (t) => {
  const context = await fixture(t);
  const nestedDir = join(context.project, "nested-bootstrap");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, "AGENTS.md"), "nested bootstrap instructions\n");

  const first = await callOpen(context.client, context.project, "chat-incremental-delete");
  const firstAvailable = structuredContent(first).availableAgentsFiles as Array<{ path?: string }>;
  assert.equal(firstAvailable.some((file) => file.path === "nested-bootstrap/AGENTS.md"), true);

  await rm(join(nestedDir, "AGENTS.md"), { force: true });
  const updated = await callOpen(context.client, context.project, "chat-incremental-delete");
  const updatedContent = structuredContent(updated);
  assert.deepEqual(updatedContent.availableAgentsFiles, []);
  assert.equal(updatedContent.agentsFiles, undefined);
  assert.equal(updatedContent.skills, undefined);
  assert.equal(updatedContent.capabilityGuides, undefined);
  assert.equal(updatedContent.agents, undefined);
});

test("legacy whole-bootstrap delivery upgrades without resending unchanged context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-legacy-bootstrap-delivery");
  const workspaceId = String(structuredContent(first).workspaceId);
  const binding = context.store.listConversationBindings().find((candidate) =>
    candidate.conversationScopeId === "chat-legacy-bootstrap-delivery" &&
    candidate.workspaceSessionId === workspaceId
  );
  assert.ok(binding);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      update workspace_context_deliveries
         set component_fingerprints_json = null
       where conversation_scope_id = ? and target_key = ?
    `).run(binding.conversationScopeId, binding.targetKey);
  } finally {
    database.close();
  }

  const repeated = await callOpen(context.client, context.project, "chat-legacy-bootstrap-delivery");
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.equal(structuredContent(repeated).skills, undefined);
  assert.ok(
    context.store.getContextDelivery(binding.conversationScopeId, binding.targetKey)?.componentFingerprints,
  );
});

test("a host without conversation metadata reuses the directory workspace and still receives full context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).availableAgentsFiles));
  assert.ok(Array.isArray(structuredContent(second).skills));
  assert.ok(Array.isArray(structuredContent(second).skillDiagnostics));
  assert.ok(Array.isArray(structuredContent(second).capabilityGuides));
  assert.ok(Array.isArray(structuredContent(second).agents));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout context and durable Activity queries survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;
  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: firstWorkspaceId },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(panel).turnId);
  const bash = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: firstWorkspaceId,
      action: "run",
      command: "node -e \"console.log('restart-durable-output')\"",
      yieldTimeMs: 10_000,
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  const outputId = structuredContent(bash).outputId;
  assert.equal(typeof outputId, "string");
  await writeFile(join(context.project, "restart-bulk-a.txt"), "RESTART-BULK-A\n");
  await writeFile(join(context.project, "restart-bulk-b.txt"), "RESTART-BULK-B\n");
  const bulkRead = await context.client.callTool({
    name: "read",
    arguments: {
      workspaceId: firstWorkspaceId,
      paths: ["restart-bulk-a.txt", "restart-bulk-b.txt"],
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(bulkRead.isError, undefined);
  const durableBatch = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: firstWorkspaceId,
      name: "batch.execute",
      action: "run",
      arguments: {
        tasks: [
          { id: "read", operation: "read", path: "restart-bulk-a.txt" },
          { id: "bash", operation: "bash.run", command: "node -e \"console.log('restart-batch-output')\"" },
          { id: "hooks", operation: "capability.run", name: "hooks.check", arguments: {} },
        ],
      },
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(durableBatch.isError, undefined);
  const durableBatchValue = structuredContent(durableBatch).result as Record<string, unknown>;
  const durableBatchResults = durableBatchValue.results as Array<Record<string, unknown>>;
  const durableBatchBashResult = durableBatchResults.find((result) => result.id === "bash")?.result as Record<string, unknown>;
  const durableBatchBashStructured = durableBatchBashResult.structuredContent as Record<string, unknown>;
  const batchOutputId = String(durableBatchBashStructured.outputId);
  assert.match(batchOutputId, /^out_/);

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
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      restoredActivityQueries.currentTurnId(conversationScopeId, workspaceId),
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
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "forgerelay-restored-test-client", version: "1.0.0" });
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
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same directory previously opened/);

    const restoredSnapshot = await restoredClient.callTool({
      name: "activity_snapshot",
      arguments: { turnId },
    });
    assert.equal(restoredSnapshot.isError, undefined);
    assert.equal(structuredContent(restoredSnapshot).activities, undefined);
    const restoredIndex = await restoredClient.callTool({
      name: "activity_index",
      arguments: { turnId },
    });
    assert.equal(restoredIndex.isError, undefined);
    const restoredActivities = structuredContent(restoredIndex).activities as Array<Record<string, unknown>>;
    assert.equal(restoredActivities.length, 8);
    const restoredBash = restoredActivities.find((activity) => activity.tool === "bash");
    assert.equal(restoredBash?.outputId, outputId);
    const restoredActivityId = String(restoredBash?.activityId);
    const restoredBulkParent = restoredActivities.find((activity) =>
      activity.tool === "read" && activity.parentActivityId === undefined && activity.children !== undefined
    );
    assert.equal(restoredBulkParent?.target, "2 files");
    assert.deepEqual(restoredBulkParent?.children, { total: 2, working: 0, done: 2, error: 0 });
    const restoredBulkChildren = restoredActivities.filter((activity) =>
      activity.parentActivityId === restoredBulkParent?.activityId
    );
    assert.equal(restoredBulkChildren.length, 2);
    const restoredBatchParent = restoredActivities.find((activity) => activity.tool === "batch");
    assert.equal(restoredBatchParent?.target, "3 tasks");
    assert.deepEqual(restoredBatchParent?.children, { total: 3, working: 0, done: 3, error: 0 });
    const restoredBatchChildren = restoredActivities.filter((activity) =>
      activity.parentActivityId === restoredBatchParent?.activityId
    );
    assert.equal(restoredBatchChildren.length, 3);
    const restoredBatchBash = restoredBatchChildren.find((activity) => activity.tool === "bash");
    assert.equal(restoredBatchBash?.outputId, batchOutputId);

    const restoredDetail = await restoredClient.callTool({
      name: "activity_detail",
      arguments: { turnId, activityId: restoredActivityId },
    });
    assert.equal(restoredDetail.isError, undefined);
    assert.match(JSON.stringify(structuredContent(restoredDetail)), /restart-durable-output/);
    const restoredBulkDetail = await restoredClient.callTool({
      name: "activity_detail",
      arguments: { turnId, activityId: String(restoredBulkChildren[0]?.activityId) },
    });
    assert.equal(restoredBulkDetail.isError, undefined);
    assert.match(JSON.stringify(structuredContent(restoredBulkDetail)), /RESTART-BULK-A/);

    const restoredOutput = await restoredClient.callTool({
      name: "activity_output",
      arguments: { turnId, outputId },
    });
    assert.equal(restoredOutput.isError, undefined);
    assert.match(String(structuredContent(restoredOutput).output), /restart-durable-output/);
    assert.equal(structuredContent(restoredOutput).outputId, outputId);
    const restoredBatchOutput = await restoredClient.callTool({
      name: "activity_output",
      arguments: { turnId, outputId: batchOutputId },
    });
    assert.equal(restoredBatchOutput.isError, undefined);
    assert.match(String(structuredContent(restoredBatchOutput).output), /restart-batch-output/);
    assert.equal(structuredContent(restoredBatchOutput).outputId, batchOutputId);
  } finally {
    await closeRestored();
  }
});

test("HTTP MCP transports share Composite Workspace runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-server-shared-runtime-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const ownerToken = "shared-runtime-owner-token-that-is-long-enough";
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, "worktrees"),
    FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  try {
    const port = (httpServer.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}`;
    const remote = await authenticateRemote(endpoint, ownerToken);
    const created = await withRemoteMcpClient(remote, endpoint, (client) =>
      client.callTool({
        name: "open_workspace",
        arguments: { kind: "composite", name: "shared-runtime" },
      })
    );
    assert.equal(created.isError, undefined);
    const compositeId = String(structuredContent(created).workspaceId);
    assert.match(compositeId, /^cws_/);

    const inspected = await withRemoteMcpClient(remote, endpoint, (client) =>
      client.callTool({
        name: "open_workspace",
        arguments: { action: "inspect", workspaceId: compositeId },
      })
    );
    assert.equal(inspected.isError, undefined);
    const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
    assert.equal(inspection.workspaceId, compositeId);
    assert.equal(inspection.kind, "composite");
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
