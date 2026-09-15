import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadConfig, type ServerConfig } from "../runtime/config/config.js";
import { openDatabase } from "../runtime/state/db/client.js";
import { SqliteWorkspaceStore } from "./state/workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";
import {
  checkoutTargetKey,
  fixture,
  git,
} from "./conversation-test-support.js";

const execFileAsync = promisify(execFile);

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

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

test("pinned managed-worktree Workspace reopens from the current target branch", async (t) => {
  const { project, registry, store } = await fixture(t, { git: true });
  const targetBranch = await gitOutput(project, ["branch", "--show-current"]);
  const historicalSha = await gitOutput(project, ["rev-parse", "HEAD"]);
  await writeFile(join(project, "target-before-open.txt"), "target before open\n");
  await git(project, ["add", "target-before-open.txt"]);
  await git(project, ["commit", "-m", "Advance target before pinned open"]);

  const opened = await registry.openWorkspace({ path: project, mode: "worktree", baseRef: historicalSha });
  const workspaceId = opened.workspace.id;
  const oldRoot = opened.workspace.root;
  await writeFile(join(oldRoot, "pinned-work.txt"), "pinned work\n");
  await git(oldRoot, ["add", "pinned-work.txt"]);
  await git(oldRoot, ["commit", "-m", "Pinned work"]);
  await git(oldRoot, ["rebase", targetBranch]);

  const activeInspection = await registry.inspectWorkspace(workspaceId);
  assert.equal(activeInspection.baseRef, historicalSha);
  assert.equal(activeInspection.baseSha, historicalSha);
  assert.equal(activeInspection.targetBranch, targetBranch);

  await registry.closeWorktree(workspaceId, "test: close pinned worktree");
  assert.equal(store.getSession(workspaceId)?.status, "closed");
  const closedInspection = await registry.inspectWorkspace(workspaceId);
  assert.equal(closedInspection.baseRef, historicalSha);
  assert.equal(closedInspection.baseSha, historicalSha);

  await writeFile(join(project, "target-after-close.txt"), "target after close\n");
  await git(project, ["add", "target-after-close.txt"]);
  await git(project, ["commit", "-m", "Advance target after pinned close"]);
  const latestTargetSha = await gitOutput(project, ["rev-parse", "HEAD"]);

  const reopened = await registry.openWorkspace({ workspaceId });
  assert.equal(reopened.workspace.id, workspaceId);
  assert.notEqual(reopened.workspace.root, oldRoot);
  assert.equal(reopened.workspace.worktree?.baseRef, targetBranch);
  assert.equal(reopened.workspace.worktree?.baseSha, latestTargetSha);
  assert.notEqual(reopened.workspace.worktree?.baseSha, historicalSha);
  assert.equal(reopened.workspace.worktree?.targetBranch, targetBranch);

  const reopenedInspection = await registry.inspectWorkspace(workspaceId);
  assert.equal(reopenedInspection.baseRef, targetBranch);
  assert.equal(reopenedInspection.baseSha, latestTargetSha);
  assert.equal(reopenedInspection.targetBranch, targetBranch);
  await registry.closeWorktree(workspaceId, "test: cleanup reopened pinned Workspace");
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
  const failingRegistry = new WorkspaceRegistry({
    ...config,
    systemInstructionsPath: project,
  }, store);

  await assert.rejects(
    failingRegistry.openWorkspace({ workspaceId }),
    /EISDIR|directory/i,
  );
  assert.equal(store.getSession(workspaceId)?.status, "closed");
  assert.equal(store.getSession(workspaceId)?.root, closedRoot);
  assert.throws(() => failingRegistry.getWorkspace(workspaceId), /Unknown workspaceId/);
  assert.deepEqual(await readdir(config.worktreeRoot), []);
});

test("managed worktree can start from a raw commit and fast-forward its local target branch", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const targetBranch = await gitOutput(project, ["branch", "--show-current"]);
  const baseSha = await gitOutput(project, ["rev-parse", "HEAD"]);

  const opened = await registry.openWorkspace({
    path: project,
    mode: "worktree",
    baseRef: baseSha,
  });

  assert.equal(opened.workspace.worktree?.baseRef, baseSha);
  assert.equal(opened.workspace.worktree?.baseSha, baseSha);
  assert.equal(opened.workspace.worktree?.targetBranch, targetBranch);
  assert.match(opened.workspace.worktree?.branch ?? "", /^forgerelay\//);
  assert.notEqual(await gitOutput(opened.workspace.root, ["branch", "--show-current"]), "");

  await writeFile(join(opened.workspace.root, "raw-base.txt"), "created from raw base\n");
  const closed = await registry.closeWorktree(opened.workspace.id, "test: close raw-base worktree");

  assert.equal(closed.targetBranch, targetBranch);
  assert.equal(await gitOutput(project, ["rev-parse", "HEAD"]), closed.mergedSha);
  assert.equal((await stat(join(project, "raw-base.txt"))).isFile(), true);
});

test("historical raw commit preserves fast-forward-only close safety", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const targetBranch = await gitOutput(project, ["branch", "--show-current"]);
  const historicalSha = await gitOutput(project, ["rev-parse", "HEAD"]);
  await writeFile(join(project, "target-only.txt"), "target advanced\n");
  await git(project, ["add", "target-only.txt"]);
  await git(project, ["commit", "-m", "Advance target"]);
  const targetHead = await gitOutput(project, ["rev-parse", "HEAD"]);

  const opened = await registry.openWorkspace({
    path: project,
    mode: "worktree",
    baseRef: historicalSha,
  });
  assert.equal(opened.workspace.worktree?.targetBranch, targetBranch);
  assert.equal(opened.workspace.worktree?.baseSha, historicalSha);
  await writeFile(join(opened.workspace.root, "historical-work.txt"), "isolated change\n");

  await assert.rejects(
    registry.closeWorktree(opened.workspace.id, "test: reject divergent historical base"),
    /advanced independently|fast-forward|diverged/i,
  );
  assert.equal(await gitOutput(project, ["rev-parse", "HEAD"]), targetHead);
});

test("detached source requires an explicit local target branch for managed worktree creation", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const targetBranch = await gitOutput(project, ["branch", "--show-current"]);
  const baseSha = await gitOutput(project, ["rev-parse", "HEAD"]);
  await git(project, ["switch", "--detach", baseSha]);

  await assert.rejects(
    registry.openWorkspace({ path: project, mode: "worktree", baseRef: "HEAD" }),
    /detached|target branch/i,
  );

  const opened = await registry.openWorkspace({
    path: project,
    mode: "worktree",
    baseRef: "HEAD",
    targetBranch,
  });
  assert.equal(opened.workspace.worktree?.baseSha, baseSha);
  assert.equal(opened.workspace.worktree?.targetBranch, targetBranch);

  await assert.rejects(
    registry.openWorkspace({
      path: project,
      mode: "worktree",
      baseRef: baseSha,
      targetBranch: "missing-target",
      newWorktree: true,
    }),
    /target branch|local branch/i,
  );
});

test("pinned managed-worktree reuse includes the resolved base commit", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const firstBase = await gitOutput(project, ["rev-parse", "HEAD"]);
  await writeFile(join(project, "second-base.txt"), "second base\n");
  await git(project, ["add", "second-base.txt"]);
  await git(project, ["commit", "-m", "Second base"]);
  const secondBase = await gitOutput(project, ["rev-parse", "HEAD"]);
  await writeFile(join(project, "target-head.txt"), "target head\n");
  await git(project, ["add", "target-head.txt"]);
  await git(project, ["commit", "-m", "Advance target head"]);

  const first = await registry.openWorkspace({ path: project, mode: "worktree", baseRef: firstBase });
  const repeatedFirst = await registry.openWorkspace({ path: project, mode: "worktree", baseRef: firstBase });
  const second = await registry.openWorkspace({ path: project, mode: "worktree", baseRef: secondBase });
  const branchFollowing = await registry.openWorkspace({ path: project, mode: "worktree" });

  assert.equal(repeatedFirst.workspace.id, first.workspace.id);
  assert.notEqual(second.workspace.id, first.workspace.id);
  assert.notEqual(second.workspace.root, first.workspace.root);
  assert.notEqual(branchFollowing.workspace.id, first.workspace.id);
  assert.notEqual(branchFollowing.workspace.id, second.workspace.id);
  assert.equal(first.workspace.worktree?.baseSha, firstBase);
  assert.equal(second.workspace.worktree?.baseSha, secondBase);
});

test("worktree requests reuse the same worktree without replacing the checkout", async (t) => {
  const { project, registry } = await fixture(t, { git: true });
  const worktreeInput = { path: project, mode: "worktree" as const };

  const checkout = await registry.openWorkspace(project, { conversationScopeId: "chat-1" });
  const firstWorktree = await registry.openWorkspace(worktreeInput, {
    conversationScopeId: "chat-1",
  });
  await writeFile(join(project, "target-advanced-after-open.txt"), "target advanced\n");
  await git(project, ["add", "target-advanced-after-open.txt"]);
  await git(project, ["commit", "-m", "Advance target after worktree open"]);
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
