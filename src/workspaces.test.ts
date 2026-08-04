import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { ensureCheckoutWorkspaceRoot, WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  if (platform() === "win32") {
    await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  } else {
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(agentDir, "skills", "AGENTS.md"), "global instructions\n");
    await symlink("skills/AGENTS.md", join(agentDir, "AGENTS.md"));
  }
  await writeFile(join(root, "AGENTS.md"), "root instructions\n");
  await mkdir(join(root, ".devspace", "agents"), { recursive: true });
  await writeFile(
    join(root, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only project reviewer.",
      "provider: codex",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "AGENTS.md"), "nested instructions\n");
  await writeFile(join(root, "nested", "file.txt"), "hello\n");

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".devspace-home"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const registry = new WorkspaceRegistry(config);
  const { workspace, agentsFiles, availableAgentsFiles } = await registry.openWorkspace(root);

  assert.equal(workspace.mode, "checkout");
  assert.deepEqual(
    agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );

  assert.deepEqual(
    availableAgentsFiles.map((file) => file.path),
    [join(root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [
      {
        name: "reviewer",
        description: "Read-only project reviewer.",
        provider: "codex",
        body: "Review only.",
      },
    ],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));
    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: root,
      DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(root);
    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["root instructions\n"],
    );
  }

  const missingWorkspaceRoot = join(root, "missing", "workspace");
  const missingWorkspace = await registry.openWorkspace(missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.root, missingWorkspaceRoot);
  assert.equal(missingWorkspace.workspace.mode, "checkout");
  assert.equal((await stat(missingWorkspaceRoot)).isDirectory(), true);

  {
    let mkdirCalls = 0;
    const existingStats = await ensureCheckoutWorkspaceRoot(root, {
      stat: async (path) => {
        assert.equal(path, root);
        return await stat(path);
      },
      mkdir: async () => {
        mkdirCalls += 1;
      },
    });
    assert.equal(existingStats.isDirectory(), true);
    assert.equal(mkdirCalls, 0);
  }

  await assert.rejects(
    () => registry.openWorkspace({ path: root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = join(root, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const worktreeWorkspace = await registry.openWorkspace({
    path: gitRoot,
    mode: "worktree",
  });
  assert.equal(worktreeWorkspace.workspace.mode, "worktree");
  assert.notEqual(worktreeWorkspace.workspace.root, gitRoot);
  assert.match(worktreeWorkspace.workspace.root, /git-project-[a-f0-9]{8}$/);
  assert.equal(worktreeWorkspace.workspace.sourceRoot, gitRoot);
  assert.equal(worktreeWorkspace.workspace.worktree?.baseRef, "HEAD");
  assert.equal(worktreeWorkspace.workspace.worktree?.dirtySource, true);
  assert.equal(worktreeWorkspace.workspace.worktree?.managed, true);
  assert.equal((await stat(worktreeWorkspace.workspace.root)).isDirectory(), true);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(worktreeWorkspace.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const worktreeReadmePath = registry.resolvePath(worktreeWorkspace.workspace, "README.md");
  assert.equal(worktreeReadmePath.startsWith(worktreeWorkspace.workspace.root), true);

  const stateDir = join(root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const persistentRegistry = new WorkspaceRegistry(config, firstStore);
  const persistentWorkspace = await persistentRegistry.openWorkspace(root, {
    conversationScopeId: "chat-checkout",
  });
  const reusedPersistentWorkspace = await persistentRegistry.openWorkspace(root, {
    conversationScopeId: "chat-checkout",
  });
  assert.equal(persistentWorkspace.includeBootstrapContext, true);
  assert.equal(persistentWorkspace.workspaceReused, false);
  assert.equal(reusedPersistentWorkspace.includeBootstrapContext, false);
  assert.equal(reusedPersistentWorkspace.workspaceReused, true);
  assert.equal(reusedPersistentWorkspace.workspace.id, persistentWorkspace.workspace.id);
  assert.deepEqual(
    reusedPersistentWorkspace.agentsFiles.map((file) => file.content),
    persistentWorkspace.agentsFiles.map((file) => file.content),
  );
  assert.deepEqual(
    reusedPersistentWorkspace.availableAgentsFiles,
    persistentWorkspace.availableAgentsFiles,
  );

  const checkoutTargetKey = JSON.stringify(["checkout", await realpath(root), null]);
  firstStore.setConversationBinding({
    conversationScopeId: "chat-context-failure",
    targetKey: checkoutTargetKey,
    workspaceSessionId: persistentWorkspace.workspace.id,
  });

  const projectAgentsDir = join(root, ".devspace", "agents");
  const projectAgentsBackup = join(root, ".devspace", "agents-backup");
  await rename(projectAgentsDir, projectAgentsBackup);
  await writeFile(projectAgentsDir, "not a directory\n");
  try {
    await assert.rejects(
      () => persistentRegistry.openWorkspace(root, { conversationScopeId: "chat-context-failure" }),
      /directory|ENOTDIR/i,
    );
    assert.equal(
      firstStore.getConversationBinding(
        "chat-context-failure",
        checkoutTargetKey,
      )?.workspaceSessionId,
      persistentWorkspace.workspace.id,
    );
  } finally {
    await rm(projectAgentsDir, { force: true });
    await rename(projectAgentsBackup, projectAgentsDir);
  }

  const recoveredContextWorkspace = await persistentRegistry.openWorkspace(root, {
    conversationScopeId: "chat-context-failure",
  });
  assert.equal(recoveredContextWorkspace.workspace.id, persistentWorkspace.workspace.id);
  assert.equal(recoveredContextWorkspace.workspaceReused, true);
  assert.equal(recoveredContextWorkspace.includeBootstrapContext, true);

  const otherConversationWorkspace = await persistentRegistry.openWorkspace(root, {
    conversationScopeId: "chat-checkout-other",
  });
  assert.equal(otherConversationWorkspace.includeBootstrapContext, true);
  assert.equal(otherConversationWorkspace.workspaceReused, false);
  assert.notEqual(otherConversationWorkspace.workspace.id, persistentWorkspace.workspace.id);

  const staleWorkspaceRoot = join(root, "stale-conversation-workspace");
  await mkdir(staleWorkspaceRoot);
  const staleWorkspace = await persistentRegistry.openWorkspace(staleWorkspaceRoot, {
    conversationScopeId: "chat-stale",
  });
  await rm(staleWorkspaceRoot, { recursive: true, force: true });
  const replacementWorkspace = await persistentRegistry.openWorkspace(staleWorkspaceRoot, {
    conversationScopeId: "chat-stale",
  });
  assert.equal(replacementWorkspace.includeBootstrapContext, false);
  assert.equal(replacementWorkspace.workspaceReused, false);
  assert.notEqual(replacementWorkspace.workspace.id, staleWorkspace.workspace.id);
  assert.equal((await stat(staleWorkspaceRoot)).isDirectory(), true);

  const missingTarget = join(root, "missing-canonical-target", "project");
  const missingTargetWorkspace = await persistentRegistry.openWorkspace(missingTarget, {
    conversationScopeId: "chat-missing-canonical",
  });
  assert.equal(
    firstStore.getConversationBinding(
      "chat-missing-canonical",
      JSON.stringify(["checkout", await realpath(missingTarget), null]),
    )?.workspaceSessionId,
    missingTargetWorkspace.workspace.id,
  );
  const missingTargetAgain = await persistentRegistry.openWorkspace(missingTarget, {
    conversationScopeId: "chat-missing-canonical",
  });
  assert.equal(missingTargetAgain.workspace.id, missingTargetWorkspace.workspace.id);
  assert.equal(missingTargetAgain.workspaceReused, true);

  const worktreeInput = { path: gitRoot, mode: "worktree" as const };
  const projectCheckout = await persistentRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "chat-project-modes",
  });
  const firstProjectWorktree = await persistentRegistry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-project-modes",
  });
  const secondProjectWorktree = await persistentRegistry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-project-modes",
  });
  const reusedProjectCheckout = await persistentRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "chat-project-modes",
  });
  assert.equal(projectCheckout.includeBootstrapContext, true);
  assert.equal(projectCheckout.workspaceReused, false);
  assert.equal(firstProjectWorktree.includeBootstrapContext, false);
  assert.equal(firstProjectWorktree.workspaceReused, false);
  assert.equal(secondProjectWorktree.includeBootstrapContext, false);
  assert.equal(secondProjectWorktree.workspaceReused, false);
  assert.notEqual(firstProjectWorktree.workspace.id, projectCheckout.workspace.id);
  assert.notEqual(firstProjectWorktree.workspace.id, secondProjectWorktree.workspace.id);
  assert.notEqual(firstProjectWorktree.workspace.root, secondProjectWorktree.workspace.root);
  assert.equal(reusedProjectCheckout.workspace.id, projectCheckout.workspace.id);
  assert.equal(reusedProjectCheckout.workspaceReused, true);
  assert.equal(reusedProjectCheckout.includeBootstrapContext, false);

  const worktreeFirst = await persistentRegistry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-worktree-first",
  });
  const checkoutAfterWorktree = await persistentRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "chat-worktree-first",
  });
  const reusedCheckoutAfterWorktree = await persistentRegistry.openWorkspace(gitRoot, {
    conversationScopeId: "chat-worktree-first",
  });
  assert.equal(worktreeFirst.includeBootstrapContext, true);
  assert.equal(worktreeFirst.workspaceReused, false);
  assert.equal(checkoutAfterWorktree.includeBootstrapContext, false);
  assert.equal(checkoutAfterWorktree.workspaceReused, false);
  assert.equal(checkoutAfterWorktree.workspace.mode, "checkout");
  assert.notEqual(checkoutAfterWorktree.workspace.id, worktreeFirst.workspace.id);
  assert.equal(reusedCheckoutAfterWorktree.includeBootstrapContext, false);
  assert.equal(reusedCheckoutAfterWorktree.workspaceReused, true);
  assert.equal(reusedCheckoutAfterWorktree.workspace.id, checkoutAfterWorktree.workspace.id);

  const [persistentWorktree, concurrentWorktree] = await Promise.all([
    persistentRegistry.openWorkspace(worktreeInput, {
      conversationScopeId: "chat-worktree-concurrent",
    }),
    persistentRegistry.openWorkspace(worktreeInput, {
      conversationScopeId: "chat-worktree-concurrent",
    }),
  ]);
  assert.notEqual(concurrentWorktree.workspace.id, persistentWorktree.workspace.id);
  assert.notEqual(concurrentWorktree.workspace.root, persistentWorktree.workspace.root);
  assert.equal(persistentWorktree.workspaceReused, false);
  assert.equal(concurrentWorktree.workspaceReused, false);
  const concurrentWorktreeOpens = [persistentWorktree, concurrentWorktree];
  assert.equal(
    concurrentWorktreeOpens.filter((open) => open.includeBootstrapContext).length,
    1,
  );
  assert.deepEqual(
    concurrentWorktree.agentsFiles.map((file) => file.content),
    persistentWorktree.agentsFiles.map((file) => file.content),
  );
  assert.deepEqual(
    concurrentWorktree.availableAgentsFiles.map((file) => file.path.replace(concurrentWorktree.workspace.root, "<root>")),
    persistentWorktree.availableAgentsFiles.map((file) => file.path.replace(persistentWorktree.workspace.root, "<root>")),
  );
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  const restoredRegistry = new WorkspaceRegistry(config, secondStore);
  const restoredWorkspace = restoredRegistry.getWorkspace(persistentWorkspace.workspace.id);
  assert.equal(restoredWorkspace.root, root);
  assert.equal(restoredWorkspace.mode, "checkout");

  const reboundWorkspace = await restoredRegistry.openWorkspace(root, {
    conversationScopeId: "chat-checkout",
  });
  assert.equal(reboundWorkspace.includeBootstrapContext, false);
  assert.equal(reboundWorkspace.workspaceReused, true);
  assert.equal(reboundWorkspace.workspace.id, persistentWorkspace.workspace.id);
  assert.deepEqual(
    reboundWorkspace.agentsFiles.map((file) => file.content),
    persistentWorkspace.agentsFiles.map((file) => file.content),
  );
  assert.deepEqual(reboundWorkspace.availableAgentsFiles, persistentWorkspace.availableAgentsFiles);
  assert.deepEqual(
    reboundWorkspace.workspace.agentProfiles.map((profile) => profile.name),
    persistentWorkspace.workspace.agentProfiles.map((profile) => profile.name),
  );

  const restoredWorktree = restoredRegistry.getWorkspace(persistentWorktree.workspace.id);
  assert.equal(restoredWorktree.mode, "worktree");
  assert.equal(restoredWorktree.sourceRoot, gitRoot);
  assert.equal(restoredWorktree.root, persistentWorktree.workspace.root);
  assert.equal(restoredWorktree.worktree?.managed, true);

  const reboundWorktree = await restoredRegistry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-worktree-concurrent",
  });
  assert.equal(reboundWorktree.includeBootstrapContext, false);
  assert.equal(reboundWorktree.workspaceReused, false);
  assert.notEqual(reboundWorktree.workspace.id, persistentWorktree.workspace.id);
  assert.notEqual(reboundWorktree.workspace.root, persistentWorktree.workspace.root);
  assert.deepEqual(
    reboundWorktree.agentsFiles.map((file) => file.content),
    persistentWorktree.agentsFiles.map((file) => file.content),
  );
  secondStore.close();

  if (platform() !== "win32") {
    const aliasRoot = join(root, "alias-root");
    await symlink(root, aliasRoot, "dir");

    const aliasStateDir = join(root, ".alias-state");
    const aliasStore = new SqliteWorkspaceStore(aliasStateDir);
    const aliasRegistry = new WorkspaceRegistry(config, aliasStore);
    const directConversationWorkspace = await aliasRegistry.openWorkspace(root, {
      conversationScopeId: "chat-alias",
    });
    const aliasedConversationWorkspace = await aliasRegistry.openWorkspace(aliasRoot, {
      conversationScopeId: "chat-alias",
    });
    assert.equal(aliasedConversationWorkspace.includeBootstrapContext, false);
    assert.equal(
      aliasedConversationWorkspace.workspace.id,
      directConversationWorkspace.workspace.id,
    );

    const aliasedStaleRoot = join(aliasRoot, "stale-alias-workspace");
    await mkdir(aliasedStaleRoot);
    const aliasedStaleWorkspace = await aliasRegistry.openWorkspace(aliasedStaleRoot, {
      conversationScopeId: "chat-alias-stale",
    });
    await rm(aliasedStaleRoot, { recursive: true, force: true });
    const aliasedReplacementWorkspace = await aliasRegistry.openWorkspace(aliasedStaleRoot, {
      conversationScopeId: "chat-alias-stale",
    });
    assert.equal(aliasedReplacementWorkspace.includeBootstrapContext, false);
    assert.equal(aliasedReplacementWorkspace.workspaceReused, false);
    assert.notEqual(
      aliasedReplacementWorkspace.workspace.id,
      aliasedStaleWorkspace.workspace.id,
    );
    aliasStore.close();

    const aliasConfig = loadConfig({
      DEVSPACE_ALLOWED_ROOTS: aliasRoot,
      DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
      DEVSPACE_AGENT_DIR: agentDir,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const aliasWorkspace = await new WorkspaceRegistry(aliasConfig).openWorkspace({
      path: join(aliasRoot, "git-project"),
      mode: "worktree",
    });
    assert.equal(aliasWorkspace.workspace.sourceRoot, join(aliasRoot, "git-project"));

    const aliasCheckout = await new WorkspaceRegistry(aliasConfig).openWorkspace(aliasRoot);
    assert.deepEqual(
      aliasCheckout.agentsFiles.map((file) => file.content),
      ["global instructions\n", "root instructions\n"],
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
