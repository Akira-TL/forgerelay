import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a conversation reuses its checkout and receives bootstrap once", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(first.workspaceReused, false);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.workspaceReused, true);
  assert.equal(second.includeBootstrapContext, false);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.deepEqual(second.agentsFiles, first.agentsFiles);
  assert.deepEqual(second.availableAgentsFiles, first.availableAgentsFiles);
  assert.deepEqual(
    second.workspace.agentProfiles.map((profile) => profile.name),
    first.workspace.agentProfiles.map((profile) => profile.name),
  );
});

test("different conversations receive separate checkout workspaces", async (t) => {
  const { project, registry } = await fixture(t);

  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(project, { conversationScopeId: "chat-2" });

  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.includeBootstrapContext, true);
  assert.equal(first.workspaceReused, false);
  assert.equal(second.workspaceReused, false);
});

test("worktree requests remain fresh without replacing the reusable checkout", async (t) => {
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

  assert.equal(checkout.includeBootstrapContext, true);
  assert.equal(firstWorktree.includeBootstrapContext, false);
  assert.equal(secondWorktree.includeBootstrapContext, false);
  assert.equal(firstWorktree.workspaceReused, false);
  assert.equal(secondWorktree.workspaceReused, false);
  assert.notEqual(firstWorktree.workspace.id, secondWorktree.workspace.id);
  assert.notEqual(firstWorktree.workspace.root, secondWorktree.workspace.root);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
  assert.equal(checkoutAgain.workspaceReused, true);
  assert.equal(checkoutAgain.includeBootstrapContext, false);
});

test("a worktree-first conversation creates and then reuses its checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const worktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const checkoutAgain = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.equal(worktree.includeBootstrapContext, true);
  assert.equal(worktree.workspaceReused, false);
  assert.equal(checkout.includeBootstrapContext, false);
  assert.equal(checkout.workspaceReused, false);
  assert.equal(checkout.workspace.mode, "checkout");
  assert.notEqual(checkout.workspace.id, worktree.workspace.id);
  assert.equal(checkoutAgain.includeBootstrapContext, false);
  assert.equal(checkoutAgain.workspaceReused, true);
  assert.equal(checkoutAgain.workspace.id, checkout.workspace.id);
});

test("concurrent worktree opens claim bootstrap exactly once and return complete context", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const [first, second] = await Promise.all([
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
    registry.openWorkspace(worktreeInput, { conversationScopeId: "chat-1" }),
  ]);

  assert.equal([first, second].filter((open) => open.includeBootstrapContext).length, 1);
  assert.equal(first.workspaceReused, false);
  assert.equal(second.workspaceReused, false);
  assert.notEqual(first.workspace.id, second.workspace.id);
  assert.notEqual(first.workspace.root, second.workspace.root);
  assert.deepEqual(
    first.agentsFiles.map((file) => file.content),
    second.agentsFiles.map((file) => file.content),
  );
  assert.deepEqual(
    first.availableAgentsFiles.map((file) => file.path.replace(first.workspace.root, "<root>")),
    second.availableAgentsFiles.map((file) => file.path.replace(second.workspace.root, "<root>")),
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
  assert.equal(restored.workspaceReused, true);
  assert.equal(restored.includeBootstrapContext, false);
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
  assert.equal(successfulOpen.includeBootstrapContext, true);
  assert.equal(successfulOpen.workspaceReused, false);
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
  assert.equal(recovered.workspaceReused, true);
  assert.equal(recovered.includeBootstrapContext, false);
});

test("a deleted checkout is replaced without repeating bootstrap", async (t) => {
  const { project, registry } = await fixture(t);
  const first = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  await rm(project, { recursive: true, force: true });
  const replacement = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });

  assert.notEqual(replacement.workspace.id, first.workspace.id);
  assert.equal(replacement.workspaceReused, false);
  assert.equal(replacement.includeBootstrapContext, false);
  assert.equal((await stat(project)).isDirectory(), true);
});

test("canonical checkout identity remains stable when the requested target starts missing", async (t) => {
  const { project, registry } = await fixture(t);
  const missingTarget = join(project, "generated", "checkout");

  const first = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });
  const second = await registry.openWorkspace(missingTarget, { conversationScopeId: "chat-1" });

  assert.equal(first.workspace.root, missingTarget);
  assert.equal(first.includeBootstrapContext, true);
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.workspaceReused, true);
  assert.equal(second.includeBootstrapContext, false);
});

test("canonical checkout identity survives symlink aliases", { skip: platform() === "win32" }, async (t) => {
  const { root, project, registry } = await fixture(t);
  const alias = join(root, "project-alias");
  await symlink(project, alias, "dir");

  const direct = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const aliased = await registry.openWorkspace(alias, { conversationScopeId: "chat-1" });

  assert.equal(aliased.workspace.id, direct.workspace.id);
  assert.equal(aliased.workspaceReused, true);
  assert.equal(aliased.includeBootstrapContext, false);
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
  assert.equal(replacement.workspaceReused, false);
  assert.equal(replacement.includeBootstrapContext, false);
});

test("unexpected storage errors are not mistaken for stale bindings", async (t) => {
  const context = await fixture(t);
  await context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" });
  context.closeStore(context.store);

  await assert.rejects(
    () => context.registry.openWorkspace(context.project, { conversationScopeId: "chat-1" }),
    (error: unknown) => error instanceof Error && /database connection is not open/i.test(error.message),
  );
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
