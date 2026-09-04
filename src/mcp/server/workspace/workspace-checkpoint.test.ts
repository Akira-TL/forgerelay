import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../runtime/state/db/client.js";
import { ProcessManager } from "../../process/process-sessions.js";
import { createMcpServer } from "../../../server.js";
import { WorkspaceCheckpointStore } from "../../../workspaces/state/workspace-checkpoints.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  structuredContent,
} from "../../../runtime/testing/server-fixture.js";

const execFileAsync = promisify(execFile);

test("workspace.checkpoint creates an immutable Git-visible snapshot without mutating HEAD, files, or staging state", async (t) => {
  const context = await fixture(t, { git: true });
  await writeFile(join(context.project, ".gitignore"), "secret.env\n");
  await git(context.project, ["add", ".gitignore"]);
  await git(context.project, ["commit", "-m", "test: add ignore rule"]);

  const opened = await callOpen(context.client, context.project, "checkpoint-create");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "README.md"), "hello\nstaged\n");
  await git(context.project, ["add", "README.md"]);
  await writeFile(join(context.project, "README.md"), "hello\nworking tree\n");
  await writeFile(join(context.project, "visible.txt"), "visible checkpoint content\n");
  await writeFile(join(context.project, "secret.env"), "ignored secret\n");

  const headBefore = await gitOutput(context.project, ["rev-parse", "HEAD"]);
  const branchBefore = await gitOutput(context.project, ["branch", "--show-current"]);
  const statusBefore = await gitOutputRaw(context.project, ["status", "--porcelain=v1"]);
  const stagedBefore = await gitOutputRaw(context.project, ["diff", "--cached", "--binary", "--no-color"]);
  const readmeBefore = await readFile(join(context.project, "README.md"), "utf8");

  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "before parser refactor",
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const createResult = structuredContent(created).result as Record<string, unknown>;
  const checkpoint = createResult.checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);
  const snapshotCommit = String(checkpoint.commit);
  assert.match(checkpointId, /^cp_[a-f0-9]{10}$/);
  assert.equal(checkpoint.name, "before parser refactor");
  assert.equal(checkpoint.baseHead, headBefore);
  assert.equal(createResult.ignoredFilesIncluded, false);
  assert.deepEqual(checkpoint.summary, { files: 2, additions: 2, removals: 0 });

  assert.equal(await gitOutput(context.project, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await gitOutput(context.project, ["branch", "--show-current"]), branchBefore);
  assert.equal(await gitOutputRaw(context.project, ["status", "--porcelain=v1"]), statusBefore);
  assert.equal(await gitOutputRaw(context.project, ["diff", "--cached", "--binary", "--no-color"]), stagedBefore);
  assert.equal(await readFile(join(context.project, "README.md"), "utf8"), readmeBefore);
  assert.equal(await gitOutputRaw(context.project, ["show", `${snapshotCommit}:README.md`]), "hello\nworking tree\n");
  assert.equal(await gitOutputRaw(context.project, ["show", `${snapshotCommit}:visible.txt`]), "visible checkpoint content\n");
  await assert.rejects(execFileAsync("git", ["cat-file", "-e", `${snapshotCommit}:secret.env`], { cwd: context.project }));

  const listed = await checkpointCall(context.client, workspaceId, { operation: "list" });
  const listResult = structuredContent(listed).result as Record<string, unknown>;
  assert.equal(listResult.ignoredFilesIncluded, false);
  assert.equal((listResult.checkpoints as unknown[]).length, 1);
  assert.equal(JSON.stringify(listResult).includes("working tree"), false);
  assert.equal(JSON.stringify(listResult).includes("secret.env"), false);

  const inspected = await checkpointCall(context.client, workspaceId, {
    operation: "inspect",
    checkpointId,
  });
  assert.deepEqual(
    (structuredContent(inspected).result as Record<string, unknown>).checkpoint,
    checkpoint,
  );

  const restartedStore = new WorkspaceCheckpointStore(context.stateDir);
  const afterStoreRestart = await restartedStore.inspect(workspaceId, context.project, checkpointId);
  assert.equal(afterStoreRestart.checkpoint.commit, snapshotCommit);

  const deleted = await checkpointCall(context.client, workspaceId, {
    operation: "delete",
    checkpointId,
  });
  assert.deepEqual(structuredContent(deleted).result, { workspaceId, checkpointId, deleted: true });
  const afterDelete = await checkpointCall(context.client, workspaceId, { operation: "list" });
  assert.deepEqual((structuredContent(afterDelete).result as Record<string, unknown>).checkpoints, []);
  await assert.rejects(execFileAsync("git", [
    "show-ref",
    "--verify",
    `refs/forgerelay/checkpoints/${workspaceId}/${checkpointId}`,
  ], { cwd: context.project }));
});

test("workspace.checkpoint restore reproduces Git-visible content without moving HEAD, index state, or ignored files", async (t) => {
  const context = await fixture(t, { git: true });
  await writeFile(join(context.project, ".gitignore"), "ignored.bin\n");
  await writeFile(join(context.project, "modified.txt"), "base modified\n");
  await writeFile(join(context.project, "rename-source.txt"), "rename target content\n");
  await writeFile(join(context.project, "removed-at-checkpoint.txt"), "base removable\n");
  await writeFile(join(context.project, "staged.txt"), "base staged\n");
  await writeFile(join(context.project, "binary.bin"), Buffer.from([0, 1, 2, 3, 255, 10]));
  await git(context.project, ["add", "."]);
  await git(context.project, ["commit", "-m", "test: checkpoint restore base"]);

  const opened = await callOpen(context.client, context.project, "checkpoint-restore");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "modified.txt"), "checkpoint modified\n");
  await writeFile(join(context.project, "checkpoint-added.txt"), "checkpoint added\n");
  await rename(join(context.project, "rename-source.txt"), join(context.project, "renamed.txt"));
  await rm(join(context.project, "removed-at-checkpoint.txt"));
  await writeFile(join(context.project, "staged.txt"), "checkpoint staged\n");
  const checkpointBinary = Buffer.from([9, 8, 0, 7, 255, 6]);
  await writeFile(join(context.project, "binary.bin"), checkpointBinary);
  await writeFile(join(context.project, "ignored.bin"), Buffer.from([10, 11, 12]));

  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "restore target",
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);

  await writeFile(join(context.project, "modified.txt"), "current modified\n");
  await rm(join(context.project, "checkpoint-added.txt"));
  await rename(join(context.project, "renamed.txt"), join(context.project, "renamed-later.txt"));
  await writeFile(join(context.project, "removed-at-checkpoint.txt"), "recreated later\n");
  await writeFile(join(context.project, "current-only.txt"), "delete on restore\n");
  await writeFile(join(context.project, "binary.bin"), Buffer.from([1, 2, 3, 0, 4, 5]));
  await writeFile(join(context.project, "ignored.bin"), Buffer.from([20, 21, 22]));
  await writeFile(join(context.project, "staged.txt"), "current staged index\n");
  await git(context.project, ["add", "staged.txt"]);
  await writeFile(join(context.project, "staged.txt"), "current staged working tree\n");

  const headBefore = await gitOutput(context.project, ["rev-parse", "HEAD"]);
  const branchBefore = await gitOutput(context.project, ["branch", "--show-current"]);
  const stagedBefore = await gitOutputRaw(context.project, ["diff", "--cached", "--binary", "--no-color"]);
  const preflight = await checkpointCall(context.client, workspaceId, {
    operation: "restore.preflight",
    checkpointId,
  });
  assert.equal(preflight.isError, undefined, allResponseText(preflight));
  const preflightResult = structuredContent(preflight).result as Record<string, unknown>;
  assert.match(String(preflightResult.checkpointSnapshot), /^[a-f0-9]{40,64}$/);
  assert.match(String(preflightResult.currentSnapshot), /^[a-f0-9]{40,64}$/);
  assert.notEqual(preflightResult.currentSnapshot, preflightResult.checkpointSnapshot);
  assert.equal(preflightResult.ignoredFilesIncluded, false);
  assert.equal(preflightResult.stagingStateRestored, false);
  assert.ok(Number((preflightResult.restoreSummary as Record<string, unknown>).files) >= 6);

  const restored = await checkpointCall(context.client, workspaceId, {
    operation: "restore",
    checkpointId,
    expectedCurrentSnapshot: preflightResult.currentSnapshot,
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  const restoreResult = structuredContent(restored).result as Record<string, unknown>;
  assert.equal(restoreResult.restored, true);
  assert.equal(restoreResult.previousSnapshot, preflightResult.currentSnapshot);
  assert.equal(restoreResult.currentSnapshot, preflightResult.checkpointSnapshot);
  assert.equal(restoreResult.stagingStateRestored, false);
  assert.equal(restoreResult.ignoredFilesIncluded, false);

  assert.equal(await gitOutput(context.project, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(await gitOutput(context.project, ["branch", "--show-current"]), branchBefore);
  assert.equal(await gitOutputRaw(context.project, ["diff", "--cached", "--binary", "--no-color"]), stagedBefore);
  assert.equal(normalizeText(await readFile(join(context.project, "modified.txt"), "utf8")), "checkpoint modified\n");
  assert.equal(normalizeText(await readFile(join(context.project, "checkpoint-added.txt"), "utf8")), "checkpoint added\n");
  assert.equal(normalizeText(await readFile(join(context.project, "renamed.txt"), "utf8")), "rename target content\n");
  await assert.rejects(readFile(join(context.project, "renamed-later.txt")), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "removed-at-checkpoint.txt")), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "current-only.txt")), /ENOENT/);
  assert.deepEqual(await readFile(join(context.project, "binary.bin")), checkpointBinary);
  assert.deepEqual(await readFile(join(context.project, "ignored.bin")), Buffer.from([20, 21, 22]));
  assert.equal(normalizeText(await readFile(join(context.project, "staged.txt"), "utf8")), "checkpoint staged\n");

  const after = await checkpointCall(context.client, workspaceId, {
    operation: "restore.preflight",
    checkpointId,
  });
  const afterResult = structuredContent(after).result as Record<string, unknown>;
  assert.equal(afterResult.currentSnapshot, afterResult.checkpointSnapshot);
});

test("workspace.checkpoint restore refuses stale preflight tokens before any restore mutation", async (t) => {
  const context = await fixture(t, { git: true });
  await writeFile(join(context.project, "restore-target.txt"), "checkpoint target\n");
  await git(context.project, ["add", "restore-target.txt"]);
  await git(context.project, ["commit", "-m", "test: restore conflict base"]);
  const opened = await callOpen(context.client, context.project, "checkpoint-restore-conflict");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "conflict target",
  });
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);
  await writeFile(join(context.project, "restore-target.txt"), "current before preflight\n");
  const preflight = await checkpointCall(context.client, workspaceId, {
    operation: "restore.preflight",
    checkpointId,
  });
  const expectedCurrentSnapshot = String((structuredContent(preflight).result as Record<string, unknown>).currentSnapshot);

  await writeFile(join(context.project, "external-after-preflight.txt"), "external edit must survive\n");
  const statusBefore = await gitOutputRaw(context.project, ["status", "--porcelain=v1", "-z"]);
  const targetBefore = await readFile(join(context.project, "restore-target.txt"));
  const externalBefore = await readFile(join(context.project, "external-after-preflight.txt"));
  const rejected = await checkpointCall(context.client, workspaceId, {
    operation: "restore",
    checkpointId,
    expectedCurrentSnapshot,
  });
  assert.equal(rejected.isError, true);
  assert.match(allResponseText(rejected), /current working snapshot changed|restore\.preflight/i);
  assert.deepEqual(await readFile(join(context.project, "restore-target.txt")), targetBefore);
  assert.deepEqual(await readFile(join(context.project, "external-after-preflight.txt")), externalBefore);
  assert.equal(await gitOutputRaw(context.project, ["status", "--porcelain=v1", "-z"]), statusBefore);
});

test("workspace.checkpoint serializes concurrent mutations without losing persistent checkpoint identities", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "checkpoint-concurrent");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const created = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const result = await checkpointCall(context.client, workspaceId, {
      operation: "create",
      name: `concurrent checkpoint ${index + 1}`,
    });
    assert.equal(result.isError, undefined, allResponseText(result));
    return (structuredContent(result).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  }));
  assert.equal(new Set(created.map((checkpoint) => checkpoint.id)).size, 8);

  const listed = await checkpointCall(context.client, workspaceId, { operation: "list", limit: 100 });
  assert.equal(listed.isError, undefined, allResponseText(listed));
  const checkpoints = (structuredContent(listed).result as Record<string, unknown>).checkpoints as Array<Record<string, unknown>>;
  assert.equal(checkpoints.length, 8);
  assert.deepEqual(
    new Set(checkpoints.map((checkpoint) => checkpoint.id)),
    new Set(created.map((checkpoint) => checkpoint.id)),
  );
  for (const checkpoint of checkpoints) {
    assert.equal(
      await gitOutput(context.project, [
        "rev-parse",
        "--verify",
        `refs/forgerelay/checkpoints/${workspaceId}/${String(checkpoint.id)}^{commit}`,
      ]),
      checkpoint.commit,
    );
  }
});

test("workspace.checkpoint survives an MCP server restart through the same persistent Workspace identity", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "checkpoint-restart");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "restart-checkpoint.txt"), "persist across server restart\n");
  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "restart checkpoint",
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);
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
  const restoredClient = new Client({ name: "checkpoint-restart-client", version: "1.0.0" });
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

  await Promise.all([
    restoredClient.connect(clientTransport),
    restoredServer.connect(serverTransport),
  ]);
  const reopened = await restoredClient.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  const inspected = await checkpointCall(restoredClient, workspaceId, {
    operation: "inspect",
    checkpointId,
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  assert.deepEqual(
    (structuredContent(inspected).result as Record<string, unknown>).checkpoint,
    checkpoint,
  );
  await closeRestored();
});

test("workspace.checkpoint survives managed-worktree finalize and backing recreation for the same persistent Workspace", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "checkpoint-worktree", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const oldRoot = String(structuredContent(opened).root);
  await writeFile(join(oldRoot, "checkpoint-survives.txt"), "survives backing replacement\n");

  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "before worktree finalize",
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "TEST: (checkpoint) finalize managed fixture" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(String(structuredContent(reopened).workspaceId), workspaceId);
  assert.notEqual(String(structuredContent(reopened).root), oldRoot);

  const inspected = await checkpointCall(context.client, workspaceId, {
    operation: "inspect",
    checkpointId,
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  assert.deepEqual(
    (structuredContent(inspected).result as Record<string, unknown>).checkpoint,
    checkpoint,
  );

  const finalClose = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "TEST: (checkpoint) clean reopened fixture" },
  });
  assert.equal(finalClose.isError, undefined, allResponseText(finalClose));
});

test("workspace.checkpoint restore and managed-worktree recovery remain independent operations", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "checkpoint-recovery-independent", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const oldRoot = String(structuredContent(opened).root);
  await writeFile(join(oldRoot, "checkpoint-only.txt"), "checkpoint content outside managed branch\n");
  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "independent recovery checkpoint",
  });
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);

  await rm(oldRoot, { recursive: true, force: true });
  const restoreWithoutBacking = await checkpointCall(context.client, workspaceId, {
    operation: "restore.preflight",
    checkpointId,
  });
  assert.equal(restoreWithoutBacking.isError, true);
  await assert.rejects(stat(oldRoot), /ENOENT/);

  const repaired = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.recovery",
      action: "run",
      arguments: { operation: "repair" },
    },
  });
  assert.equal(repaired.isError, undefined, allResponseText(repaired));
  const repairResult = structuredContent(repaired).result as Record<string, unknown>;
  assert.equal(repairResult.repaired, true);
  const newRoot = String(repairResult.root);
  assert.notEqual(newRoot, oldRoot);
  await assert.rejects(readFile(join(newRoot, "checkpoint-only.txt")), /ENOENT/);

  const preflight = await checkpointCall(context.client, workspaceId, {
    operation: "restore.preflight",
    checkpointId,
  });
  assert.equal(preflight.isError, undefined, allResponseText(preflight));
  const currentSnapshot = String((structuredContent(preflight).result as Record<string, unknown>).currentSnapshot);
  const restored = await checkpointCall(context.client, workspaceId, {
    operation: "restore",
    checkpointId,
    expectedCurrentSnapshot: currentSnapshot,
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  assert.equal(
    normalizeText(await readFile(join(newRoot, "checkpoint-only.txt"), "utf8")),
    "checkpoint content outside managed branch\n",
  );

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "TEST: (checkpoint) finalize independent restore" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
});

test("Workspace idle GC and close preserve checkpoints while Workspace delete removes them", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const created = await checkpointCall(context.client, workspaceId, {
    operation: "create",
    name: "lifecycle checkpoint",
  });
  const checkpoint = (structuredContent(created).result as Record<string, unknown>).checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);
  const checkpointStatePath = join(context.stateDir, "workspaces", workspaceId, "checkpoints.json");

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), workspaceId);
  } finally {
    database.close();
  }
  const afterIdleGc = await callOpen(context.client, context.project);
  assert.equal(structuredContent(afterIdleGc).workspaceId, workspaceId);
  const afterGcCheckpoint = await checkpointCall(context.client, workspaceId, {
    operation: "inspect",
    checkpointId,
  });
  assert.equal(afterGcCheckpoint.isError, undefined, allResponseText(afterGcCheckpoint));

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.match(await readFile(checkpointStatePath, "utf8"), new RegExp(checkpointId));

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  const afterReopen = await checkpointCall(context.client, workspaceId, {
    operation: "inspect",
    checkpointId,
  });
  assert.equal(afterReopen.isError, undefined, allResponseText(afterReopen));

  const removed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(removed.isError, undefined, allResponseText(removed));
  await assert.rejects(readFile(checkpointStatePath, "utf8"), /ENOENT/);
  await assert.rejects(execFileAsync("git", [
    "show-ref",
    "--verify",
    `refs/forgerelay/checkpoints/${workspaceId}/${checkpointId}`,
  ], { cwd: context.project }));
});

test("Composite workspace.checkpoint requires and scopes through an explicit filesystem member", async (t) => {
  const context = await fixture(t, { git: true });
  const memberOpened = await callOpen(context.client, context.project, "checkpoint-composite-member");
  const memberWorkspaceId = String(structuredContent(memberOpened).workspaceId);
  const compositeOpened = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "checkpoint-composite", context: "none" },
  });
  const compositeId = String(structuredContent(compositeOpened).workspaceId);
  const added = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Checkpoint target", workspaceId: memberWorkspaceId },
    },
  });
  assert.equal(added.isError, undefined, allResponseText(added));

  const withoutMember = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "list" },
    },
  });
  assert.equal(withoutMember.isError, true);
  assert.match(allResponseText(withoutMember), /requires member/i);

  const created = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "create", name: "member checkpoint" },
    },
  });
  assert.equal(created.isError, undefined, allResponseText(created));

  const memberList = await checkpointCall(context.client, memberWorkspaceId, { operation: "list" });
  const checkpoints = (structuredContent(memberList).result as Record<string, unknown>).checkpoints as Array<Record<string, unknown>>;
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.name, "member checkpoint");
  const checkpointId = String(checkpoints[0]?.id);

  await writeFile(join(context.project, "README.md"), "composite member changed\n");
  const preflight = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "restore.preflight", checkpointId },
    },
  });
  assert.equal(preflight.isError, undefined, allResponseText(preflight));
  const preflightResult = structuredContent(preflight).result as Record<string, unknown>;
  const restored = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      name: "workspace.checkpoint",
      action: "run",
      arguments: {
        operation: "restore",
        checkpointId,
        expectedCurrentSnapshot: preflightResult.currentSnapshot,
      },
    },
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  assert.equal(normalizeText(await readFile(join(context.project, "README.md"), "utf8")), "hello\n");
});

async function checkpointCall(
  client: Client,
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: args,
    },
  });
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function gitOutputRaw(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
