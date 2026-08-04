import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
const unbornRoot = await mkdtemp(join(tmpdir(), "devspace-review-unborn-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });

  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes/);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(firstReview.summary.files, 2);
  assert.equal(firstReview.summary.additions, 2);
  assert.equal(firstReview.summary.removals, 0);
  assert.equal(firstReview.files.some((file) => file.path === "README.md"), true);
  assert.equal(firstReview.files.some((file) => file.path === "new.txt"), true);
  assert.match(firstReview.patch, /world/);

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_review", root });
  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(afterRestart.summary.files, 2);
  assert.match(afterRestart.patch, /world/);

  const sinceOpenAfterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "workspace_open",
    markReviewed: false,
  });
  assert.equal(sinceOpenAfterRestart.summary.files, 2);
  assert.match(sinceOpenAfterRestart.patch, /world/);

  const stillUnreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(stillUnreviewed.summary.files, 2);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);

  await writeFile(join(root, "README.md"), "hello\nworld\nlater\n");

  const concurrentManager = createReviewCheckpointManager();
  const [, concurrentReview] = await Promise.all([
    concurrentManager.initializeWorkspace({ workspaceId: "ws_review", root }),
    concurrentManager.reviewChanges({ workspaceId: "ws_review", root, markReviewed: false }),
  ]);
  assert.equal(concurrentReview.summary.files, 1);
  assert.match(concurrentReview.patch, /later/);

  await git(root, ["update-ref", "-d", "refs/devspace/review/ws_review/baseline"]);
  const partiallyRestoredManager = createReviewCheckpointManager();
  await partiallyRestoredManager.initializeWorkspace({ workspaceId: "ws_review", root });
  await assert.rejects(
    () => partiallyRestoredManager.reviewChanges({
      workspaceId: "ws_review",
      root,
      markReviewed: false,
    }),
    /last-shown review checkpoint is missing/,
  );
  const afterPartialRestoreSinceOpen = await partiallyRestoredManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "workspace_open",
    markReviewed: false,
  });
  assert.equal(afterPartialRestoreSinceOpen.summary.files, 2);
  assert.match(afterPartialRestoreSinceOpen.patch, /later/);

  const reestablishedBaseline = await partiallyRestoredManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    since: "workspace_open",
    markReviewed: true,
  });
  assert.equal(reestablishedBaseline.summary.files, 2);
  const afterBaselineReestablished = await partiallyRestoredManager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(afterBaselineReestablished.summary.files, 0);

  const openMissingSetupManager = createReviewCheckpointManager();
  await openMissingSetupManager.initializeWorkspace({ workspaceId: "ws_open_missing", root });
  await writeFile(join(root, "open-missing.txt"), "still visible from baseline\n");
  await git(root, ["update-ref", "-d", "refs/devspace/review/ws_open_missing/open"]);

  const openMissingManager = createReviewCheckpointManager();
  await openMissingManager.initializeWorkspace({ workspaceId: "ws_open_missing", root });
  const afterOpenRefLoss = await openMissingManager.reviewChanges({
    workspaceId: "ws_open_missing",
    root,
    markReviewed: false,
  });
  assert.equal(afterOpenRefLoss.summary.files, 1);
  assert.match(afterOpenRefLoss.patch, /still visible from baseline/);
  await assert.rejects(
    () => openMissingManager.reviewChanges({
      workspaceId: "ws_open_missing",
      root,
      since: "workspace_open",
      markReviewed: false,
    }),
    /workspace-open review checkpoint is missing/,
  );

  await git(unbornRoot, ["init"]);
  await git(unbornRoot, ["config", "user.email", "devspace@example.com"]);
  await git(unbornRoot, ["config", "user.name", "DevSpace Test"]);

  const unbornManager = createReviewCheckpointManager();
  await unbornManager.initializeWorkspace({ workspaceId: "ws_unborn", root: unbornRoot });
  await assert.rejects(
    () => unbornManager.reviewChanges({ workspaceId: "ws_unborn", root: unbornRoot }),
    /commit|HEAD|Git/i,
  );

  await writeFile(join(unbornRoot, "README.md"), "first commit\n");
  await git(unbornRoot, ["add", "README.md"]);
  await git(unbornRoot, ["commit", "-m", "Initial commit"]);

  const afterFirstCommit = await unbornManager.reviewChanges({
    workspaceId: "ws_unborn",
    root: unbornRoot,
    markReviewed: false,
  });
  assert.equal(afterFirstCommit.summary.files, 0);
  assert.equal(afterFirstCommit.patch, "");
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(unbornRoot, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
