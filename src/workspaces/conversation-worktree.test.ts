import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import {
  breakAgentsDirectory,
  checkoutTargetKey,
  fixture,
  git,
  restoreAgentsDirectory,
} from "./conversation-test-support.js";

test("a physical worktree has one canonical Workspace identity and cannot be released without close_worktree", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const first = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );

  assert.throws(
    () => registry.closeWorkspace(first.workspace.id),
    /backed by a managed worktree/,
  );

  const alias = await registry.openWorkspace(
    { path: first.workspace.root, mode: "worktree" },
    { conversationScopeId: "chat-2" },
  );
  assert.equal(alias.workspace.id, first.workspace.id);
  assert.equal(alias.workspace.root, first.workspace.root);

  assert.throws(
    () => registry.closeWorkspace(alias.workspace.id),
    /backed by a managed worktree/,
  );
});

test("closing a managed worktree preserves identity and reopen recreates physical backing", async (t) => {
  const { project, registry, store } = await fixture(t, { git: true });
  const first = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const alias = await registry.openWorkspace(
    { path: first.workspace.root, mode: "worktree" },
    { conversationScopeId: "chat-2" },
  );
  assert.equal(alias.workspace.id, first.workspace.id);
  const originalRoot = first.workspace.root;
  const originalBranch = first.workspace.worktree?.branch;

  await registry.closeWorktree(first.workspace.id, "test: close canonical worktree");

  assert.equal(store.getSession(first.workspace.id)?.status, "closed");
  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);
  await assert.rejects(stat(originalRoot), /ENOENT/);

  const reopenedById = await registry.openWorkspace(
    { workspaceId: first.workspace.id },
    { conversationScopeId: "chat-2" },
  );
  assert.equal(reopenedById.workspace.id, first.workspace.id);
  assert.notEqual(reopenedById.workspace.root, originalRoot);
  assert.notEqual(reopenedById.workspace.worktree?.branch, originalBranch);
  assert.equal(reopenedById.workspace.worktree?.targetBranch, first.workspace.worktree?.targetBranch);
  assert.equal((await stat(reopenedById.workspace.root)).isDirectory(), true);
  assert.equal(store.getSession(first.workspace.id)?.status, "active");

  await registry.closeWorktree(first.workspace.id, "test: close reopened worktree");
  const reopenedBySource = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(reopenedBySource.workspace.id, first.workspace.id);
  assert.notEqual(reopenedBySource.workspace.root, reopenedById.workspace.root);
  await registry.closeWorktree(first.workspace.id, "test: final worktree cleanup");
});

test("concurrent managed-worktree reopen paths share one fresh backing", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const opened = await registry.openWorkspace({ path: project, mode: "worktree" });
  const workspaceId = opened.workspace.id;

  await registry.closeWorktree(workspaceId, "test: close before concurrent reopen");
  const [byId, bySource] = await Promise.all([
    registry.openWorkspace(
      { workspaceId },
      { conversationScopeId: "chat-reopen-id" },
    ),
    registry.openWorkspace(
      { path: project, mode: "worktree" },
      { conversationScopeId: "chat-reopen-source" },
    ),
  ]);

  assert.equal(byId.workspace.id, workspaceId);
  assert.equal(bySource.workspace.id, workspaceId);
  assert.equal(bySource.workspace.root, byId.workspace.root);
  await registry.closeWorktree(workspaceId, "test: cleanup concurrent reopen");
});

test("failed managed-worktree reopen leaves the persistent Workspace closed", async (t) => {
  const { project, registry, store } = await fixture(t, { git: true });
  const opened = await registry.openWorkspace({ path: project, mode: "worktree" });
  const workspaceId = opened.workspace.id;
  const targetBranch = opened.workspace.worktree?.targetBranch;
  assert.ok(targetBranch);

  await registry.closeWorktree(workspaceId, "test: close before failed reopen");
  await git(project, ["switch", "-c", "replacement-target"]);
  await git(project, ["branch", "-D", targetBranch]);

  await assert.rejects(
    registry.openWorkspace({ workspaceId }),
    /baseRef|local branch|managed worktree/i,
  );
  assert.equal(store.getSession(workspaceId)?.status, "closed");
  assert.throws(() => registry.getWorkspace(workspaceId), /Unknown workspaceId/);
});

test("managed-worktree reopen stays closed when context bootstrap fails after backing creation", async (t) => {
  const { project, config, registry, store } = await fixture(t, { git: true });
  const opened = await registry.openWorkspace({ path: project, mode: "worktree" });
  const workspaceId = opened.workspace.id;
  const closedRoot = opened.workspace.root;

  await registry.closeWorktree(workspaceId, "test: close before bootstrap failure");
  await rm(join(project, ".forgerelay", "agents"), { recursive: true, force: true });
  await writeFile(join(project, ".forgerelay", "agents"), "not a directory\n");
  await git(project, ["add", ".forgerelay/agents"]);
  await git(project, ["commit", "-m", "test: break agent profile directory"]);

  await assert.rejects(
    registry.openWorkspace({ workspaceId }),
    /directory|ENOTDIR/i,
  );
  assert.equal(store.getSession(workspaceId)?.status, "closed");
  assert.equal(store.getSession(workspaceId)?.root, closedRoot);
  assert.throws(() => registry.getWorkspace(workspaceId), /Unknown workspaceId/);
  assert.deepEqual(await readdir(config.worktreeRoot), []);
});

test("worktree requests reuse the same worktree without replacing the checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const firstWorktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const secondWorktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(firstWorktree.workspace.id, secondWorktree.workspace.id);
  assert.equal(firstWorktree.workspace.root, secondWorktree.workspace.root);
  assert.equal(secondWorktree.workspaceReused, true);
  assert.equal(secondWorktree.includeBootstrapContext, false);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("worktree reuse follows the actual target branch rather than the HEAD label", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const first = await registry.openWorkspace({ path: project, mode: "worktree" });
  const firstTarget = first.workspace.worktree?.targetBranch;
  assert.ok(firstTarget);

  await git(project, ["switch", "-c", "other-target"]);
  const second = await registry.openWorkspace({ path: project, mode: "worktree" });

  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.notEqual(second.workspace.root, first.workspace.root);
  assert.equal(second.workspace.worktree?.targetBranch, "other-target");
  assert.notEqual(second.workspace.worktree?.targetBranch, firstTarget);
});

test("newWorktree explicitly creates another isolated worktree", async (t) => {
  const { project, registry } = await fixture(t, { git: true });

  const first = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const second = await registry.openWorkspace(
    { path: project, mode: "worktree", newWorktree: true },
    { conversationScopeId: "chat-1" },
  );
  const repeated = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const reopenedFirst = await registry.openWorkspace(
    { path: first.workspace.root, mode: "worktree" },
    { conversationScopeId: "chat-2" },
  );
  const knownWorktrees = await registry.listKnownWorktrees(second.workspace);

  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.notEqual(second.workspace.root, first.workspace.root);
  assert.equal(repeated.workspace.id, second.workspace.id);
  assert.equal(reopenedFirst.workspace.id, first.workspace.id);
  assert.equal(reopenedFirst.workspace.root, first.workspace.root);
  assert.equal(knownWorktrees.length, 2);
  assert.deepEqual(
    new Set(knownWorktrees.map((worktree) => worktree.path)),
    new Set([first.workspace.root, second.workspace.root]),
  );
});

test("a worktree-first conversation creates and then reuses its checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const worktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(checkout.workspace.mode, "checkout");
  assert.notEqual(checkout.workspace.id, worktree.workspace.id);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("concurrent worktree opens across conversations coalesce to one worktree and one Workspace", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const [first, second] = await Promise.all([
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-2" }),
  ]);

  assert.equal(first.workspace.id, second.workspace.id);
  assert.equal(first.workspace.root, second.workspace.root);
  assert.deepEqual(
    [first.includeBootstrapContext, second.includeBootstrapContext],
    [true, true],
  );
  assert.deepEqual(
    first.agentsFiles.map((file) => file.content),
    second.agentsFiles.map((file) => file.content),
  );
});
