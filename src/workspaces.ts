import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type {
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { HookRunner } from "./hooks.js";
import {
  closeManagedWorktree,
  createManagedWorktree,
  resolveManagedWorktreeBase,
  type ClosedManagedWorktree,
  type ManagedWorktree,
} from "./git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./skills.js";
import {
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";

export interface LoadedAgentsFile {
  path: string;
  content: string;
}

export interface AvailableAgentsFile {
  path: string;
}

export interface WorkspaceWorktree {
  path: string;
  baseRef: string;
  baseSha: string;
  branch?: string;
  targetBranch?: string;
  dirtySource: boolean;
  detached: boolean;
  managed: boolean;
}

export interface Workspace {
  id: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  worktree?: WorkspaceWorktree;
  skills: LoadedSkills["skills"];
  skillDiagnostics: LoadedSkills["diagnostics"];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
}

export interface WorkspaceContext {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  workspaceReused: boolean;
  includeBootstrapContext: boolean;
}

export interface WorkspaceReadPath {
  absolutePath: string;
  readRoots: string[];
  skillRead?: SkillReadResolution;
}

export interface OpenWorkspaceInput {
  path: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  newWorktree?: boolean;
}

export interface KnownWorkspaceWorktree {
  workspaceId: string;
  path: string;
  baseRef: string;
  baseSha: string;
  branch?: string;
  targetBranch?: string;
  managed: boolean;
  current: boolean;
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
}

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingOpens = new Map<string, Promise<WorkspaceContext>>();
  private readonly hooks: HookRunner;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.hooks = new HookRunner(config.hooks, config.logging);
  }

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    const workspaceInput = typeof input === "string" ? { path: input } : input;
    const mode = workspaceInput.mode ?? "checkout";

    if (mode === "worktree") {
      return this.openReusableWorktree(workspaceInput, openOptions.conversationScopeId);
    }

    return this.openReusableCheckout(workspaceInput.path, openOptions.conversationScopeId);
  }

  async listKnownWorktrees(workspace: Workspace): Promise<KnownWorkspaceWorktree[]> {
    const sourceRoot = workspace.mode === "worktree" ? workspace.sourceRoot : workspace.root;
    if (!sourceRoot) return [];

    const sourceKey = await canonicalPath(sourceRoot);
    const results: KnownWorkspaceWorktree[] = [];
    for (const session of this.activeSessions("worktree")) {
      if (!session.sourceRoot) continue;
      if (await canonicalPath(session.sourceRoot) !== sourceKey) continue;

      const root = await this.validSessionRoot(session);
      if (!root) continue;
      results.push({
        workspaceId: session.id,
        path: root,
        baseRef: session.baseRef ?? "HEAD",
        baseSha: session.baseSha ?? "",
        branch: session.branch,
        targetBranch: session.targetBranch,
        managed: session.managed,
        current: session.id === workspace.id,
      });
    }

    return results;
  }

  async closeWorktree(workspaceId: string, commitMessage: string): Promise<ClosedManagedWorktree> {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.mode !== "worktree" || !workspace.worktree?.managed || !workspace.sourceRoot) {
      throw new Error(`Workspace ${workspaceId} is not a managed worktree workspace.`);
    }
    if (
      workspace.worktree.detached ||
      !workspace.worktree.branch ||
      !workspace.worktree.targetBranch
    ) {
      throw new Error(
        `Workspace ${workspaceId} is a legacy detached worktree and cannot use the managed close lifecycle. Create a branch for it explicitly or open a new managed worktree.`,
      );
    }

    const managedWorktree: ManagedWorktree = {
      sourceRoot: workspace.sourceRoot,
      path: workspace.worktree.path,
      baseRef: workspace.worktree.baseRef,
      baseSha: workspace.worktree.baseSha,
      branch: workspace.worktree.branch,
      targetBranch: workspace.worktree.targetBranch,
      dirtySource: workspace.worktree.dirtySource,
      detached: false,
      managed: true,
    };
    await this.hooks.run("BeforeWorktreeClose", {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      workspaceMode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      payload: {
        commitMessage,
        branch: managedWorktree.branch,
        targetBranch: managedWorktree.targetBranch,
      },
    });

    const result = await closeManagedWorktree({
      worktree: managedWorktree,
      commitMessage,
      config: this.config,
    });

    await this.hooks.run("AfterWorktreeClose", {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      workspaceMode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      cwd: result.sourceRoot,
      payload: {
        commitMessage,
        branch: result.branch,
        targetBranch: result.targetBranch,
        commitSha: result.commitSha,
        mergedSha: result.mergedSha,
        committed: result.committed,
        cleanupWarning: result.cleanupWarning,
      },
    });

    this.store?.setSessionStatus(workspace.id, "closed");
    this.workspaces.delete(workspace.id);
    return result;
  }

  private async openReusableCheckout(
    path: string,
    conversationScopeId: string | undefined,
  ): Promise<WorkspaceContext> {
    const allowedPath = assertAllowedPath(path, this.config.allowedRoots);
    const projectKey = await canonicalPath(allowedPath);
    const targetKey = JSON.stringify(["checkout", projectKey, null]);

    const context = await this.openOnce(targetKey, async () => {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(projectKey, "checkout");
      return reusableWorkspace
        ? this.reusedWorkspaceContext(reusableWorkspace)
        : this.openCheckoutWorkspace(path);
    });
    return this.withConversationContext(context, conversationScopeId, targetKey);
  }

  private async openReusableWorktree(
    input: OpenWorkspaceInput,
    conversationScopeId: string | undefined,
  ): Promise<WorkspaceContext> {
    const managedPath = this.tryManagedWorktreePath(input.path);
    if (managedPath) {
      const worktreeKey = await canonicalPath(managedPath);
      const targetKey = JSON.stringify(["worktree-path", worktreeKey]);
      const context = await this.openOnce(targetKey, async () => {
        const reusableWorkspace = await this.findReusableWorkspaceByDirectory(worktreeKey, "worktree");
        if (!reusableWorkspace) {
          throw new Error(
            `Managed worktree is not registered as an active ForgeRelay workspace: ${managedPath}. Open the source project in worktree mode to create or recover a managed worktree first.`,
          );
        }
        return this.reusedWorkspaceContext(reusableWorkspace);
      });
      return this.withConversationContext(context, conversationScopeId, targetKey);
    }

    const resolvedBase = await resolveManagedWorktreeBase({
      sourcePath: input.path,
      baseRef: input.baseRef,
      config: this.config,
    });
    const sourceKey = await canonicalPath(resolvedBase.sourceRoot);
    const targetKey = JSON.stringify(["worktree", sourceKey, resolvedBase.targetBranch]);

    if (input.newWorktree) {
      const context = await this.openWorktreeWorkspace(input.path, input.baseRef);
      return this.withConversationContext(context, conversationScopeId, targetKey);
    }

    const context = await this.openOnce(targetKey, async () => {
      const reusableWorkspace = await this.findReusableWorktreeBySource(
        sourceKey,
        resolvedBase.targetBranch,
      );
      return reusableWorkspace
        ? this.reusedWorkspaceContext(reusableWorkspace)
        : this.openWorktreeWorkspace(input.path, input.baseRef);
    });
    return this.withConversationContext(context, conversationScopeId, targetKey);
  }

  private async openOnce(
    operationKey: string,
    open: () => Promise<WorkspaceContext>,
  ): Promise<WorkspaceContext> {
    const pending = this.pendingOpens.get(operationKey);
    if (pending) {
      const context = await pending;
      return { ...context, workspaceReused: true };
    }

    const operation = open();
    this.pendingOpens.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingOpens.get(operationKey) === operation) {
        this.pendingOpens.delete(operationKey);
      }
    }
  }

  private withConversationContext(
    context: WorkspaceContext,
    conversationScopeId: string | undefined,
    targetKey: string,
  ): WorkspaceContext {
    if (!conversationScopeId || !this.store) {
      return { ...context, includeBootstrapContext: true };
    }

    const binding = this.store.getConversationBinding(conversationScopeId, targetKey);
    if (binding?.workspaceSessionId === context.workspace.id) {
      this.store.touchConversationBinding(conversationScopeId, targetKey);
      return { ...context, includeBootstrapContext: false };
    }

    this.store.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    return { ...context, includeBootstrapContext: true };
  }

  private async findReusableWorkspaceByDirectory(
    directoryKey: string,
    mode: WorkspaceMode,
  ): Promise<Workspace | undefined> {
    for (const session of this.activeSessions(mode)) {
      const root = await this.validSessionRoot(session);
      if (!root) continue;
      if (await canonicalPath(root) !== directoryKey) continue;
      return this.getWorkspace(session.id);
    }
    return undefined;
  }

  private async findReusableWorktreeBySource(
    sourceKey: string,
    targetBranch: string,
  ): Promise<Workspace | undefined> {
    for (const session of this.activeSessions("worktree")) {
      if (!session.sourceRoot || session.targetBranch !== targetBranch) continue;
      if (await canonicalPath(session.sourceRoot) !== sourceKey) continue;
      const root = await this.validSessionRoot(session);
      if (!root) continue;
      return this.getWorkspace(session.id);
    }
    return undefined;
  }

  private activeSessions(mode: WorkspaceMode): WorkspaceSession[] {
    if (this.store) {
      return this.store.listSessions({ status: "active", mode });
    }

    return [...this.workspaces.values()]
      .filter((workspace) => workspace.mode === mode)
      .map((workspace) => ({
        id: workspace.id,
        root: workspace.root,
        status: "active",
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        baseRef: workspace.worktree?.baseRef,
        baseSha: workspace.worktree?.baseSha,
        branch: workspace.worktree?.branch,
        targetBranch: workspace.worktree?.targetBranch,
        managed: workspace.worktree?.managed ?? false,
        createdAt: "",
        lastUsedAt: "",
      }));
  }

  private async validSessionRoot(session: WorkspaceSession): Promise<string | undefined> {
    try {
      const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      return rootStats.isDirectory() ? root : undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private tryManagedWorktreePath(path: string): string | undefined {
    try {
      return assertAllowedPath(path, [this.config.worktreeRoot]);
    } catch (error) {
      if (error instanceof AccessDeniedError) return undefined;
      throw error;
    }
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  getWorkspace(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) {
      this.store?.touchSession(workspaceId);
      return workspace;
    }

    const session = this.store?.getSession(workspaceId);
    if (!session || session.status !== "active") {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }

    const root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree:
        session.mode === "worktree"
          ? {
              path: root,
              baseRef: session.baseRef ?? "HEAD",
              baseSha: session.baseSha ?? "",
              branch: session.branch,
              targetBranch: session.targetBranch,
              dirtySource: false,
              detached: !session.branch,
              managed: session.managed,
            }
          : undefined,
      ...this.loadSkillsForWorkspace(root),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
    };
    this.store?.touchSession(workspaceId);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);

    return restoredWorkspace;
  }

  resolvePath(workspace: Workspace, inputPath: string): string {
    const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
    if (!isPathInsideRoot(absolutePath, workspace.root)) {
      throw new Error(`Path is outside workspace root: ${inputPath}`);
    }

    return absolutePath;
  }

  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    try {
      return {
        absolutePath: this.resolvePath(workspace, inputPath),
        readRoots: [workspace.root],
      };
    } catch (workspaceError) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) throw workspaceError;

      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
    return assertAllowedPath(directory, [workspace.root]);
  }

  private async openCheckoutWorkspace(path: string): Promise<WorkspaceContext> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const rootStats = await ensureCheckoutWorkspaceRoot(root);
    if (!rootStats.isDirectory()) {
      throw new Error(`Workspace root must be a directory: ${path}`);
    }

    return this.createWorkspaceContext({ root, mode: "checkout" });
  }

  private async openWorktreeWorkspace(path: string, baseRef: string | undefined): Promise<WorkspaceContext> {
    const worktree = await createManagedWorktree({
      sourcePath: path,
      baseRef,
      config: this.config,
    });

    return this.createWorkspaceContext({
      root: worktree.path,
      mode: "worktree",
      sourceRoot: worktree.sourceRoot,
      worktree,
    });
  }

  private async createWorkspaceContext(input: {
    root: string;
    mode: WorkspaceMode;
    sourceRoot?: string;
    worktree?: WorkspaceWorktree;
  }): Promise<WorkspaceContext> {
    const workspace: Workspace = {
      id: `ws_${randomBytes(5).toString("hex")}`,
      root: input.root,
      mode: input.mode,
      sourceRoot: input.sourceRoot,
      worktree: input.worktree,
      ...this.loadSkillsForWorkspace(input.root),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
    };

    this.store?.createSession({
      id: workspace.id,
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      baseRef: workspace.worktree?.baseRef,
      baseSha: workspace.worktree?.baseSha,
      branch: workspace.worktree?.branch,
      targetBranch: workspace.worktree?.targetBranch,
      managed: workspace.worktree?.managed,
    });
    this.workspaces.set(workspace.id, workspace);
    await this.hooks.run("WorkspaceOpen", {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      workspaceMode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      payload: {
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        branch: workspace.worktree?.branch,
        targetBranch: workspace.worktree?.targetBranch,
      },
    });
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      workspaceReused: false,
      includeBootstrapContext: true,
    };
  }

  private loadSkillsForWorkspace(root: string): Pick<Workspace, "skills" | "skillDiagnostics"> {
    const result = loadWorkspaceSkills(this.config, root);
    return {
      skills: result.skills,
      skillDiagnostics: result.diagnostics,
    };
  }

  private assertWorkspaceRootAllowed(root: string, mode: WorkspaceMode, sourceRoot: string | undefined): string {
    if (mode === "worktree") {
      if (!sourceRoot) {
        throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
      }
      assertAllowedPath(sourceRoot, this.config.allowedRoots);
      return assertAllowedPath(root, [this.config.worktreeRoot]);
    }

    return assertAllowedPath(root, this.config.allowedRoots);
  }

  private async loadInitialAgentsFiles(root: string): Promise<LoadedAgentsFile[]> {
    const resolvedRoot = (await tryRealpath(root)) ?? root;
    const systemInstructionsPath = resolve(this.config.systemInstructionsPath);
    const loadedFiles: LoadedAgentsFile[] = [];
    const systemInstructions = await readSystemInstructions(systemInstructionsPath);
    const systemInstructionsRealPath = await tryRealpath(systemInstructionsPath);

    if (systemInstructions !== undefined) {
      loadedFiles.push({
        path: systemInstructionsPath,
        content: systemInstructions,
      });
    }

    for (const fileName of CONTEXT_FILE_NAMES) {
      const path = join(root, fileName);
      const content = await readResolvedProjectContextFile(path, resolvedRoot);
      if (content === undefined) continue;

      const realPath = await tryRealpath(path);
      if (systemInstructionsRealPath && realPath === systemInstructionsRealPath) continue;

      loadedFiles.push({
        path,
        content,
      });
    }

    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    root: string,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const loadedRealPaths = new Set<string>();
    for (const file of loadedFiles) {
      const realPath = await tryRealpath(file.path);
      if (realPath) loadedRealPaths.add(realPath);
    }
    const discovered: AvailableAgentsFile[] = [];

    const agentDir = resolve(this.config.agentDir);

    await walkWorkspace(root, async (path, entry) => {
      if (isPathInsideRoot(path, agentDir)) return;
      if (!entry.isFile()) return;
      if (!CONTEXT_FILE_NAMES.has(entry.name)) return;
      if (loadedPaths.has(path)) return;
      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) return;

      discovered.push({ path });
    });

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }
}

async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".forgerelay",
  ".devspace",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export function formatAgentsPath(path: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return path.split(sep).join("/");

  const relationship = relative(workspaceRoot, path);
  if (
    relationship === "" ||
    relationship.startsWith("..") ||
    relationship === ".." ||
    relationship.includes(`..${sep}`)
  ) {
    return path.split(sep).join("/");
  }

  return relationship.split(sep).join("/");
}

function isProjectRootInstructionPath(path: string, root: string): boolean {
  return isPathInsideRoot(path, root) && dirname(path) === root;
}

async function readSystemInstructions(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

async function readResolvedProjectContextFile(path: string, root: string): Promise<string | undefined> {
  try {
    const resolvedPath = await realpath(path);
    if (!isProjectRootInstructionPath(resolvedPath, root)) return undefined;
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }

  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
        await walkWorkspace(path, visit);
      }
      continue;
    }

    await visit(path, entry);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
