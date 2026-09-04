import { realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { ServerConfig } from "../../runtime/config/config.js";
import { assertAllowedPath } from "../../mcp/filesystem/roots.js";
import type { WorkspaceSession } from "../state/workspace-store.js";
import { git } from "./git.js";

export type ManagedWorktreeRecoveryCondition =
  | "backing-missing"
  | "managed-branch-missing"
  | "git-registration-stale"
  | "git-registration-missing"
  | "git-registration-unavailable"
  | "branch-mismatch"
  | "source-missing"
  | "source-unavailable"
  | "target-branch-missing";

export interface ManagedWorktreeRecoveryProjection {
  classification: "healthy" | "recoverable" | "manual-intervention";
  conditions: ManagedWorktreeRecoveryCondition[];
  backing: "present" | "missing";
  source: "available" | "missing" | "unavailable";
  gitRegistration: "registered" | "stale" | "missing" | "unavailable";
  managedBranch: "present" | "missing" | "unknown";
  targetBranch: "present" | "missing" | "unknown";
  backingBranch: "matching" | "mismatched" | "unavailable";
}

interface WorktreeRegistration {
  path: string;
  prunable: boolean;
}

export async function inspectManagedWorktreeRecovery(
  session: WorkspaceSession,
  config: ServerConfig,
): Promise<ManagedWorktreeRecoveryProjection | undefined> {
  if (
    session.status !== "active" ||
    session.mode !== "worktree" ||
    !session.managed
  ) return undefined;

  const backing = await directoryState(session.root, [config.worktreeRoot]);
  const source = await sourceState(session.sourceRoot, config.allowedRoots);
  const conditions: ManagedWorktreeRecoveryCondition[] = [];

  if (source === "missing") conditions.push("source-missing");
  else if (source === "unavailable") conditions.push("source-unavailable");
  if (backing === "missing") conditions.push("backing-missing");

  if (source !== "available" || !session.sourceRoot) {
    return {
      classification: "manual-intervention",
      conditions,
      backing,
      source,
      gitRegistration: "unavailable",
      managedBranch: "unknown",
      targetBranch: "unknown",
      backingBranch: "unavailable",
    };
  }

  const sourceRoot = assertAllowedPath(session.sourceRoot, config.allowedRoots);
  const [managedBranch, targetBranch, registration] = await Promise.all([
    branchState(sourceRoot, session.branch),
    branchState(sourceRoot, session.targetBranch),
    registrationState(sourceRoot, session.root),
  ]);

  if (managedBranch === "missing") conditions.push("managed-branch-missing");
  if (targetBranch === "missing") conditions.push("target-branch-missing");
  if (registration === "stale") conditions.push("git-registration-stale");
  else if (registration === "missing") conditions.push("git-registration-missing");
  else if (registration === "unavailable") conditions.push("git-registration-unavailable");

  const backingBranch = backing === "present"
    ? await backingBranchState(session.root, session.branch)
    : "unavailable";
  if (backingBranch === "mismatched") conditions.push("branch-mismatch");

  const recoverable =
    backing === "missing" &&
    managedBranch === "present" &&
    targetBranch === "present" &&
    (registration === "stale" || registration === "missing") &&
    conditions.every((condition) =>
      condition === "backing-missing" ||
      condition === "git-registration-stale" ||
      condition === "git-registration-missing"
    );

  return {
    classification: conditions.length === 0
      ? "healthy"
      : recoverable
        ? "recoverable"
        : "manual-intervention",
    conditions,
    backing,
    source,
    gitRegistration: registration,
    managedBranch,
    targetBranch,
    backingBranch,
  };
}

async function directoryState(
  path: string,
  allowedRoots: string[],
): Promise<"present" | "missing"> {
  const allowedPath = assertAllowedPath(path, allowedRoots);
  try {
    return (await stat(allowedPath)).isDirectory() ? "present" : "missing";
  } catch (error) {
    if (isMissingPath(error)) return "missing";
    throw error;
  }
}

async function sourceState(
  sourceRoot: string | undefined,
  allowedRoots: string[],
): Promise<"available" | "missing" | "unavailable"> {
  if (!sourceRoot) return "unavailable";
  let sourcePath: string;
  try {
    sourcePath = assertAllowedPath(sourceRoot, allowedRoots);
  } catch {
    return "unavailable";
  }
  try {
    if (!(await stat(sourcePath)).isDirectory()) return "missing";
  } catch (error) {
    return isMissingPath(error) ? "missing" : "unavailable";
  }
  try {
    const gitRoot = (await git(sourcePath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const [canonicalGitRoot, canonicalSource] = await Promise.all([realpath(gitRoot), realpath(sourcePath)]);
    return pathKey(canonicalGitRoot) === pathKey(canonicalSource) ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function branchState(
  sourceRoot: string,
  branch: string | undefined,
): Promise<"present" | "missing"> {
  if (!branch) return "missing";
  try {
    await git(sourceRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return "present";
  } catch {
    return "missing";
  }
}

async function registrationState(
  sourceRoot: string,
  worktreePath: string,
): Promise<"registered" | "stale" | "missing" | "unavailable"> {
  let registrations: WorktreeRegistration[];
  try {
    registrations = parseWorktreeRegistrations(
      (await git(sourceRoot, ["worktree", "list", "--porcelain"])).stdout,
    );
  } catch {
    return "unavailable";
  }
  const worktreeKey = pathKey(worktreePath);
  const registration = registrations.find((entry) => pathKey(entry.path) === worktreeKey);
  if (!registration) return "missing";
  return registration.prunable ? "stale" : "registered";
}

async function backingBranchState(
  worktreeRoot: string,
  expectedBranch: string | undefined,
): Promise<"matching" | "mismatched" | "unavailable"> {
  if (!expectedBranch) return "mismatched";
  try {
    const actual = (await git(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    return actual === expectedBranch ? "matching" : "mismatched";
  } catch {
    return "mismatched";
  }
}

function parseWorktreeRegistrations(output: string): WorktreeRegistration[] {
  return output
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (!path) return undefined;
      return {
        path,
        prunable: lines.some((line) => line.startsWith("prunable ")),
      };
    })
    .filter((entry): entry is WorktreeRegistration => entry !== undefined);
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
