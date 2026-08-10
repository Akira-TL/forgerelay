import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("different conversations get stable workspace ids for the same checkout", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });
  const firstAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const secondAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.equal(second.workspace.root, first.workspace.root);
  assert.equal(firstAgain.workspace.id, first.workspace.id);
  assert.equal(secondAgain.workspace.id, second.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
  assert.equal(firstAgain.includeBootstrapContext, false);
  assert.equal(secondAgain.includeBootstrapContext, false);
});

test("an explicit workspace id can be resumed by another conversation", async (t) => {
  const { project, registry } = await fixture(t);

  const original = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const automatic = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });
  assert.notEqual(automatic.workspace.id, original.workspace.id);

  const resumed = await registry.openWorkspace(
    { workspaceId: original.workspace.id },
    { conversationScopeId: "chat-2" },
  );
  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.equal(resumed.workspace.id, original.workspace.id);
  assert.equal(repeated.workspace.id, original.workspace.id);
  assert.equal(resumed.includeBootstrapContext, false);
});

test("newWorkspace explicitly replaces the current conversation handle", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
  const repeated = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(fresh.workspace.id, first.workspace.id);
  assert.equal(fresh.workspace.root, first.workspace.root);
  assert.equal(repeated.workspace.id, fresh.workspace.id);
});

test("a new logical workspace suppresses unchanged bootstrap already delivered to the conversation", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );

  assert.notEqual(fresh.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(fresh.includeBootstrapContext, false);
});

test("closing one logical workspace does not forget delivered project context", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
  assert.equal(fresh.includeBootstrapContext, false);

  registry.closeWorkspace(fresh.workspace.id);
  const resumed = await registry.openWorkspace(
    { workspaceId: first.workspace.id },
    { conversationScopeId: "chat-1" },
  );

  assert.equal(resumed.includeBootstrapContext, false);
});

test("changed project instructions invalidate the delivered bootstrap fingerprint", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const fresh = await registry.openWorkspace(
    { path: project, newWorkspace: true },
    { conversationScopeId: "chat-1" },
  );
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

test("opening a project exposes every session idle for more than two days", async (t) => {
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

  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.workspaceId, old.workspace.id);
  assert.ok((stale[0]?.idleMs ?? 0) >= 2 * 24 * 60 * 60 * 1_000);
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

  assert.ok(restoredStore.getSession(old.workspace.id));
  assert.ok(stale.some((entry) => entry.workspaceId === old.workspace.id));
});

test("an unbound checkout handle is garbage-collected after thirty idle days", async (t) => {
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
  new WorkspaceRegistry(context.config, restoredStore);
  assert.equal(restoredStore.getSession(orphan.workspace.id), undefined);
});

test("closing a checkout workspace removes only that logical handle", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  registry.closeWorkspace(first.workspace.id);

  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);
  assert.equal(registry.getWorkspace(second.workspace.id).root, second.workspace.root);
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

test("concurrent checkout opens reuse one workspace and return matching context", async (t) => {
  const { project, registry } = await fixture(t);

  const opens = await Promise.all([
    registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(project, { conversationScopeId: "chat-1" }),
  ]);

  assert.equal(new Set(opens.map((open) => open.workspace.id)).size, 1);
  assert.deepEqual(opens[0].agentsFiles, opens[1].agentsFiles);
  assert.deepEqual(opens[0].availableAgentsFiles, opens[1].availableAgentsFiles);
});

test("a checkout without a conversation scope still reuses the directory workspace", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project);
  const second = await registry.openWorkspace(project);

  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
});

test("the last logical handle for a worktree cannot be released without close_worktree", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const first = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );

  assert.throws(
    () => registry.closeWorkspace(first.workspace.id),
    /last active handle for a worktree/,
  );

  const alias = await registry.openWorkspace(
    { path: first.workspace.root, mode: "worktree" },
    { conversationScopeId: "chat-2" },
  );
  assert.notEqual(alias.workspace.id, first.workspace.id);
  assert.equal(alias.workspace.root, first.workspace.root);

  registry.closeWorkspace(first.workspace.id);
  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);
  assert.equal(registry.getWorkspace(alias.workspace.id).root, first.workspace.root);
});

test("closing a physical worktree invalidates every logical handle for it", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const first = await registry.openWorkspace(
    { path: project, mode: "worktree" },
    { conversationScopeId: "chat-1" },
  );
  const alias = await registry.openWorkspace(
    { path: first.workspace.root, mode: "worktree" },
    { conversationScopeId: "chat-2" },
  );
  assert.notEqual(alias.workspace.id, first.workspace.id);

  await registry.closeWorktree(first.workspace.id, "test: close aliased worktree");

  assert.throws(() => registry.getWorkspace(first.workspace.id), /Unknown workspaceId/);
  assert.throws(() => registry.getWorkspace(alias.workspace.id), /Unknown workspaceId/);
  await assert.rejects(stat(first.workspace.root), /ENOENT/);
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
  assert.notEqual(reopenedFirst.workspace.id, first.workspace.id);
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

test("concurrent worktree opens coalesce to one worktree and one workspace", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const [first, second] = await Promise.all([
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
  ]);

  assert.equal(first.workspace.id, second.workspace.id);
  assert.equal(first.workspace.root, second.workspace.root);
  assert.deepEqual(
    [first.includeBootstrapContext, second.includeBootstrapContext].sort(),
    [false, true],
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

test("a failed first context load does not consume bootstrap", async (t) => {
  const { project, registry } = await fixture(t);
  const agentsDir = join(project, ".devspace", "agents");
  const backupDir = join(project, ".devspace", "agents-backup");

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
  const agentsDir = join(project, ".devspace", "agents");
  const backupDir = join(project, ".devspace", "agents-backup");

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
    DEVSPACE_CONFIG_DIR: join(context.root, ".alias-config"),
    DEVSPACE_ALLOWED_ROOTS: `${context.root},${macAlias}`,
    DEVSPACE_WORKTREE_ROOT: join(context.root, ".worktrees"),
    DEVSPACE_AGENT_DIR: join(context.root, "agent"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
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

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) await initializeGitRepository(project);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
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
