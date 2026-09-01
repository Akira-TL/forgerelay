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

const execFileAsync = promisify(execFile);

test("a conversation reuses its checkout context", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(second.workspace.id, first.workspace.id);
  assert.deepEqual(second.agentsFiles, first.agentsFiles);
  assert.deepEqual(second.availableAgentsFiles, first.availableAgentsFiles);
  assert.deepEqual(second.workspace.skills, first.workspace.skills);
  assert.deepEqual(second.workspace.skillDiagnostics, first.workspace.skillDiagnostics);
  assert.deepEqual(second.workspace.agentProfiles, first.workspace.agentProfiles);
});

test("different conversations share one canonical workspace id for the same checkout", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });
  const firstAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const secondAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.workspace.root, first.workspace.root);
  assert.equal(firstAgain.workspace.id, first.workspace.id);
  assert.equal(secondAgain.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
  assert.equal(firstAgain.includeBootstrapContext, false);
  assert.equal(secondAgain.includeBootstrapContext, false);
});

test("an explicit workspace id can be resumed by another conversation", async (t) => {
  const { project, registry } = await fixture(t);

  const original = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const automatic = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });
  assert.equal(automatic.workspace.id, original.workspace.id);

  const resumed = await registry.openWorkspace(
    { workspaceId: original.workspace.id },
    { conversationScopeId: "chat-2" },
  );
  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.equal(resumed.workspace.id, original.workspace.id);
  assert.equal(repeated.workspace.id, original.workspace.id);
  assert.equal(resumed.includeBootstrapContext, false);
});

test("newWorkspace compatibility no longer creates a duplicate checkout identity", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const compatible = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(compatible.workspace.id, first.workspace.id);
  assert.equal(compatible.workspace.root, first.workspace.root);
  assert.equal(repeated.workspace.id, first.workspace.id);
});

test("newWorkspace compatibility suppresses unchanged bootstrap already delivered to the conversation", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );

  assert.equal(fresh.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(fresh.includeBootstrapContext, false);
});

test("closing the current checkout preserves identity and delivered project context", async (t) => {
  const { project, registry, store } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const compatible = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(compatible.workspace.id, first.workspace.id);
  assert.equal(compatible.includeBootstrapContext, false);

  registry.closeWorkspace(compatible.workspace.id);
  assert.equal(store.getSession(first.workspace.id)?.status, "closed");
  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);

  const reopened = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(reopened.workspace.id, first.workspace.id);
  assert.equal(reopened.includeBootstrapContext, false);
  assert.equal(store.getSession(first.workspace.id)?.status, "active");
});

test("changed project instructions invalidate the delivered bootstrap fingerprint", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(fresh.workspace.id, first.workspace.id);
  assert.equal(fresh.includeBootstrapContext, false);

  await writeFile(join(project, "AGENTS.md"), "updated project instructions\n");
  const refreshed = await registry.openWorkspace(
    { workspaceId: fresh.workspace.id },
    { conversationScopeId: "chat-1" },
  );

  assert.notEqual(refreshed.contextFingerprint, first.contextFingerprint);
  assert.equal(refreshed.includeBootstrapContext, true);
  assert.equal(refreshed.agentsFiles.some((file) => file.content.includes("updated project instructions")), true);
});

test("bootstrap context policy can skip automatic delivery and force a refresh", async (t) => {
  const { project, registry } = await fixture(t);

  const skipped = await registry.openWorkspace(
    { path: project, context: "none" },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(skipped.includeBootstrapContext, false);

  const automatic = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(automatic.workspace.id, skipped.workspace.id);
  assert.equal(automatic.includeBootstrapContext, true);

  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(repeated.includeBootstrapContext, false);

  const forced = await registry.openWorkspace(
    { workspaceId: repeated.workspace.id, context: "full" },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(forced.includeBootstrapContext, true);
});

test("reopening a stale checkout reuses its canonical Workspace instead of exposing a duplicate handle", async (t) => {
  const context = await fixture(t);
  const old = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-old" });
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(), old.workspace.id);
  } finally {
    database.close();
  }

  const current = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-current",
  });
  const stale = await context.registry.listStaleWorkspaces(current.workspace);

  assert.equal(current.workspace.id, old.workspace.id);
  assert.deepEqual(stale, []);
});

test("a bound workspace stays recoverable after thirty idle days", async (t) => {
  const context = await fixture(t);
  const old = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-old" });
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), old.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const current = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-current",
  });
  const stale = await restoredRegistry.listStaleWorkspaces(current.workspace);

  assert.equal(current.workspace.id, old.workspace.id);
  assert.ok(restoredStore.getSession(old.workspace.id));
  assert.deepEqual(stale, []);
});

test("an unbound checkout Workspace identity survives thirty idle days", async (t) => {
  const context = await fixture(t);
  const orphan = await context.registry.openWorkspace(context.project);
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), orphan.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const reopened = await restoredRegistry.openWorkspace(context.project);
  assert.equal(reopened.workspace.id, orphan.workspace.id);
  assert.ok(restoredStore.getSession(orphan.workspace.id));
});

test("closing the canonical checkout keeps one closed Workspace that can reopen by id or path", async (t) => {
  const { project, registry, store } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });
  assert.equal(second.workspace.id, first.workspace.id);

  registry.closeWorkspace(first.workspace.id);

  assert.equal(store.getSession(first.workspace.id)?.status, "closed");
  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);
  const closedInventory = await registry.listWorkspaces({ workspaceId: first.workspace.id });
  assert.equal(closedInventory.workspaces[0]?.state, "closed");
  assert.equal(closedInventory.workspaces[0]?.workspaceId, first.workspace.id);

  const reopenedById = await registry.openWorkspace(
    { workspaceId: first.workspace.id },
    { conversationScopeId: "chat-2" },
  );
  assert.equal(reopenedById.workspace.id, first.workspace.id);
  registry.closeWorkspace(first.workspace.id);

  const reopenedByPath = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(reopenedByPath.workspace.id, first.workspace.id);
});

test("deleting a closed checkout removes ForgeRelay identity without touching project files", async (t) => {
  const { project, registry, store } = await fixture(t);
  const sentinel = join(project, "keep-me.txt");
  await writeFile(sentinel, "preserve checkout\n");
  const opened = await registry.openWorkspace(project, { conversationScopeId: "chat-delete" });

  registry.closeWorkspace(opened.workspace.id);
  registry.deleteWorkspace(opened.workspace.id);

  assert.equal(store.getSession(opened.workspace.id), undefined);
  assert.equal((await stat(project)).isDirectory(), true);
  assert.equal((await stat(sentinel)).isFile(), true);
  const reopened = await registry.openWorkspace(project, { conversationScopeId: "chat-delete" });
  assert.notEqual(reopened.workspace.id, opened.workspace.id);
});

test("conversation bindings distinguish canonical projects", async (t) => {
  const { root, project, registry } = await fixture(t);
  const otherProject = join(root, "other-project");
  await mkdir(otherProject);
  await writeFile(join(otherProject, "AGENTS.md"), "other project instructions\n");

  const firstProjectOpen = await registry.openWorkspace(project, {
    conversationScopeId: "chat-1",
  });
  const otherProjectOpen = await registry.openWorkspace(otherProject, {
    conversationScopeId: "chat-1",
  });
  const repeatedProjectOpen = await registry.openWorkspace(project, {
    conversationScopeId: "chat-1",
  });
  const repeatedOtherProjectOpen = await registry.openWorkspace(otherProject, {
    conversationScopeId: "chat-1",
  });

  assert.equal(repeatedProjectOpen.workspace.id, firstProjectOpen.workspace.id);
  assert.equal(repeatedOtherProjectOpen.workspace.id, otherProjectOpen.workspace.id);
  assert.notEqual(otherProjectOpen.workspace.id, firstProjectOpen.workspace.id);
});

test("concurrent checkout opens across conversations coalesce to one Workspace identity", async (t) => {
  const { project, registry } = await fixture(t);

  const opens = await Promise.all([
    registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(project, { conversationScopeId: "chat-2" }),
  ]);

  assert.equal(new Set(opens.map((open) => open.workspace.id)).size, 1);
  assert.deepEqual(opens[0].agentsFiles, opens[1].agentsFiles);
  assert.deepEqual(opens[0].availableAgentsFiles, opens[1].availableAgentsFiles);
  assert.deepEqual(opens.map((open) => open.includeBootstrapContext), [true, true]);
});

test("a checkout without a conversation scope still reuses the directory workspace", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project);
  const second = await registry.openWorkspace(project);

  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
});

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

test("checkout reuse survives a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const restored = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.equal(restored.workspace.id, first.workspace.id);
});

test("legacy duplicate checkout records fold to one canonical Workspace with alias compatibility", async (t) => {
  const context = await fixture(t);
  const original = await context.registry.openWorkspace(context.project);
  const canonicalId = original.workspace.id;
  const legacyAliasId = "ws_aaaaaaaaaa";
  const targetKey = checkoutTargetKey(await realpath(context.project));
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      update workspace_sessions
         set status = 'inactive', created_at = ?, last_used_at = ?
       where id = ?
    `).run("2026-08-20T00:00:00.000Z", "2026-08-21T00:00:00.000Z", canonicalId);
    database.sqlite.prepare(`
      insert into workspace_sessions (
        id, root, status, mode, managed, created_at, last_used_at
      ) values (?, ?, 'active', 'checkout', 'false', ?, ?)
    `).run(
      legacyAliasId,
      context.project,
      "2026-08-22T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
    database.sqlite.prepare(`
      insert into workspace_conversation_bindings (
        conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at
      ) values (?, ?, ?, ?, ?)
    `).run(
      "chat-legacy-alias",
      targetKey,
      legacyAliasId,
      "2026-08-22T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const sessions = restoredStore.listSessions({ mode: "checkout" })
    .filter((session) => session.root === context.project);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, canonicalId);
  assert.equal(sessions[0]?.createdAt, "2026-08-20T00:00:00.000Z");
  assert.equal(sessions[0]?.lastUsedAt, "2026-08-25T00:00:00.000Z");
  assert.equal(sessions[0]?.status, "active");
  assert.equal(restoredStore.getSession(legacyAliasId)?.id, canonicalId);
  assert.equal(
    restoredStore.getConversationBinding("chat-legacy-alias", targetKey)?.workspaceSessionId,
    canonicalId,
  );

  const reopenedAlias = await restoredRegistry.openWorkspace(
    { workspaceId: legacyAliasId },
    { conversationScopeId: "chat-reopen-legacy-alias" },
  );
  assert.equal(reopenedAlias.workspace.id, canonicalId);

  restoredRegistry.closeWorkspace(legacyAliasId);
  assert.throws(() => restoredRegistry.getWorkspace(canonicalId), /Unknown workspaceId/);
  assert.throws(() => restoredRegistry.getWorkspace(legacyAliasId), /Unknown workspaceId/);
});

test("a failed first context load does not consume bootstrap", async (t) => {
  const { project, registry } = await fixture(t);
  const agentsDir = join(project, ".forgerelay", "agents");
  const backupDir = join(project, ".forgerelay", "agents-backup");

  await breakAgentsDirectory(agentsDir, backupDir);
  try {
    await assert.rejects(
      () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
      /directory|ENOTDIR/i,
    );
  } finally {
    await restoreAgentsDirectory(agentsDir, backupDir);
  }

  const successfulOpen = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
});

test("a context-loading failure preserves a valid checkout binding", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const agentsDir = join(project, ".forgerelay", "agents");
  const backupDir = join(project, ".forgerelay", "agents-backup");

  await breakAgentsDirectory(agentsDir, backupDir);
  try {
    await assert.rejects(
      () => registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
      /directory|ENOTDIR/i,
    );
  } finally {
    await restoreAgentsDirectory(agentsDir, backupDir);
  }

  const recovered = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  assert.equal(recovered.workspace.id, first.workspace.id);
});

test("a deleted checkout is replaced with a new workspace", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  await rm(project, { recursive: true, force: true });
  const replacement = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
  assert.equal((await stat(project)).isDirectory(), true);
});

test("canonical checkout identity remains stable when the requested target starts missing", async (t) => {
  const { project, registry } = await fixture(t);
  const missingTarget = join(project, "generated", "checkout");

  const first = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });

  assert.equal(first.workspace.root, missingTarget);
  assert.equal(second.workspace.id, first.workspace.id);
});

test("canonical checkout identity survives equivalent path and symlink aliases", async (t) => {
  const { root, project, registry } = await fixture(t);

  const direct = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const equivalent = await registry.openWorkspace(join(project, "..", "project"), {
    conversationScopeId: "chat-1",
  });

  assert.equal(equivalent.workspace.id, direct.workspace.id);

  if (platform() === "win32") return;

  const alias = join(root, "project-alias");
  await symlink(project, alias, "dir");
  const aliased = await registry.openWorkspace(alias, { conversationScopeId: "chat-1" });

  assert.equal(aliased.workspace.id, direct.workspace.id);
});

test("canonical checkout identity survives macOS var path aliases", { skip: platform() !== "darwin" }, async (t) => {
  const context = await fixture(t);
  const macAlias = context.root.startsWith("/private/var/")
    ? `/var/${context.root.slice("/private/var/".length)}`
    : context.root.startsWith("/var/")
      ? `/private/var/${context.root.slice("/var/".length)}`
      : undefined;
  if (!macAlias) {
    t.skip("temporary directory is not under /var");
    return;
  }

  const aliasConfig = loadConfig({
    FORGERELAY_CONFIG_DIR: join(context.root, ".alias-config"),
    FORGERELAY_ALLOWED_ROOTS: `${context.root},${macAlias}`,
    FORGERELAY_WORKTREE_ROOT: join(context.root, ".worktrees"),
    FORGERELAY_AGENT_DIR: join(context.root, "agent"),
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const aliasRegistry = new WorkspaceRegistry(aliasConfig, context.store);

  const direct = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  const aliased = await aliasRegistry.openWorkspace(
    `${macAlias}/${context.project.slice(context.root.length + 1)}`,
    { conversationScopeId: "chat-1" },
  );

  assert.equal(aliased.workspace.id, direct.workspace.id);
});

test("an invalid persisted checkout binding is not reused", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set mode = 'worktree' where id = ?")
      .run(first.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  const replacement = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
});

test("an inactive persisted checkout binding is not reused", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set status = 'inactive' where id = ?")
      .run(first.workspace.id);
  } finally {
    database.close();
  }

  const restoredRegistry = new WorkspaceRegistry(context.config, context.openStore());
  const replacement = await restoredRegistry.openWorkspace(context.project, {
    conversationScopeId: "chat-1",
  });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
});

test("a checkout replaced by a file reports the filesystem error", async (t) => {
  const context = await fixture(t);
  const target = join(context.root, "file-target");
  await context.registry.openWorkspace(target, { conversationScopeId: "chat-1" });
  await rm(target, { recursive: true, force: true });
  await writeFile(target, "not a directory\n");

  await assert.rejects(
    () => context.registry.openWorkspace(target, { conversationScopeId: "chat-1" }),
    /Workspace root must be a directory/,
  );
});

test("unexpected storage errors are not mistaken for stale bindings", async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" });
  const targetKey = checkoutTargetKey(await realpath(context.project));
  context.closeStore(context.store);

  await assert.rejects(
    () => context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" }),
  );

  const restoredStore = context.openStore();
  assert.equal(
    restoredStore.getConversationBinding("chat-1", targetKey)?.workspaceSessionId,
    first.workspace.id,
  );
});

test("unexpected filesystem errors are propagated without replacing the binding", {
  skip: platform() === "win32",
}, async (t) => {
  const context = await fixture(t);
  const first = await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" });
  const targetKey = checkoutTargetKey(await realpath(context.project));
  const loopA = join(context.root, "loop-a");
  const loopB = join(context.root, "loop-b");

  await symlink(loopB, loopA, "dir");
  await symlink(loopA, loopB, "dir");
  context.closeStore(context.store);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set root = ? where id = ?")
      .run(loopA, first.workspace.id);
  } finally {
    database.close();
  }

  const restoredStore = context.openStore();
  const restoredRegistry = new WorkspaceRegistry(context.config, restoredStore);
  await assert.rejects(
    () => restoredRegistry.openWorkspace(context.project, { conversationScopeId: "chat-1" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ELOOP",
  );

  const binding = restoredStore.getConversationBinding("chat-1", targetKey);
  assert.equal(binding?.workspaceSessionId, first.workspace.id);
  assert.equal(restoredStore.getSession(first.workspace.id)?.root, loopA);
});

interface WorkspaceFixture {
  root: string;
  project: string;
  stateDir: string;
  config: ServerConfig;
  store: SqliteWorkspaceStore;
  registry: WorkspaceRegistry;
  openStore: () => SqliteWorkspaceStore;
  closeStore: (store: SqliteWorkspaceStore) => void;
}

async function fixture(
  t: TestContext,
  options: { git?: boolean } = {},
): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-conversation-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  const stores = new Set<SqliteWorkspaceStore>();

  await mkdir(join(project, ".forgerelay", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) await initializeGitRepository(project);

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_AGENT_DIR: agentDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const openStore = () => {
    const store = new SqliteWorkspaceStore(stateDir);
    stores.add(store);
    return store;
  };
  const closeStore = (store: SqliteWorkspaceStore) => {
    if (stores.delete(store)) store.close();
  };
  const store = openStore();

  t.after(async () => {
    for (const openStore of stores) openStore.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    stateDir,
    config,
    store,
    registry: new WorkspaceRegistry(config, store),
    openStore,
    closeStore,
  };
}

async function breakAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rename(agentsDir, backupDir);
  await writeFile(agentsDir, "not a directory\n");
}

async function restoreAgentsDirectory(agentsDir: string, backupDir: string): Promise<void> {
  await rm(agentsDir, { force: true });
  await rename(backupDir, agentsDir);
}

async function initializeGitRepository(root: string): Promise<void> {
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function checkoutTargetKey(project: string): string {
  return JSON.stringify(["checkout", project, null]);
}
