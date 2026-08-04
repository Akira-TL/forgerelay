import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("show_changes advances the last-shown checkpoint for incremental reviews", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_review", root });
  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes since last shown changes/);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const unreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.deepEqual(unreviewed.files.map((file) => file.path).sort(), ["README.md", "new.txt"]);
  assert.equal(unreviewed.summary.additions, 2);
  assert.equal(unreviewed.summary.removals, 0);
  assert.match(unreviewed.patch, /world/);

  const markedReviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(markedReviewed.summary.files, 2);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);
  assert.equal(afterReviewed.patch, "");
});

test("review checkpoints survive a manager restart", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_restart", root });
  await writeFile(join(root, "README.md"), "hello\nworld\n");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_restart", root });

  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_restart",
    root,
    markReviewed: false,
  });
  assert.equal(afterRestart.summary.files, 1);
  assert.match(afterRestart.patch, /world/);

  const sinceWorkspaceOpen = await restartedManager.reviewChanges({
    workspaceId: "ws_restart",
    root,
    since: "workspace_open",
    markReviewed: false,
  });
  assert.equal(sinceWorkspaceOpen.summary.files, 1);
  assert.match(sinceWorkspaceOpen.patch, /world/);
});

test("concurrent initialization produces a usable shared checkpoint state", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [, concurrentReview] = await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent", root }),
    manager.reviewChanges({ workspaceId: "ws_concurrent", root, markReviewed: false }),
  ]);
  assert.equal(concurrentReview.summary.files, 0);

  await writeFile(join(root, "later.txt"), "visible after initialization\n");
  const afterInitialization = await manager.reviewChanges({
    workspaceId: "ws_concurrent",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterInitialization.files.map((file) => file.path), ["later.txt"]);
});

test("a missing last-shown checkpoint falls back to workspace open and re-establishes its baseline", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });
  await writeFile(join(root, "README.md"), "hello\nchanged\n");
  await deleteReviewRef(root, "ws_missing_baseline", "baseline");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  const fallback = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(fallback.summary.files, 1);
  assert.match(fallback.result, /compared from workspace open/);
  assert.match(fallback.patch, /changed/);

  const reestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: true,
  });
  assert.equal(reestablished.summary.files, 1);
  assert.match(reestablished.result, /baseline was re-established/);

  const afterReestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(afterReestablished.summary.files, 0);
});

test("baseline loss during a running manager falls back to workspace open", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_in_process", root });
  await writeFile(join(root, "visible.txt"), "visible after ref loss\n");
  await deleteReviewRef(root, "ws_in_process", "baseline");

  const review = await manager.reviewChanges({
    workspaceId: "ws_in_process",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["visible.txt"]);
  assert.match(review.result, /compared from workspace open/);
});

test("a missing workspace-open checkpoint preserves incremental review but rejects explicit workspace-open comparison", async (t) => {
  const root = await committedRepository(t);
  const setupManager = createReviewCheckpointManager();
  await setupManager.initializeWorkspace({ workspaceId: "ws_open_missing", root });
  await writeFile(join(root, "baseline.txt"), "still visible from baseline\n");
  await deleteReviewRef(root, "ws_open_missing", "open");

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_open_missing", root });

  const incremental = await manager.reviewChanges({
    workspaceId: "ws_open_missing",
    root,
    markReviewed: false,
  });
  assert.equal(incremental.summary.files, 1);
  assert.match(incremental.patch, /still visible from baseline/);

  await assert.rejects(
    () => manager.reviewChanges({
      workspaceId: "ws_open_missing",
      root,
      since: "workspace_open",
      markReviewed: false,
    }),
    /workspace-open review checkpoint is missing/,
  );
});

test("missing historical checkpoints do not silently fabricate review history", async (t) => {
  const root = await committedRepository(t);
  const setupManager = createReviewCheckpointManager();
  await setupManager.initializeWorkspace({ workspaceId: "ws_history_missing", root });
  await deleteReviewRef(root, "ws_history_missing", "open");
  await deleteReviewRef(root, "ws_history_missing", "baseline");

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_history_missing", root });

  await assert.rejects(
    () => manager.reviewChanges({ workspaceId: "ws_history_missing", root }),
    /Review checkpoints are missing; show_changes cannot reconstruct that history safely/,
  );
});

test("an unborn repository becomes reviewable after its first commit", async (t) => {
  const root = await unbornRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });

  await assert.rejects(
    () => manager.reviewChanges({ workspaceId: "ws_unborn", root }),
    /repository has no HEAD commit/,
  );

  await writeFile(join(root, "README.md"), "first commit\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const afterFirstCommit = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.equal(afterFirstCommit.summary.files, 0);
  assert.equal(afterFirstCommit.patch, "");
});

async function committedRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

async function unbornRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-unborn-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  return root;
}

async function deleteReviewRef(
  root: string,
  workspaceId: string,
  checkpoint: "open" | "baseline",
): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/devspace/review/${workspaceId}/${checkpoint}`]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
