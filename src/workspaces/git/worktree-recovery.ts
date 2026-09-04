import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ServerConfig } from "../../runtime/config/config.js";
import { assertAllowedPath } from "../../mcp/filesystem/roots.js";
import type { WorkspaceSession } from "../state/workspace-store.js";
import { managedWorktreePath } from "./git-worktrees.js";
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

export interface ManagedWorktreeRepairPreparation {
  prepared: true;
  previousRoot: string;
  root: string;
  sourceRoot: string;
  branch: string;
  targetBranch: string;
  baseRef: string;
  baseSha: string;
  head: string;
  recovery: ManagedWorktreeRecoveryProjection;
}

export interface ManagedWorktreeRepairRefusal {
  prepared: false;
  recovery: ManagedWorktreeRecoveryProjection;
  reason: string;
}

export type ManagedWorktreeRepairPreflight =
  | ManagedWorktreeRepairPreparation
  | ManagedWorktreeRepairRefusal;

interface WorktreeRegistration {
  path: string;
  prunable: boolean;
  branch?: string;
  head?: string;
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

export async function prepareManagedWorktreeRepair(
  session: WorkspaceSession,
  config: ServerConfig,
): Promise<ManagedWorktreeRepairPreflight> {
  const recovery = await inspectManagedWorktreeRecovery(session, config);
  if (!recovery) {
    throw new Error(`Workspace ${session.id} is not an active managed-worktree Workspace.`);
  }
  if (recovery.classification !== "recoverable") {
    return {
      prepared: false,
      recovery,
      reason: "The Workspace is not in a provably recoverable managed-worktree state.",
    };
  }
  if (
    !session.sourceRoot ||
    !session.branch ||
    !session.targetBranch ||
    !session.baseRef ||
    !session.baseSha ||
    !session.branch.startsWith("forgerelay/")
  ) {
    return {
      prepared: false,
      recovery: manualRecovery(recovery),
      reason: "Persisted managed-worktree ownership metadata is incomplete or cannot prove ForgeRelay branch ownership.",
    };
  }

  const sourceRoot = assertAllowedPath(session.sourceRoot, config.allowedRoots);
  const head = (await git(sourceRoot, ["rev-parse", `refs/heads/${session.branch}`])).stdout.trim();
  const beforeRegistrations = await worktreeRegistrations(sourceRoot);
  const persistedRegistrations = await matchingPathRegistrations(beforeRegistrations, session.root);
  if (
    recovery.gitRegistration === "stale" &&
    (
      persistedRegistrations.length !== 1 ||
      persistedRegistrations[0]?.prunable !== true ||
      persistedRegistrations[0]?.branch !== `refs/heads/${session.branch}` ||
      (persistedRegistrations[0]?.head !== undefined && persistedRegistrations[0].head !== head)
    )
  ) {
    return {
      prepared: false,
      recovery: manualRecovery(recovery),
      reason: "The stale Git worktree registration does not prove ownership of the persisted ForgeRelay managed branch.",
    };
  }
  const beforeConflicts = await conflictingBranchRegistrations(
    beforeRegistrations,
    session.branch,
    session.root,
  );
  if (beforeConflicts.length > 0) {
    return {
      prepared: false,
      recovery: manualRecovery(recovery),
      reason: `Managed branch ${session.branch} is already associated with another worktree candidate.`,
    };
  }

  const root = await allocateManagedWorktreeRecoveryPath(sourceRoot, config);
  try {
    await git(sourceRoot, ["worktree", "add", "--force", root, session.branch]);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    const afterFailureConflicts = await conflictingBranchRegistrations(
      await worktreeRegistrations(sourceRoot),
      session.branch,
      session.root,
    );
    if (afterFailureConflicts.length > 0) {
      return {
        prepared: false,
        recovery: manualRecovery(recovery),
        reason: `Managed branch ${session.branch} acquired another worktree candidate while repair was starting.`,
      };
    }
    throw new Error(`Git could not recreate managed-worktree backing from ${session.branch}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const preparation: ManagedWorktreeRepairPreparation = {
    prepared: true,
    previousRoot: session.root,
    root,
    sourceRoot,
    branch: session.branch,
    targetBranch: session.targetBranch,
    baseRef: session.baseRef,
    baseSha: session.baseSha,
    head,
    recovery,
  };

  try {
    const afterRegistrations = await worktreeRegistrations(sourceRoot);
    const afterConflicts = await conflictingBranchRegistrations(
      afterRegistrations,
      session.branch,
      session.root,
      root,
    );
    if (afterConflicts.length > 0) {
      await rollbackManagedWorktreeRepair(preparation, config);
      return {
        prepared: false,
        recovery: manualRecovery(recovery),
        reason: `Managed branch ${session.branch} has ambiguous worktree ownership after repair preflight.`,
      };
    }

    const rootKey = await registrationPathKey(root);
    const repairedRegistration = await firstMatchingRegistration(
      afterRegistrations,
      `refs/heads/${session.branch}`,
      rootKey,
    );
    if (!repairedRegistration || repairedRegistration.prunable) {
      throw new Error("Git did not register the newly created recovery backing as an active worktree.");
    }

    const actualBranch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (actualBranch !== session.branch) {
      throw new Error(`Recovery backing opened branch ${actualBranch} instead of ${session.branch}.`);
    }
    const repairedHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const managedHead = (await git(sourceRoot, ["rev-parse", `refs/heads/${session.branch}`])).stdout.trim();
    if (repairedHead !== managedHead) {
      throw new Error("Recovery backing HEAD does not match the surviving managed branch.");
    }
    if ((await git(root, ["status", "--porcelain=v1"])).stdout.trim().length > 0) {
      throw new Error("Recovery backing is not clean immediately after reconstruction.");
    }

    const candidateRecovery = await inspectManagedWorktreeRecovery({ ...session, root }, config);
    if (!candidateRecovery || candidateRecovery.classification !== "healthy") {
      await rollbackManagedWorktreeRepair({ ...preparation, head: repairedHead }, config);
      return {
        prepared: false,
        recovery: candidateRecovery ? manualRecovery(candidateRecovery) : manualRecovery(recovery),
        reason: "The reconstructed backing did not pass the managed-worktree recovery health check.",
      };
    }
    return { ...preparation, head: repairedHead, recovery: candidateRecovery };
  } catch (error) {
    try {
      await rollbackManagedWorktreeRepair(preparation, config);
    } catch (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Recovery rollback also failed; the temporary backing was preserved for inspection: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }
}

export async function rollbackManagedWorktreeRepair(
  preparation: ManagedWorktreeRepairPreparation,
  config: ServerConfig,
): Promise<void> {
  const sourceRoot = assertAllowedPath(preparation.sourceRoot, config.allowedRoots);
  const root = assertAllowedPath(preparation.root, [config.worktreeRoot]);
  const actualBranch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (actualBranch !== preparation.branch) {
    throw new Error(`Cannot roll back recovery backing because it is on ${actualBranch} instead of ${preparation.branch}.`);
  }
  if ((await git(root, ["status", "--porcelain=v1"])).stdout.trim().length > 0) {
    throw new Error("Cannot roll back recovery backing because it acquired working-tree changes.");
  }
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== preparation.head) {
    throw new Error("Cannot roll back recovery backing because its managed branch advanced after reconstruction.");
  }
  await git(sourceRoot, ["worktree", "remove", root]);
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
  const worktreeKey = await registrationPathKey(worktreePath);
  for (const registration of registrations) {
    if (await registrationPathKey(registration.path) !== worktreeKey) continue;
    return registration.prunable ? "stale" : "registered";
  }
  return "missing";
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
      const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
      return {
        path,
        prunable: lines.some((line) => line.startsWith("prunable ")),
        ...(branch ? { branch } : {}),
        ...(head ? { head } : {}),
      };
    })
    .filter((entry): entry is WorktreeRegistration => entry !== undefined);
}

async function worktreeRegistrations(sourceRoot: string): Promise<WorktreeRegistration[]> {
  return parseWorktreeRegistrations((await git(sourceRoot, ["worktree", "list", "--porcelain"])).stdout);
}

async function conflictingBranchRegistrations(
  registrations: WorktreeRegistration[],
  branch: string,
  previousRoot: string,
  repairedRoot?: string,
): Promise<WorktreeRegistration[]> {
  const branchRef = `refs/heads/${branch}`;
  const previousKey = await registrationPathKey(previousRoot);
  const repairedKey = repairedRoot ? await registrationPathKey(repairedRoot) : undefined;
  const conflicts: WorktreeRegistration[] = [];
  for (const registration of registrations) {
    if (registration.branch !== branchRef) continue;
    const key = await registrationPathKey(registration.path);
    if (key === previousKey && registration.prunable) continue;
    if (repairedKey !== undefined && key === repairedKey && !registration.prunable) continue;
    conflicts.push(registration);
  }
  return conflicts;
}

async function matchingPathRegistrations(
  registrations: WorktreeRegistration[],
  path: string,
): Promise<WorktreeRegistration[]> {
  const expectedKey = await registrationPathKey(path);
  const matches: WorktreeRegistration[] = [];
  for (const registration of registrations) {
    if (await registrationPathKey(registration.path) === expectedKey) matches.push(registration);
  }
  return matches;
}

async function firstMatchingRegistration(
  registrations: WorktreeRegistration[],
  branchRef: string,
  pathKeyValue: string,
): Promise<WorktreeRegistration | undefined> {
  for (const registration of registrations) {
    if (registration.branch !== branchRef) continue;
    if (await registrationPathKey(registration.path) === pathKeyValue) return registration;
  }
  return undefined;
}

async function allocateManagedWorktreeRecoveryPath(
  sourceRoot: string,
  config: ServerConfig,
): Promise<string> {
  await mkdir(config.worktreeRoot, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = managedWorktreePath({
      worktreeRoot: config.worktreeRoot,
      repoRoot: sourceRoot,
      worktreeId: randomBytes(4).toString("hex"),
    });
    assertAllowedPath(path, [config.worktreeRoot]);
    try {
      await stat(path);
    } catch (error) {
      if (isMissingPath(error)) return path;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique managed-worktree recovery path.");
}

function manualRecovery(recovery: ManagedWorktreeRecoveryProjection): ManagedWorktreeRecoveryProjection {
  return recovery.classification === "manual-intervention"
    ? recovery
    : { ...recovery, classification: "manual-intervention" };
}

async function registrationPathKey(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return pathKey(await realpath(resolved));
  } catch (error) {
    if (!isMissingPath(error)) return pathKey(resolved);
    try {
      return pathKey(join(await realpath(dirname(resolved)), basename(resolved)));
    } catch {
      return pathKey(resolved);
    }
  }
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
