import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import { getGitEligibility, git, safeWorkspaceRefSegment } from "../git/git.js";

const CHECKPOINT_STATE_VERSION = 1 as const;
const CHECKPOINT_REF_PREFIX = "refs/forgerelay/checkpoints";
const MAX_CHECKPOINTS = 500;
const MAX_CHECKPOINT_NAME_LENGTH = 120;
const MAX_CHECKPOINT_STATE_BYTES = 1024 * 1024;

export interface WorkspaceCheckpointSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface WorkspaceCheckpoint {
  id: string;
  name: string;
  createdAt: string;
  commit: string;
  baseHead: string;
  summary: WorkspaceCheckpointSummary;
}

export interface WorkspaceCheckpointListResult {
  workspaceId: string;
  checkpoints: WorkspaceCheckpoint[];
  page: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
  ignoredFilesIncluded: false;
}

export interface WorkspaceCheckpointRestorePreflight {
  workspaceId: string;
  checkpoint: WorkspaceCheckpoint;
  checkpointSnapshot: string;
  currentSnapshot: string;
  restoreSummary: WorkspaceCheckpointSummary;
  ignoredFilesIncluded: false;
  stagingStateRestored: false;
}

export interface WorkspaceCheckpointRestoreResult {
  workspaceId: string;
  checkpointId: string;
  restored: true;
  checkpointSnapshot: string;
  previousSnapshot: string;
  currentSnapshot: string;
  ignoredFilesIncluded: false;
  stagingStateRestored: false;
}

interface PersistedWorkspaceCheckpointState {
  version: typeof CHECKPOINT_STATE_VERSION;
  revision: number;
  gitCommonDir: string;
  checkpoints: WorkspaceCheckpoint[];
}

const checkpointSchema = z.object({
  id: z.string().regex(/^cp_[a-f0-9]{10}$/),
  name: z.string().min(1).max(MAX_CHECKPOINT_NAME_LENGTH),
  createdAt: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  baseHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  summary: z.object({
    files: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    removals: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const checkpointStateSchema = z.object({
  version: z.literal(CHECKPOINT_STATE_VERSION),
  revision: z.number().int().nonnegative(),
  gitCommonDir: z.string().min(1),
  checkpoints: z.array(checkpointSchema).max(MAX_CHECKPOINTS),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  for (const [index, checkpoint] of state.checkpoints.entries()) {
    if (ids.has(checkpoint.id)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints", index, "id"],
        message: `Duplicate checkpoint id ${checkpoint.id}.`,
      });
    }
    ids.add(checkpoint.id);
  }
});

export class WorkspaceCheckpointStore {
  private readonly mutationChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(workspaceId: string, workspaceRoot: string, name: string): Promise<WorkspaceCheckpoint> {
    const id = normalizeWorkspaceId(workspaceId);
    const checkpointName = normalizeCheckpointName(name);
    return this.runMutation(id, async () => {
      const repository = await resolveRepository(workspaceRoot);
      const loaded = this.tryReadState(id);
      if (loaded) await assertSameRepository(loaded.gitCommonDir, repository.gitCommonDir, id);
      if ((loaded?.checkpoints.length ?? 0) >= MAX_CHECKPOINTS) {
        throw new Error(`Workspace checkpoint limit is ${MAX_CHECKPOINTS}. Delete an older checkpoint first.`);
      }

      const checkpointId = `cp_${randomBytes(5).toString("hex")}`;
      const ref = checkpointRef(id, checkpointId);
      const snapshot = await createWorkingTreeSnapshot(repository.gitRoot);
      const checkpoint: WorkspaceCheckpoint = {
        id: checkpointId,
        name: checkpointName,
        createdAt: this.now().toISOString(),
        commit: snapshot.commit,
        baseHead: snapshot.baseHead,
        summary: snapshot.summary,
      };

      await updateRef(repository.gitCommonDir, ref, checkpoint.commit, zeroOid(checkpoint.commit.length));
      try {
        this.writeState(id, {
          version: CHECKPOINT_STATE_VERSION,
          revision: (loaded?.revision ?? 0) + 1,
          gitCommonDir: repository.gitCommonDir,
          checkpoints: [...(loaded?.checkpoints ?? []), checkpoint],
        });
      } catch (error) {
        await deleteRef(repository.gitCommonDir, ref, checkpoint.commit).catch(() => undefined);
        throw error;
      }
      return { ...checkpoint, summary: { ...checkpoint.summary } };
    });
  }

  async list(
    workspaceId: string,
    workspaceRoot: string,
    input: { offset?: number; limit?: number } = {},
  ): Promise<WorkspaceCheckpointListResult> {
    const id = normalizeWorkspaceId(workspaceId);
    const repository = await resolveRepository(workspaceRoot);
    const state = this.tryReadState(id);
    if (state) await assertSameRepository(state.gitCommonDir, repository.gitCommonDir, id);
    const offset = normalizeOffset(input.offset);
    const limit = normalizeLimit(input.limit);
    const checkpoints = state?.checkpoints ?? [];
    return {
      workspaceId: id,
      checkpoints: checkpoints.slice(offset, offset + limit).map(cloneCheckpoint),
      page: {
        offset,
        limit,
        total: checkpoints.length,
        hasMore: offset + limit < checkpoints.length,
      },
      ignoredFilesIncluded: false,
    };
  }

  async inspect(
    workspaceId: string,
    workspaceRoot: string,
    checkpointId: string,
  ): Promise<{ workspaceId: string; checkpoint: WorkspaceCheckpoint; ignoredFilesIncluded: false }> {
    const id = normalizeWorkspaceId(workspaceId);
    const cpId = normalizeCheckpointId(checkpointId);
    const repository = await resolveRepository(workspaceRoot);
    const state = this.requireState(id);
    await assertSameRepository(state.gitCommonDir, repository.gitCommonDir, id);
    const checkpoint = requireCheckpoint(state, cpId);
    await assertCheckpointRef(state.gitCommonDir, id, checkpoint);
    return { workspaceId: id, checkpoint: cloneCheckpoint(checkpoint), ignoredFilesIncluded: false };
  }

  async preflightRestore(
    workspaceId: string,
    workspaceRoot: string,
    checkpointId: string,
  ): Promise<WorkspaceCheckpointRestorePreflight> {
    const id = normalizeWorkspaceId(workspaceId);
    const cpId = normalizeCheckpointId(checkpointId);
    const repository = await resolveRepository(workspaceRoot);
    const state = this.requireState(id);
    await assertSameRepository(state.gitCommonDir, repository.gitCommonDir, id);
    const checkpoint = requireCheckpoint(state, cpId);
    await assertCheckpointRef(state.gitCommonDir, id, checkpoint);
    const [checkpointSnapshot, current] = await Promise.all([
      checkpointTree(repository.gitRoot, checkpoint.commit),
      snapshotWorkingTree(repository.gitRoot),
    ]);
    const restoreSummary = summarizeNumstat((await git(repository.gitRoot, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      current.tree,
      checkpointSnapshot,
      "--",
      ".",
    ], { maxBuffer: 50 * 1024 * 1024 })).stdout);
    return {
      workspaceId: id,
      checkpoint: cloneCheckpoint(checkpoint),
      checkpointSnapshot,
      currentSnapshot: current.tree,
      restoreSummary,
      ignoredFilesIncluded: false,
      stagingStateRestored: false,
    };
  }

  async restore(
    workspaceId: string,
    workspaceRoot: string,
    checkpointId: string,
    expectedCurrentSnapshot: string,
  ): Promise<WorkspaceCheckpointRestoreResult> {
    const id = normalizeWorkspaceId(workspaceId);
    const cpId = normalizeCheckpointId(checkpointId);
    const expected = normalizeSnapshotId(expectedCurrentSnapshot);
    return this.runMutation(id, async () => {
      const repository = await resolveRepository(workspaceRoot);
      const state = this.requireState(id);
      await assertSameRepository(state.gitCommonDir, repository.gitCommonDir, id);
      const checkpoint = requireCheckpoint(state, cpId);
      await assertCheckpointRef(state.gitCommonDir, id, checkpoint);
      const checkpointSnapshot = await checkpointTree(repository.gitRoot, checkpoint.commit);
      const current = await snapshotWorkingTree(repository.gitRoot);
      assertExpectedCurrentSnapshot(expected, current.tree);

      if (current.tree !== checkpointSnapshot) {
        await applyTreeRestore(repository.gitRoot, current.tree, checkpointSnapshot, async () => {
          const immediate = await snapshotWorkingTree(repository.gitRoot);
          assertExpectedCurrentSnapshot(expected, immediate.tree);
        });
      }
      const restored = await snapshotWorkingTree(repository.gitRoot);
      if (restored.tree !== checkpointSnapshot) {
        throw new Error(
          `Workspace checkpoint restore did not reproduce checkpoint snapshot ${checkpointSnapshot}; current snapshot is ${restored.tree}.`,
        );
      }
      return {
        workspaceId: id,
        checkpointId: cpId,
        restored: true,
        checkpointSnapshot,
        previousSnapshot: current.tree,
        currentSnapshot: restored.tree,
        ignoredFilesIncluded: false,
        stagingStateRestored: false,
      };
    });
  }

  async delete(
    workspaceId: string,
    workspaceRoot: string,
    checkpointId: string,
  ): Promise<{ workspaceId: string; checkpointId: string; deleted: true }> {
    const id = normalizeWorkspaceId(workspaceId);
    const cpId = normalizeCheckpointId(checkpointId);
    return this.runMutation(id, async () => {
      const repository = await resolveRepository(workspaceRoot);
      const state = this.requireState(id);
      await assertSameRepository(state.gitCommonDir, repository.gitCommonDir, id);
      const checkpoint = requireCheckpoint(state, cpId);
      const ref = checkpointRef(id, cpId);
      await deleteRef(state.gitCommonDir, ref, checkpoint.commit);
      try {
        this.writeState(id, {
          ...state,
          revision: state.revision + 1,
          checkpoints: state.checkpoints.filter((candidate) => candidate.id !== cpId),
        });
      } catch (error) {
        await updateRef(state.gitCommonDir, ref, checkpoint.commit, zeroOid(checkpoint.commit.length)).catch(() => undefined);
        throw error;
      }
      return { workspaceId: id, checkpointId: cpId, deleted: true };
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const id = normalizeWorkspaceId(workspaceId);
    await this.runMutation(id, async () => {
      const state = this.tryReadState(id);
      if (!state) return;
      for (const checkpoint of state.checkpoints) {
        await deleteRef(state.gitCommonDir, checkpointRef(id, checkpoint.id), checkpoint.commit);
      }
      rmSync(this.statePath(id), { force: true });
      try {
        rmdirSync(this.workspaceStateDir(id));
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST")) {
          throw error;
        }
      }
    });
  }

  private async runMutation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChains.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.mutationChains.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.mutationChains.get(workspaceId) === current) this.mutationChains.delete(workspaceId);
    }
  }

  private requireState(workspaceId: string): PersistedWorkspaceCheckpointState {
    const state = this.tryReadState(workspaceId);
    if (!state) throw new Error(`Workspace ${workspaceId} has no checkpoints.`);
    return state;
  }

  private tryReadState(workspaceId: string): PersistedWorkspaceCheckpointState | undefined {
    let raw: Buffer;
    try {
      raw = readFileSync(this.statePath(workspaceId));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (raw.byteLength > MAX_CHECKPOINT_STATE_BYTES) {
      throw new Error(`Workspace checkpoint state exceeds ${MAX_CHECKPOINT_STATE_BYTES} bytes.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      throw new Error(`Workspace checkpoint state is not valid JSON: ${errorMessage(error)}`);
    }
    const validated = checkpointStateSchema.safeParse(parsed);
    if (!validated.success) {
      const details = validated.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "state"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Workspace checkpoint state has an unsupported or invalid format: ${details}`);
    }
    return cloneState(validated.data);
  }

  private writeState(workspaceId: string, state: PersistedWorkspaceCheckpointState): void {
    const validated = checkpointStateSchema.parse(state);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_STATE_BYTES) {
      throw new Error(`Workspace checkpoint state exceeds ${MAX_CHECKPOINT_STATE_BYTES} bytes.`);
    }
    const workspaceDir = this.workspaceStateDir(workspaceId);
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    const statePath = this.statePath(workspaceId);
    const tempPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, serialized, { mode: 0o600 });
      renameSync(tempPath, statePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  private workspaceStateDir(workspaceId: string): string {
    return join(this.stateDir, "workspaces", workspaceId);
  }

  private statePath(workspaceId: string): string {
    return join(this.workspaceStateDir(workspaceId), "checkpoints.json");
  }
}

async function resolveRepository(workspaceRoot: string): Promise<{ gitRoot: string; gitCommonDir: string }> {
  const eligibility = await getGitEligibility(workspaceRoot);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "workspace.checkpoint requires a Git workspace with a HEAD commit.");
  }
  const commonDirRaw = (await git(eligibility.gitRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim();
  const commonDir = await canonicalExistingPath(commonDirRaw);
  return { gitRoot: eligibility.gitRoot, gitCommonDir: commonDir };
}

async function createWorkingTreeSnapshot(
  gitRoot: string,
): Promise<{ commit: string; baseHead: string; summary: WorkspaceCheckpointSummary }> {
  const snapshot = await snapshotWorkingTree(gitRoot);
  const commit = (await git(gitRoot, [
    "commit-tree",
    snapshot.tree,
    "-p",
    snapshot.baseHead,
    "-m",
    "ForgeRelay persistent workspace checkpoint",
  ], { env: checkpointIdentityEnv() })).stdout.trim();
  const numstat = (await git(gitRoot, ["diff", "--numstat", "-z", snapshot.baseHead, commit], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  return { commit, baseHead: snapshot.baseHead, summary: summarizeNumstat(numstat) };
}

async function snapshotWorkingTree(gitRoot: string): Promise<{ tree: string; baseHead: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "forgerelay-checkpoint-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);
  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    const baseHead = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    return { tree, baseHead };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function checkpointTree(gitRoot: string, checkpointCommit: string): Promise<string> {
  return (await git(gitRoot, ["rev-parse", "--verify", `${checkpointCommit}^{tree}`])).stdout.trim();
}

async function applyTreeRestore(
  gitRoot: string,
  currentTree: string,
  checkpointTreeId: string,
  verifyImmediatelyBeforeApply: () => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "forgerelay-checkpoint-restore-"));
  const patchPath = join(tempDir, "restore.patch");
  try {
    const patch = (await git(gitRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      currentTree,
      checkpointTreeId,
      "--",
      ".",
    ], { maxBuffer: 100 * 1024 * 1024 })).stdout;
    await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600 });
    await git(gitRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath]);
    await verifyImmediatelyBeforeApply();
    await git(gitRoot, ["apply", "--binary", "--whitespace=nowarn", patchPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function summarizeNumstat(output: string): WorkspaceCheckpointSummary {
  const fields = output.split("\0").filter((field) => field.length > 0);
  let files = 0;
  let additions = 0;
  let removals = 0;
  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    additions += parseStatNumber(parts[0]);
    removals += parseStatNumber(parts[1]);
    files += 1;
    if (parts.length < 3) index += 2;
  }
  return { files, additions, removals };
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function checkpointEnv(indexPath: string): NodeJS.ProcessEnv {
  return {
    ...checkpointIdentityEnv(),
    GIT_INDEX_FILE: indexPath,
  };
}

function checkpointIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "ForgeRelay",
    GIT_AUTHOR_EMAIL: "forgerelay@users.noreply.local",
    GIT_COMMITTER_NAME: "ForgeRelay",
    GIT_COMMITTER_EMAIL: "forgerelay@users.noreply.local",
  };
}

async function updateRef(commonDir: string, ref: string, commit: string, oldValue: string): Promise<void> {
  await git(commonDir, ["--git-dir", commonDir, "update-ref", ref, commit, oldValue]);
}

async function deleteRef(commonDir: string, ref: string, expectedCommit: string): Promise<void> {
  await assertCheckpointRefCommit(commonDir, ref, expectedCommit);
  await git(commonDir, ["--git-dir", commonDir, "update-ref", "-d", ref, expectedCommit]);
}

async function assertCheckpointRef(
  commonDir: string,
  workspaceId: string,
  checkpoint: WorkspaceCheckpoint,
): Promise<void> {
  await assertCheckpointRefCommit(commonDir, checkpointRef(workspaceId, checkpoint.id), checkpoint.commit);
}

async function assertCheckpointRefCommit(commonDir: string, ref: string, expectedCommit: string): Promise<void> {
  let actual: string;
  try {
    actual = (await git(commonDir, ["--git-dir", commonDir, "rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    throw new Error(`Checkpoint Git ref ${ref} is missing; refusing to mutate inconsistent checkpoint state.`);
  }
  if (actual !== expectedCommit) {
    throw new Error(`Checkpoint Git ref ${ref} no longer matches its immutable checkpoint commit.`);
  }
}

function checkpointRef(workspaceId: string, checkpointId: string): string {
  return `${CHECKPOINT_REF_PREFIX}/${safeWorkspaceRefSegment(workspaceId)}/${checkpointId}`;
}

async function assertSameRepository(stored: string, current: string, workspaceId: string): Promise<void> {
  const [storedCanonical, currentCanonical] = await Promise.all([
    canonicalExistingPath(stored),
    canonicalExistingPath(current),
  ]);
  if (storedCanonical !== currentCanonical) {
    throw new Error(`Workspace checkpoint repository mismatch for ${workspaceId}.`);
  }
}

async function canonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function normalizeWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!/^[a-z][a-z0-9_-]{1,127}$/.test(value)) {
    throw new Error("Workspace ID is not valid for checkpoint state.");
  }
  return value;
}

function normalizeCheckpointId(checkpointId: string): string {
  const value = checkpointId.trim();
  if (!/^cp_[a-f0-9]{10}$/.test(value)) throw new Error(`Invalid checkpoint id ${checkpointId}.`);
  return value;
}

function normalizeSnapshotId(snapshotId: string): string {
  const value = snapshotId.trim();
  if (!/^[a-f0-9]{40,64}$/.test(value)) {
    throw new Error("Workspace checkpoint snapshot identity must be a Git object id.");
  }
  return value;
}

function assertExpectedCurrentSnapshot(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(
      `Workspace checkpoint restore refused because the current working snapshot changed: expected ${expected}, found ${actual}. Run restore.preflight again before retrying.`,
    );
  }
}

function normalizeCheckpointName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Checkpoint name must not be empty.");
  if (value.length > MAX_CHECKPOINT_NAME_LENGTH) {
    throw new Error(`Checkpoint name must be at most ${MAX_CHECKPOINT_NAME_LENGTH} characters.`);
  }
  return value;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Checkpoint list offset must be a non-negative integer.");
  return offset;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Checkpoint list limit must be an integer between 1 and 100.");
  }
  return limit;
}

function requireCheckpoint(
  state: PersistedWorkspaceCheckpointState,
  checkpointId: string,
): WorkspaceCheckpoint {
  const checkpoint = state.checkpoints.find((candidate) => candidate.id === checkpointId);
  if (!checkpoint) throw new Error(`Unknown Workspace checkpoint ${checkpointId}.`);
  return checkpoint;
}

function cloneCheckpoint(checkpoint: WorkspaceCheckpoint): WorkspaceCheckpoint {
  return { ...checkpoint, summary: { ...checkpoint.summary } };
}

function cloneState(state: PersistedWorkspaceCheckpointState): PersistedWorkspaceCheckpointState {
  return {
    ...state,
    checkpoints: state.checkpoints.map(cloneCheckpoint),
  };
}

function zeroOid(length: number): string {
  return "0".repeat(length);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
