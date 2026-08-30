import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { assertAllowedPath, isPathInsideRoot } from "./roots.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_NOT_AVAILABLE"
      | "GIT_REPOSITORY_NOT_FOUND"
      | "GIT_REPOSITORY_HAS_NO_COMMITS"
      | "GIT_INVALID_BASE_REF"
      | "GIT_WORKTREE_SOURCE_DETACHED"
      | "GIT_WORKTREE_CREATE_FAILED"
      | "GIT_WORKTREE_CLOSE_FAILED"
      | "GIT_WORKTREE_SOURCE_DIRTY"
      | "GIT_WORKTREE_SOURCE_BRANCH_CHANGED"
      | "GIT_WORKTREE_DIVERGED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ManagedWorktree {
  sourceRoot: string;
  path: string;
  baseRef: string;
  baseSha: string;
  branch: string;
  targetBranch: string;
  dirtySource: boolean;
  detached: false;
  managed: true;
}

export interface ClosedManagedWorktree {
  sourceRoot: string;
  path: string;
  branch: string;
  targetBranch: string;
  commitSha: string;
  mergedSha: string;
  committed: boolean;
  cleanupWarning?: string;
}

export async function createManagedWorktree(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<ManagedWorktree> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);

  try {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isDirectory()) {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_NOT_FOUND",
        `Cannot open workspace in worktree mode because the source path is not a directory: ${input.sourcePath}`,
      );
    }
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because the source path does not exist: ${input.sourcePath}`,
    );
  }

  const { sourceRoot, baseRef, baseSha, targetBranch } = await resolveManagedWorktreeBase(input);
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  const worktreeId = randomBytes(4).toString("hex");
  const worktreePath = managedWorktreePath({
    worktreeRoot: input.config.worktreeRoot,
    repoRoot: sourceRoot,
    worktreeId,
  });
  const branch = managedWorktreeBranch({ repoRoot: sourceRoot, worktreeId });

  await mkdir(input.config.worktreeRoot, { recursive: true });
  assertAllowedPath(worktreePath, [input.config.worktreeRoot]);

  try {
    await git(["worktree", "add", "-b", branch, worktreePath, baseSha], sourceRoot);
  } catch (error) {
    await rm(worktreePath, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new GitWorktreeError(
      "GIT_WORKTREE_CREATE_FAILED",
      `Git failed to create the managed worktree. ${message}`,
    );
  }

  return {
    sourceRoot,
    path: worktreePath,
    baseRef,
    baseSha,
    branch,
    targetBranch,
    dirtySource,
    detached: false,
    managed: true,
  };
}

export async function discardFreshManagedWorktree(input: {
  worktree: ManagedWorktree;
  config: ServerConfig;
}): Promise<void> {
  const sourceRoot = assertAllowedPath(input.worktree.sourceRoot, input.config.allowedRoots);
  const worktreePath = assertAllowedPath(input.worktree.path, [input.config.worktreeRoot]);
  const worktreeBranch = await currentBranch(worktreePath);
  if (worktreeBranch !== input.worktree.branch) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      `Cannot roll back reopened worktree because it is on branch ${JSON.stringify(worktreeBranch)} instead of ${JSON.stringify(input.worktree.branch)}.`,
    );
  }
  if ((await git(["status", "--porcelain=v1"], worktreePath)).trim().length > 0) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      "Cannot roll back reopened worktree because it acquired uncommitted changes during reopen.",
    );
  }
  const worktreeHead = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
  if (worktreeHead !== input.worktree.baseSha) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      "Cannot roll back reopened worktree because its branch advanced during reopen.",
    );
  }

  try {
    await git(["worktree", "remove", worktreePath], sourceRoot);
    await git(["branch", "-D", input.worktree.branch], sourceRoot);
  } catch (error) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      `Git failed to remove the temporary managed worktree created for a failed reopen. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function closeManagedWorktree(input: {
  worktree: ManagedWorktree;
  commitMessage: string;
  config: ServerConfig;
}): Promise<ClosedManagedWorktree> {
  const sourceRoot = assertAllowedPath(input.worktree.sourceRoot, input.config.allowedRoots);
  const worktreePath = assertAllowedPath(input.worktree.path, [input.config.worktreeRoot]);
  const sourceBranch = await currentBranch(sourceRoot);
  if (sourceBranch !== input.worktree.targetBranch) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_SOURCE_BRANCH_CHANGED",
      `Cannot close worktree because the source checkout is on branch ${JSON.stringify(sourceBranch)} instead of target branch ${JSON.stringify(input.worktree.targetBranch)}. Switch the source checkout back to the target branch and retry.`,
    );
  }

  const sourceDirty = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  if (sourceDirty) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_SOURCE_DIRTY",
      "Cannot close worktree because the source checkout has uncommitted changes. Commit or stash them first; the managed worktree is unchanged.",
    );
  }

  const worktreeBranch = await currentBranch(worktreePath);
  if (worktreeBranch !== input.worktree.branch) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      `Cannot close worktree because it is on branch ${JSON.stringify(worktreeBranch)} instead of its managed branch ${JSON.stringify(input.worktree.branch)}.`,
    );
  }

  let committed = false;
  if ((await git(["status", "--porcelain=v1"], worktreePath)).trim().length > 0) {
    await git(["add", "-A"], worktreePath);
    try {
      await git(["commit", "-m", input.commitMessage], worktreePath);
      committed = true;
    } catch (error) {
      throw new GitWorktreeError(
        "GIT_WORKTREE_CLOSE_FAILED",
        `Git failed to commit the managed worktree before closing it. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if ((await git(["status", "--porcelain=v1"], worktreePath)).trim().length > 0) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      "Cannot close worktree because it still has uncommitted changes after the close commit. A Git hook may have modified files; inspect and verify the worktree, then retry.",
    );
  }

  const sourceBranchBeforeMerge = await currentBranch(sourceRoot);
  if (sourceBranchBeforeMerge !== input.worktree.targetBranch) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_SOURCE_BRANCH_CHANGED",
      `Cannot close worktree because the source checkout changed to branch ${JSON.stringify(sourceBranchBeforeMerge)} while the worktree was being finalized. The source checkout was not merged.`,
    );
  }
  if ((await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_SOURCE_DIRTY",
      "Cannot close worktree because the source checkout changed while the worktree was being finalized. The source checkout was not merged; commit or stash those changes and retry.",
    );
  }

  const sourceHead = (await git(["rev-parse", "HEAD"], sourceRoot)).trim();
  const commitSha = (await git(["rev-parse", "HEAD"], worktreePath)).trim();
  if (!(await isAncestor(sourceHead, commitSha, sourceRoot))) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_DIVERGED",
      `Cannot close worktree because ${input.worktree.targetBranch} advanced independently of ${input.worktree.branch}. Rebase the worktree branch onto ${input.worktree.targetBranch} inside the worktree, resolve and verify there, then retry. The source checkout was not modified.`,
    );
  }

  try {
    await git(["merge", "--ff-only", input.worktree.branch], sourceRoot);
  } catch (error) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_DIVERGED",
      `Git could not fast-forward ${input.worktree.targetBranch} to ${input.worktree.branch}. The source checkout was not put into a merge-conflict state. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const mergedSha = (await git(["rev-parse", "HEAD"], sourceRoot)).trim();

  try {
    await git(["worktree", "remove", worktreePath], sourceRoot);
  } catch (error) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_CLOSE_FAILED",
      `Changes were merged into ${input.worktree.targetBranch}, but ForgeRelay could not remove the managed worktree. The branch and workspace are preserved so cleanup can be retried. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let cleanupWarning: string | undefined;
  try {
    await git(["branch", "-d", input.worktree.branch], sourceRoot);
  } catch (error) {
    cleanupWarning = `The worktree was removed and its changes were merged, but Git could not delete branch ${input.worktree.branch}. Delete that already-merged branch manually if desired. ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    sourceRoot,
    path: worktreePath,
    branch: input.worktree.branch,
    targetBranch: input.worktree.targetBranch,
    commitSha,
    mergedSha,
    committed,
    cleanupWarning,
  };
}

export async function resolveManagedWorktreeBase(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<{ sourceRoot: string; baseRef: string; baseSha: string; targetBranch: string }> {
  const sourcePath = assertAllowedPath(input.sourcePath, input.config.allowedRoots);
  const sourceRoot = await resolveGitRoot(sourcePath, input.config.allowedRoots);
  const resolved = await resolveWorktreeBase(sourceRoot, input.baseRef);
  return { sourceRoot, ...resolved };
}

async function resolveGitRoot(path: string, allowedRoots: string[]): Promise<string> {
  try {
    const output = await git(["rev-parse", "--show-toplevel"], path);
    return await assertGitRootAllowed(output.trim(), allowedRoots);
  } catch (error) {
    if (isGitUnavailable(error)) {
      throw new GitWorktreeError(
        "GIT_NOT_AVAILABLE",
        "Cannot open workspace in worktree mode because Git is not available on this machine.",
      );
    }

    throw new GitWorktreeError(
      "GIT_REPOSITORY_NOT_FOUND",
      `Cannot open workspace in worktree mode because this path is not inside a Git repository: ${path}. Use mode=\"checkout\" to work directly in this directory, or initialize Git and create an initial commit first.`,
    );
  }
}

async function assertGitRootAllowed(gitRoot: string, allowedRoots: string[]): Promise<string> {
  try {
    return assertAllowedPath(gitRoot, allowedRoots);
  } catch {
    const canonicalGitRoot = await realpath(gitRoot);
    for (const allowedRoot of allowedRoots) {
      const canonicalAllowedRoot = await realpath(allowedRoot).catch(() => undefined);
      if (!canonicalAllowedRoot || !isPathInsideRoot(canonicalGitRoot, canonicalAllowedRoot)) {
        continue;
      }

      const logicalGitRoot = resolve(allowedRoot, relative(canonicalAllowedRoot, canonicalGitRoot));
      return assertAllowedPath(logicalGitRoot, allowedRoots);
    }

    return assertAllowedPath(canonicalGitRoot, allowedRoots);
  }
}

async function resolveWorktreeBase(
  sourceRoot: string,
  requestedBaseRef: string | undefined,
): Promise<{ baseRef: string; baseSha: string; targetBranch: string }> {
  const targetBranch = requestedBaseRef && requestedBaseRef !== "HEAD"
    ? normalizeLocalBranchName(requestedBaseRef)
    : await currentBranch(sourceRoot);

  if (!targetBranch) {
    throw new GitWorktreeError(
      "GIT_WORKTREE_SOURCE_DETACHED",
      "Cannot create a managed worktree from a detached source checkout. Switch the source checkout to the branch that should receive the finished work first.",
    );
  }

  try {
    const baseSha = (await git(["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`], sourceRoot)).trim();
    return {
      baseRef: requestedBaseRef ?? "HEAD",
      baseSha,
      targetBranch,
    };
  } catch {
    if (!requestedBaseRef || requestedBaseRef === "HEAD") {
      throw new GitWorktreeError(
        "GIT_REPOSITORY_HAS_NO_COMMITS",
        "Cannot open workspace in worktree mode because the current branch has no commits yet. Create an initial commit first, or use checkout mode.",
      );
    }

    throw new GitWorktreeError(
      "GIT_INVALID_BASE_REF",
      `Cannot create a managed worktree because baseRef ${JSON.stringify(requestedBaseRef)} is not a local branch. Managed worktrees must start from the local branch they will eventually merge back into.`,
    );
  }
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim();
  } catch {
    return "";
  }
}

function normalizeLocalBranchName(value: string): string {
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

async function isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

function managedWorktreePath(input: {
  worktreeRoot: string;
  repoRoot: string;
  worktreeId: string;
}): string {
  const repoName = sanitizePathSegment(basename(input.repoRoot)) || "repo";
  return join(input.worktreeRoot, `${repoName}-${input.worktreeId}`);
}

function managedWorktreeBranch(input: { repoRoot: string; worktreeId: string }): string {
  const repoName = sanitizeGitBranchSegment(basename(input.repoRoot)) || "repo";
  return `forgerelay/${repoName}-${input.worktreeId}`;
}

function sanitizeGitBranchSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (isGitUnavailable(error)) throw error;

    const stderr = typeof error === "object" && error && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const stdout = typeof error === "object" && error && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "").trim()
      : "";
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(details);
  }
}

function isGitUnavailable(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}
