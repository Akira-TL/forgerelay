import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "../../runtime/state/lock/file-lock.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID_PATTERN = /^proj_[a-f0-9]{20}$/;
const PROJECTS_INDEX_VERSION = 1;
const GIT_PROJECT_STATE_DIR = "forgerelay";
const GIT_PROJECT_ID_FILE = "project-id";
const NON_GIT_INDEX_FILE = "non-git-identities.json";

export type ProjectKind = "git" | "non-git";

export interface ProjectContext {
  id: string;
  kind: ProjectKind;
  /** Current checkout/worktree root that owns project-shared `.forgerelay/` config. */
  projectRoot: string;
  /** Active ForgeRelay configuration root used by this Execution ForgeRelay. */
  configDir: string;
  sharedConfigDir: string;
  localConfigDir: string;
  gitCommonDir?: string;
  canonicalRoot?: string;
}

interface NonGitIdentityIndex {
  version: 1;
  projects: Record<string, string>;
}

interface GitProjectLocation {
  projectRoot: string;
  gitCommonDir: string;
}

export async function resolveProjectContext(configDir: string, workspaceRoot: string): Promise<ProjectContext> {
  return new ProjectContextResolver(configDir).resolve(workspaceRoot);
}

export class ProjectContextResolver {
  private readonly configDir: string;
  private readonly projectsDir: string;

  constructor(configDir: string) {
    this.configDir = resolve(configDir);
    this.projectsDir = join(this.configDir, "projects");
  }

  async resolve(workspaceRoot: string): Promise<ProjectContext> {
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);
    const git = await resolveGitProject(canonicalWorkspaceRoot);
    if (git) {
      const id = await resolveGitProjectId(git.gitCommonDir);
      return {
        id,
        kind: "git",
        projectRoot: git.projectRoot,
        configDir: this.configDir,
        sharedConfigDir: join(git.projectRoot, ".forgerelay"),
        localConfigDir: join(this.projectsDir, id),
        gitCommonDir: git.gitCommonDir,
      };
    }

    const id = await this.resolveNonGitProjectId(canonicalWorkspaceRoot);
    return {
      id,
      kind: "non-git",
      projectRoot: canonicalWorkspaceRoot,
      configDir: this.configDir,
      sharedConfigDir: join(canonicalWorkspaceRoot, ".forgerelay"),
      localConfigDir: join(this.projectsDir, id),
      canonicalRoot: canonicalWorkspaceRoot,
    };
  }

  private async resolveNonGitProjectId(canonicalRoot: string): Promise<string> {
    await mkdir(this.projectsDir, { recursive: true, mode: 0o700 });
    const indexPath = join(this.projectsDir, NON_GIT_INDEX_FILE);
    return withFileLock(`${indexPath}.lock`, async () => {
      const index = await readNonGitIdentityIndex(indexPath);
      const existing = index.projects[canonicalRoot];
      if (existing) return existing;

      const id = newProjectId();
      index.projects[canonicalRoot] = id;
      await writeJsonAtomic(indexPath, index);
      return id;
    });
  }
}

async function resolveGitProject(workspaceRoot: string): Promise<GitProjectLocation | undefined> {
  try {
    const [{ stdout: rootOutput }, { stdout: commonDirOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot }),
      execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot }),
    ]);
    const rawProjectRoot = rootOutput.trim();
    const rawCommonDir = commonDirOutput.trim();
    if (!rawProjectRoot || !rawCommonDir) return undefined;
    const projectRoot = await realpath(rawProjectRoot);
    const gitCommonDir = await realpath(
      isAbsolute(rawCommonDir) ? rawCommonDir : resolve(workspaceRoot, rawCommonDir),
    );
    return { projectRoot, gitCommonDir };
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      if (await hasGitMetadataAncestor(workspaceRoot)) {
        throw new Error(
          `Git is required to resolve canonical ForgeRelay Project identity for Git workspace ${workspaceRoot}.`,
        );
      }
      return undefined;
    }
    if (isGitRepositoryMiss(error)) return undefined;
    throw error;
  }
}

async function resolveGitProjectId(gitCommonDir: string): Promise<string> {
  const stateDir = join(gitCommonDir, GIT_PROJECT_STATE_DIR);
  const idPath = join(stateDir, GIT_PROJECT_ID_FILE);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  return withFileLock(`${idPath}.lock`, async () => {
    const existing = await readProjectId(idPath);
    if (existing !== undefined) return existing;

    const id = newProjectId();
    const tempPath = `${idPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${id}\n`, { mode: 0o600, flag: "wx" });
      await rename(tempPath, idPath);
    } finally {
      await rm(tempPath, { force: true });
    }
    return id;
  });
}

async function readProjectId(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  const id = raw.trim();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new Error(`ForgeRelay Project identity has an invalid format: ${path}`);
  }
  return id;
}

async function readNonGitIdentityIndex(path: string): Promise<NonGitIdentityIndex> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { version: PROJECTS_INDEX_VERSION, projects: {} };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`ForgeRelay non-Git Project identity index is not valid JSON: ${path}`);
  }
  if (!isRecord(parsed) || parsed.version !== PROJECTS_INDEX_VERSION || !isRecord(parsed.projects)) {
    throw new Error(`ForgeRelay non-Git Project identity index has an unsupported format: ${path}`);
  }
  const projects: Record<string, string> = {};
  for (const [root, id] of Object.entries(parsed.projects)) {
    if (!root || typeof id !== "string" || !PROJECT_ID_PATTERN.test(id)) {
      throw new Error(`ForgeRelay non-Git Project identity index contains an invalid entry: ${path}`);
    }
    projects[root] = id;
  }
  return { version: PROJECTS_INDEX_VERSION, projects };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function newProjectId(): string {
  return `proj_${randomBytes(10).toString("hex")}`;
}

async function hasGitMetadataAncestor(workspaceRoot: string): Promise<boolean> {
  let current = workspaceRoot;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = resolve(current, "..");
    if (parent === current) return false;
    current = parent;
  }
}

function isGitRepositoryMiss(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const stderr = typeof error.stderr === "string" ? error.stderr.toLowerCase() : "";
  return stderr.includes("not a git repository") || stderr.includes("not a git repo");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
