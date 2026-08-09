import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "./config.js";
import { GitWorktreeError } from "./git-worktrees.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

test("a checkout loads one configured system instruction plus project context", async (t) => {
  const context = await fixture(t);
  const opened = await context.registry.openWorkspace(context.root);

  assert.match(opened.workspace.id, /^ws_[a-f0-9]{10}$/);
  assert.equal(opened.workspace.mode, "checkout");
  assert.deepEqual(
    opened.agentsFiles.map((file) => ({ path: file.path, content: file.content })),
    [
      { path: context.systemInstructionsPath, content: "global instructions\n" },
      { path: join(context.root, "AGENTS.md"), content: "root instructions\n" },
    ],
  );
  assert.deepEqual(
    opened.availableAgentsFiles.map((file) => file.path),
    [join(context.root, "nested", "AGENTS.md")],
  );
  assert.deepEqual(
    opened.workspace.agentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description,
      provider: profile.provider,
      body: profile.body,
    })),
    [{
      name: "reviewer",
      description: "Read-only project reviewer.",
      provider: "codex",
      body: "Review only.",
    }],
  );

  if (platform() !== "win32") {
    const unsafeAgentDir = join(context.root, ".pi", "unsafe-agent");
    await mkdir(unsafeAgentDir, { recursive: true });
    await writeFile(join(context.outsideRoot, "secret.txt"), "outside secret\n");
    await symlink(join(context.outsideRoot, "secret.txt"), join(unsafeAgentDir, "AGENTS.md"));

    const unsafeConfig = loadConfig({
      DEVSPACE_CONFIG_DIR: join(context.root, ".devspace-unsafe-home"),
      DEVSPACE_ALLOWED_ROOTS: context.root,
      DEVSPACE_WORKTREE_ROOT: join(context.root, ".devspace", "unsafe-worktrees"),
      DEVSPACE_AGENT_DIR: unsafeAgentDir,
      DEVSPACE_SYSTEM_INSTRUCTIONS_PATH: context.systemInstructionsPath,
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      PORT: "1",
    });
    const unsafeWorkspace = await new WorkspaceRegistry(unsafeConfig).openWorkspace(context.root);

    assert.deepEqual(
      unsafeWorkspace.agentsFiles.map((file) => file.content),
      ["global instructions\n", "root instructions\n"],
    );
  }
});

test("WorkspaceOpen hook runs once when a workspace session is created", async (t) => {
  const context = await fixture(t);
  const hookScript = join(context.root, "workspace-open-hook.mjs");
  await writeFile(
    hookScript,
    'import { appendFileSync } from "node:fs"; appendFileSync("workspace-open.log", process.env.FORGERELAY_HOOK_EVENT + "\\n");\n',
  );
  const registry = new WorkspaceRegistry({
    ...context.config,
    hooks: {
      WorkspaceOpen: [{ command: `node "${hookScript}"`, timeoutSeconds: 30 }],
    },
  });

  const first = await registry.openWorkspace(context.root);
  const second = await registry.openWorkspace(context.root);

  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(await readFile(join(context.root, "workspace-open.log"), "utf8"), "WorkspaceOpen\n");
});

test("project instruction aliases resolving to the same file are loaded once", async (t) => {
  const context = await fixture(t);
  const aliasPath = join(context.root, "AGENTS.MD");

  try {
    await stat(aliasPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await symlink("AGENTS.md", aliasPath);
  }

  const opened = await context.registry.openWorkspace(context.root);
  assert.deepEqual(
    opened.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

test("opening a missing checkout creates its workspace root", async (t) => {
  const context = await fixture(t);
  const missingRoot = join(context.root, "missing", "workspace");

  const opened = await context.registry.openWorkspace(missingRoot);
  assert.equal(opened.workspace.root, missingRoot);
  assert.equal((await stat(missingRoot)).isDirectory(), true);
});

test("worktree opens require Git and create an isolated managed workspace", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace({ path: context.root, mode: "worktree" }),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_REPOSITORY_NOT_FOUND",
  );

  const gitRoot = await createGitProject(context.root);
  await writeFile(join(gitRoot, "dirty.txt"), "not copied\n");

  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });

  assert.equal(opened.workspace.mode, "worktree");
  assert.notEqual(opened.workspace.root, gitRoot);
  assert.equal(opened.workspace.sourceRoot, gitRoot);
  assert.equal(opened.workspace.worktree?.baseRef, "HEAD");
  assert.equal(opened.workspace.worktree?.dirtySource, true);
  assert.equal(opened.workspace.worktree?.managed, true);
  assert.equal(opened.workspace.worktree?.detached, false);
  assert.match(opened.workspace.worktree?.branch ?? "", /^forgerelay\//);
  assert.equal(
    opened.workspace.worktree?.targetBranch,
    (await gitOutput(gitRoot, ["branch", "--show-current"])).trim(),
  );
  assert.equal(
    (await gitOutput(opened.workspace.root, ["branch", "--show-current"])).trim(),
    opened.workspace.worktree?.branch,
  );
  assert.match(
    await gitOutput(gitRoot, ["worktree", "list", "--porcelain"]),
    new RegExp(`branch refs/heads/${opened.workspace.worktree?.branch}`),
  );
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /global instructions/);
  assert.match(opened.agentsFiles.map((file) => file.content).join("\n"), /git root instructions/);

  const resolvedReadme = context.registry.resolvePath(opened.workspace, "README.md");
  assert.equal(resolvedReadme.startsWith(opened.workspace.root), true);
});

test("closing a managed worktree commits, fast-forwards the target branch, and cleans up", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  const worktreePath = opened.workspace.root;
  const branch = opened.workspace.worktree?.branch;
  const targetBranch = opened.workspace.worktree?.targetBranch;
  assert.ok(branch);
  assert.ok(targetBranch);

  await writeFile(join(worktreePath, "feature.txt"), "finished\n");
  const closed = await context.registry.closeWorktree(opened.workspace.id, "feat: finish managed worktree");

  assert.equal(closed.branch, branch);
  assert.equal(closed.targetBranch, targetBranch);
  assert.equal(closed.committed, true);
  assert.equal(
    (await readFile(join(gitRoot, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "finished\n",
  );
  assert.equal((await gitOutput(gitRoot, ["rev-parse", "HEAD"])).trim(), closed.mergedSha);
  assert.equal((await gitOutput(gitRoot, ["log", "-1", "--pretty=%s"])).trim(), "feat: finish managed worktree");
  await assert.rejects(() => stat(worktreePath), /ENOENT/);
  assert.equal((await gitOutput(gitRoot, ["branch", "--list", branch])).trim(), "");
  assert.throws(() => context.registry.getWorkspace(opened.workspace.id), /Unknown workspaceId/);
});

test("worktree close hooks block before integration and observe successful close", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const beforeScript = join(gitRoot, "before-close.mjs");
  const afterScript = join(gitRoot, "after-close.mjs");
  await writeFile(
    beforeScript,
    'import { appendFileSync } from "node:fs"; appendFileSync("close-hooks.log", "before\\n"); if (process.env.FORGERELAY_HOOK_PAYLOAD?.includes("deny")) process.exit(12);\n',
  );
  await writeFile(
    afterScript,
    'import { appendFileSync } from "node:fs"; appendFileSync("close-hooks.log", "after\\n");\n',
  );
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Add hook fixtures"]);

  const blockingRegistry = new WorkspaceRegistry({
    ...context.config,
    hooks: {
      BeforeWorktreeClose: [{ command: `node "${beforeScript}"`, timeoutSeconds: 30 }],
    },
  });
  const blocked = await blockingRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(blocked.workspace.root, "feature.txt"), "blocked\n");

  await assert.rejects(
    () => blockingRegistry.closeWorktree(blocked.workspace.id, "deny close"),
    /BeforeWorktreeClose handler 1 exited with code 12/,
  );
  assert.equal((await stat(blocked.workspace.root)).isDirectory(), true);
  assert.equal((await gitOutput(gitRoot, ["status", "--porcelain=v1"])).trim(), "");

  const observingRegistry = new WorkspaceRegistry({
    ...context.config,
    hooks: {
      BeforeWorktreeClose: [{ command: `node "${beforeScript}"`, timeoutSeconds: 30 }],
      AfterWorktreeClose: [{ command: `node "${afterScript}"`, timeoutSeconds: 30 }],
    },
  });
  const opened = await observingRegistry.openWorkspace({ path: gitRoot, mode: "worktree", newWorktree: true });
  await writeFile(join(opened.workspace.root, "feature.txt"), "finished\n");
  await observingRegistry.closeWorktree(opened.workspace.id, "feat: close with hooks");

  assert.equal(
    (await readFile(join(gitRoot, "close-hooks.log"), "utf8")).replace(/\r\n/g, "\n"),
    "before\nafter\n",
  );
});

test("closing a managed worktree refuses a dirty source checkout and preserves the worktree", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(opened.workspace.root, "feature.txt"), "finished\n");
  await writeFile(join(gitRoot, "local.txt"), "user work\n");

  await assert.rejects(
    () => context.registry.closeWorktree(opened.workspace.id, "feat: should not merge"),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_SOURCE_DIRTY",
  );

  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.equal((await readFile(join(opened.workspace.root, "feature.txt"), "utf8")), "finished\n");
  assert.equal((await gitOutput(gitRoot, ["status", "--porcelain=v1"])).includes("local.txt"), true);
});

test("closing a diverged worktree never puts the source checkout into a merge conflict", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const opened = await context.registry.openWorkspace({ path: gitRoot, mode: "worktree" });
  await writeFile(join(opened.workspace.root, "worktree.txt"), "worktree change\n");

  await writeFile(join(gitRoot, "source.txt"), "source change\n");
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "source advances"]);
  const sourceHead = (await gitOutput(gitRoot, ["rev-parse", "HEAD"])).trim();

  await assert.rejects(
    () => context.registry.closeWorktree(opened.workspace.id, "feat: worktree change"),
    (error: unknown) =>
      error instanceof GitWorktreeError && error.code === "GIT_WORKTREE_DIVERGED",
  );

  assert.equal((await gitOutput(gitRoot, ["rev-parse", "HEAD"])).trim(), sourceHead);
  assert.equal((await gitOutput(gitRoot, ["status", "--porcelain=v1"])).trim(), "");
  assert.equal((await stat(opened.workspace.root)).isDirectory(), true);
  assert.equal((await gitOutput(opened.workspace.root, ["log", "-1", "--pretty=%s"])).trim(), "feat: worktree change");
});

test("persisted checkout and worktree sessions restore after recreating the registry", async (t) => {
  const context = await fixture(t);
  const gitRoot = await createGitProject(context.root);
  const stateDir = join(context.root, ".state");
  const firstStore = new SqliteWorkspaceStore(stateDir);
  const firstRegistry = new WorkspaceRegistry(context.config, firstStore);

  const checkout = await firstRegistry.openWorkspace(context.root);
  const worktree = await firstRegistry.openWorkspace({ path: gitRoot, mode: "worktree" });
  firstStore.close();

  const secondStore = new SqliteWorkspaceStore(stateDir);
  try {
    const restoredRegistry = new WorkspaceRegistry(context.config, secondStore);
    const restoredCheckout = restoredRegistry.getWorkspace(checkout.workspace.id);
    const restoredWorktree = restoredRegistry.getWorkspace(worktree.workspace.id);

    assert.equal(restoredCheckout.root, context.root);
    assert.equal(restoredCheckout.mode, "checkout");
    assert.equal(restoredWorktree.root, worktree.workspace.root);
    assert.equal(restoredWorktree.mode, "worktree");
    assert.equal(restoredWorktree.sourceRoot, gitRoot);
    assert.equal(restoredWorktree.worktree?.managed, true);
    assert.equal(restoredWorktree.worktree?.detached, false);
    assert.equal(restoredWorktree.worktree?.branch, worktree.workspace.worktree?.branch);
    assert.equal(restoredWorktree.worktree?.targetBranch, worktree.workspace.worktree?.targetBranch);
  } finally {
    secondStore.close();
  }
});

test("workspace paths outside the allowed roots are rejected", async (t) => {
  const context = await fixture(t);

  await assert.rejects(
    () => context.registry.openWorkspace(context.outsideRoot),
    /outside allowed roots/,
  );
});

test("a symlinked allowed root preserves checkout and worktree path behavior", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t);
  const aliasRoot = join(context.root, "alias-root");
  await symlink(context.root, aliasRoot, "dir");
  await createGitProject(context.root);

  const aliasConfig = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: aliasRoot,
    DEVSPACE_WORKTREE_ROOT: join(aliasRoot, ".devspace", "alias-worktrees"),
    DEVSPACE_AGENT_DIR: context.agentDir,
    DEVSPACE_SYSTEM_INSTRUCTIONS_PATH: context.systemInstructionsPath,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const aliasRegistry = new WorkspaceRegistry(aliasConfig);

  const worktree = await aliasRegistry.openWorkspace({
    path: join(aliasRoot, "git-project"),
    mode: "worktree",
  });
  const checkout = await aliasRegistry.openWorkspace(aliasRoot);

  assert.equal(worktree.workspace.sourceRoot, join(aliasRoot, "git-project"));
  assert.deepEqual(
    checkout.agentsFiles.map((file) => file.content),
    ["global instructions\n", "root instructions\n"],
  );
});

interface WorkspaceFixture {
  root: string;
  outsideRoot: string;
  agentDir: string;
  systemInstructionsPath: string;
  config: ServerConfig;
  registry: WorkspaceRegistry;
}

async function fixture(t: TestContext): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-test-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "devspace-workspace-outside-test-"));
  const agentDir = join(root, ".pi", "agent");
  const systemInstructionsPath = join(root, ".agents", "AGENTS.md");

  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "legacy agent-dir instructions\n");
  await mkdir(join(root, ".agents"), { recursive: true });

  if (platform() === "win32") {
    await writeFile(systemInstructionsPath, "global instructions\n");
  } else {
    const canonicalInstructionsDir = join(outsideRoot, "core");
    const canonicalInstructionsPath = join(canonicalInstructionsDir, "AGENTS.md");
    await mkdir(canonicalInstructionsDir, { recursive: true });
    await writeFile(canonicalInstructionsPath, "global instructions\n");
    await symlink(canonicalInstructionsPath, systemInstructionsPath);
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
    DEVSPACE_SYSTEM_INSTRUCTIONS_PATH: systemInstructionsPath,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  return {
    root,
    outsideRoot,
    agentDir,
    systemInstructionsPath,
    config,
    registry: new WorkspaceRegistry(config),
  };
}

async function createGitProject(parent: string): Promise<string> {
  const gitRoot = join(parent, "git-project");
  await mkdir(gitRoot);
  await writeFile(join(gitRoot, "AGENTS.md"), "git root instructions\n");
  await writeFile(join(gitRoot, "README.md"), "hello\n");
  await git(gitRoot, ["init"]);
  await git(gitRoot, ["config", "user.email", "devspace@example.com"]);
  await git(gitRoot, ["config", "user.name", "DevSpace Test"]);
  await git(gitRoot, ["add", "."]);
  await git(gitRoot, ["commit", "-m", "Initial commit"]);
  return gitRoot;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
