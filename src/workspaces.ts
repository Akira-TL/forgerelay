import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type {
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  loadCapabilityGuides,
  markCapabilityGuideActivated,
  resolveCapabilityGuideReadPath,
  type CapabilityGuide,
  type CapabilityGuideReadResolution,
} from "./capabilities.js";
import type { ServerConfig } from "./config.js";
import { HookRunner, type HookReportContainer } from "./hooks.js";
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
  capabilityGuides: CapabilityGuide[];
  agentProfiles: LocalAgentProfile[];
  activatedSkillDirs: Set<string>;
  activatedCapabilityGuideDirs: Set<string>;
}

export interface WorkspaceContext extends HookReportContainer {
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
  capabilityGuideRead?: CapabilityGuideReadResolution;
}

export interface OpenWorkspaceInput {
  path?: string;
  workspaceId?: string;
  mode?: WorkspaceMode;
  baseRef?: string;
  newWorktree?: boolean;
  newWorkspace?: boolean;
}

export interface StaleWorkspaceSession {
  workspaceId: string;
  root: string;
  mode: WorkspaceMode;
  lastUsedAt: string;
  idleMs: number;
  branch?: string;
  targetBranch?: string;
  managed: boolean;
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
  protectedWorkspaceIds?: ReadonlySet<string>;
}

const WORKSPACE_STALE_REMINDER_MS = 2 * 24 * 60 * 60 * 1_000;
const WORKSPACE_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WORKSPACE_GC_INTERVAL_MS = 60 * 60 * 1_000;

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly pendingOpens = new Map<string, Promise<WorkspaceContext>>();
  private readonly hooks: HookRunner;
  private lastWorkspaceGcAt = 0;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.hooks = new HookRunner(config.hooks, config.logging);
    this.pruneIdleWorkspaceSessions(new Set(), true);
  }

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    this.pruneIdleWorkspaceSessions(openOptions.protectedWorkspaceIds ?? new Set());
    const workspaceInput = typeof input === "string" ? { path: input } : input;

    if (workspaceInput.workspaceId) {
      return this.resumeWorkspace(workspaceInput.workspaceId, openOptions.conversationScopeId);
    }
    if (!workspaceInput.path) {
      throw new Error("open_workspace requires either path or workspaceId.");
    }

    const mode = workspaceInput.mode ?? "checkout";
    if (mode === "worktree") {
      return this.openReusableWorktree(workspaceInput, openOptions.conversationScopeId);
    }

    return this.openReusableCheckout(
      workspaceInput.path,
      openOptions.conversationScopeId,
      workspaceInput.newWorkspace ?? false,
    );
  }

  async resumeWorkspace(
    workspaceId: string,
    conversationScopeId: string | undefined,
  ): Promise<WorkspaceContext> {
    const workspace = this.getWorkspace(workspaceId);
    const context = await this.reusedWorkspaceContext(workspace);
    if (!conversationScopeId || !this.store) {
      return { ...context, includeBootstrapContext: true };
    }

    const targetKeys = await this.workspaceTargetKeys(workspace);
    const alreadyBound = targetKeys.some((targetKey) =>
      this.store?.getConversationBinding(conversationScopeId, targetKey)?.workspaceSessionId === workspace.id
    );
    for (const targetKey of targetKeys) {
      this.store.setConversationBinding({
        conversationScopeId,
        targetKey,
        workspaceSessionId: workspace.id,
      });
    }
    return { ...context, includeBootstrapContext: !alreadyBound };
  }

  async listStaleWorkspaces(workspace: Workspace): Promise<StaleWorkspaceSession[]> {
    if (!this.store) return [];
    const now = Date.now();
    const workspaceRootKey = await canonicalPath(workspace.root);
    const stale: StaleWorkspaceSession[] = [];

    for (const session of this.store.listSessions({ status: "active", mode: workspace.mode })) {
      if (session.id === workspace.id) continue;
      const lastUsedAt = Date.parse(session.lastUsedAt);
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt < WORKSPACE_STALE_REMINDER_MS) continue;
      const root = await this.validSessionRoot(session);
      if (!root || await canonicalPath(root) !== workspaceRootKey) continue;
      stale.push({
        workspaceId: session.id,
        root,
        mode: session.mode,
        lastUsedAt: session.lastUsedAt,
        idleMs: now - lastUsedAt,
        branch: session.branch,
        targetBranch: session.targetBranch,
        managed: session.managed,
      });
    }

    return stale.sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));
  }

  closeWorkspace(workspaceId: string): void {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.mode === "worktree") {
      const aliases = this.activeSessions("worktree")
        .filter((session) => resolve(session.root) === resolve(workspace.root));
      if (aliases.length <= 1) {
        throw new Error(
          `Workspace ${workspaceId} is the last active handle for a worktree. Use close_worktree to finalize and remove the physical worktree, or keep this handle as its anchor.`,
        );
      }
    }

    if (this.store) {
      for (const binding of this.store.listConversationBindings()) {
        if (binding.workspaceSessionId === workspaceId) {
          this.store.deleteConversationBinding(binding.conversationScopeId, binding.targetKey);
        }
      }
      this.store.deleteSession(workspaceId);
    }
    this.workspaces.delete(workspaceId);
  }

  workspaceIdsForPhysicalWorkspace(workspace: Workspace): string[] {
    const root = resolve(workspace.root);
    return this.activeSessions(workspace.mode)
      .filter((session) => resolve(session.root) === root)
      .map((session) => session.id);
  }

  async listKnownWorktrees(workspace: Workspace): Promise<KnownWorkspaceWorktree[]> {
    const sourceRoot = workspace.mode === "worktree" ? workspace.sourceRoot : workspace.root;
    if (!sourceRoot) return [];

    const sourceKey = await canonicalPath(sourceRoot);
    const currentRootKey = workspace.mode === "worktree"
      ? await canonicalPath(workspace.root)
      : undefined;
    const resultsByRoot = new Map<string, KnownWorkspaceWorktree>();
    for (const session of this.activeSessions("worktree")) {
      if (!session.sourceRoot) continue;
      if (await canonicalPath(session.sourceRoot) !== sourceKey) continue;

      const root = await this.validSessionRoot(session);
      if (!root) continue;
      const rootKey = await canonicalPath(root);
      const candidate: KnownWorkspaceWorktree = {
        workspaceId: session.id,
        path: root,
        baseRef: session.baseRef ?? "HEAD",
        baseSha: session.baseSha ?? "",
        branch: session.branch,
        targetBranch: session.targetBranch,
        managed: session.managed,
        current: rootKey === currentRootKey,
      };
      const existing = resultsByRoot.get(rootKey);
      if (!existing || session.id === workspace.id) {
        resultsByRoot.set(rootKey, candidate);
      }
    }

    return [...resultsByRoot.values()];
  }

  async closeWorktree(workspaceId: string, commitMessage: string): Promise<ClosedManagedWorktree & HookReportContainer> {
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
    const hookReports = await this.hooks.run("BeforeWorktreeClose", {
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

    const aliasedWorkspaceIds = this.activeSessions("worktree")
      .filter((session) => resolve(session.root) === resolve(workspace.root))
      .map((session) => session.id);

    const result = await closeManagedWorktree({
      worktree: managedWorktree,
      commitMessage,
      config: this.config,
    });

    hookReports.push(...await this.hooks.run("AfterWorktreeClose", {
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
    }));

    for (const aliasedWorkspaceId of aliasedWorkspaceIds) {
      this.store?.setSessionStatus(aliasedWorkspaceId, "closed");
      this.workspaces.delete(aliasedWorkspaceId);
    }
    return { ...result, hookReports };
  }

  private async openReusableCheckout(
    path: string,
    conversationScopeId: string | undefined,
    newWorkspace: boolean,
  ): Promise<WorkspaceContext> {
    const allowedPath = assertAllowedPath(path, this.config.allowedRoots);
    const projectKey = await canonicalPath(allowedPath);
    const targetKey = JSON.stringify(["checkout", projectKey, null]);

    if (!newWorkspace) {
      const boundContext = await this.boundConversationContext(
        conversationScopeId,
        targetKey,
        "checkout",
        async (session, root) =>
          session.mode === "checkout" && await canonicalPath(root) === projectKey,
      );
      if (boundContext) return boundContext;
    }

    if (newWorkspace) {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(projectKey, "checkout");
      const freshContext = reusableWorkspace
        ? await this.cloneWorkspaceContext(reusableWorkspace)
        : await this.openCheckoutWorkspace(path);
      return this.withConversationContext(freshContext, conversationScopeId, targetKey);
    }

    const operationKey = this.conversationOpenKey(targetKey, conversationScopeId);
    const context = await this.openOnce(operationKey, async () => {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(projectKey, "checkout");
      if (!reusableWorkspace) return this.openCheckoutWorkspace(path);
      return conversationScopeId && this.store
        ? this.cloneWorkspaceContext(reusableWorkspace)
        : this.reusedWorkspaceContext(reusableWorkspace);
    });
    return this.withConversationContext(context, conversationScopeId, targetKey);
  }

  private async openReusableWorktree(
    input: OpenWorkspaceInput,
    conversationScopeId: string | undefined,
  ): Promise<WorkspaceContext> {
    const path = input.path;
    if (!path) throw new Error("Worktree mode requires path.");
    const managedPath = this.tryManagedWorktreePath(path);
    if (managedPath) {
      const worktreeKey = await canonicalPath(managedPath);
      const targetKey = JSON.stringify(["worktree-path", worktreeKey]);
      if (!input.newWorkspace) {
        const boundContext = await this.boundConversationContext(
          conversationScopeId,
          targetKey,
          "worktree",
          async (session, root) =>
            session.mode === "worktree" && await canonicalPath(root) === worktreeKey,
        );
        if (boundContext) return boundContext;
      }

      if (input.newWorkspace) {
        const reusableWorkspace = await this.findReusableWorkspaceByDirectory(worktreeKey, "worktree");
        if (!reusableWorkspace) {
          throw new Error(
            `Managed worktree is not registered as an active ForgeRelay workspace: ${managedPath}. Open the source project in worktree mode to create or recover a managed worktree first.`,
          );
        }
        return this.withConversationContext(
          await this.cloneWorkspaceContext(reusableWorkspace),
          conversationScopeId,
          targetKey,
        );
      }

      const operationKey = this.conversationOpenKey(targetKey, conversationScopeId);
      const context = await this.openOnce(operationKey, async () => {
        const reusableWorkspace = await this.findReusableWorkspaceByDirectory(worktreeKey, "worktree");
        if (!reusableWorkspace) {
          throw new Error(
            `Managed worktree is not registered as an active ForgeRelay workspace: ${managedPath}. Open the source project in worktree mode to create or recover a managed worktree first.`,
          );
        }
        return conversationScopeId && this.store
          ? this.cloneWorkspaceContext(reusableWorkspace)
          : this.reusedWorkspaceContext(reusableWorkspace);
      });
      return this.withConversationContext(context, conversationScopeId, targetKey);
    }

    const resolvedBase = await resolveManagedWorktreeBase({
      sourcePath: path,
      baseRef: input.baseRef,
      config: this.config,
    });
    const sourceKey = await canonicalPath(resolvedBase.sourceRoot);
    const targetKey = JSON.stringify(["worktree", sourceKey, resolvedBase.targetBranch]);

    if (input.newWorktree) {
      const context = await this.openWorktreeWorkspace(path, input.baseRef);
      return this.withConversationContext(context, conversationScopeId, targetKey);
    }

    if (!input.newWorkspace) {
      const boundContext = await this.boundConversationContext(
        conversationScopeId,
        targetKey,
        "worktree",
        async (session) =>
          session.mode === "worktree" &&
          session.sourceRoot !== undefined &&
          await canonicalPath(session.sourceRoot) === sourceKey &&
          session.targetBranch === resolvedBase.targetBranch,
      );
      if (boundContext) return boundContext;
    }

    if (input.newWorkspace) {
      const reusableWorkspace = await this.findReusableWorktreeBySource(
        sourceKey,
        resolvedBase.targetBranch,
      );
      const freshContext = reusableWorkspace
        ? await this.cloneWorkspaceContext(reusableWorkspace)
        : await this.openWorktreeWorkspace(path, input.baseRef);
      return this.withConversationContext(freshContext, conversationScopeId, targetKey);
    }

    const operationKey = this.conversationOpenKey(targetKey, conversationScopeId);
    const context = await this.openOnce(operationKey, async () => {
      const reusableWorkspace = await this.findReusableWorktreeBySource(
        sourceKey,
        resolvedBase.targetBranch,
      );
      if (!reusableWorkspace) return this.openWorktreeWorkspace(path, input.baseRef);
      return conversationScopeId && this.store
        ? this.cloneWorkspaceContext(reusableWorkspace)
        : this.reusedWorkspaceContext(reusableWorkspace);
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

  private async workspaceTargetKeys(workspace: Workspace): Promise<string[]> {
    if (workspace.mode === "checkout") {
      return [JSON.stringify(["checkout", await canonicalPath(workspace.root), null])];
    }

    const keys = [JSON.stringify(["worktree-path", await canonicalPath(workspace.root)])];
    if (workspace.sourceRoot && workspace.worktree?.targetBranch) {
      keys.push(JSON.stringify([
        "worktree",
        await canonicalPath(workspace.sourceRoot),
        workspace.worktree.targetBranch,
      ]));
    }
    return keys;
  }

  private conversationOpenKey(
    targetKey: string,
    conversationScopeId: string | undefined,
  ): string {
    return conversationScopeId && this.store
      ? JSON.stringify(["conversation", conversationScopeId, targetKey])
      : targetKey;
  }

  private async boundConversationContext(
    conversationScopeId: string | undefined,
    targetKey: string,
    mode: WorkspaceMode,
    matches: (session: WorkspaceSession, root: string) => Promise<boolean>,
  ): Promise<WorkspaceContext | undefined> {
    if (!conversationScopeId || !this.store) return undefined;

    const binding = this.store.getConversationBinding(conversationScopeId, targetKey);
    if (!binding) return undefined;

    const session = this.store.getSession(binding.workspaceSessionId);
    if (!session || session.status !== "active" || session.mode !== mode) {
      this.store.deleteConversationBinding(conversationScopeId, targetKey);
      return undefined;
    }

    const root = await this.validSessionRoot(session);
    if (!root) {
      this.store.deleteConversationBinding(conversationScopeId, targetKey);
      return undefined;
    }
    if (!await matches(session, root)) {
      this.store.deleteConversationBinding(conversationScopeId, targetKey);
      return undefined;
    }

    const context = await this.reusedWorkspaceContext(this.getWorkspace(session.id));
    this.store.touchConversationBinding(conversationScopeId, targetKey);
    return { ...context, includeBootstrapContext: false };
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

  private pruneIdleWorkspaceSessions(
    protectedWorkspaceIds: ReadonlySet<string>,
    force = false,
  ): void {
    if (!this.store) return;
    const now = Date.now();
    if (!force && now - this.lastWorkspaceGcAt < WORKSPACE_GC_INTERVAL_MS) return;
    this.lastWorkspaceGcAt = now;

    const activeSessions = this.store.listSessions({ status: "active" });
    const sessionsById = new Map(activeSessions.map((session) => [session.id, session]));
    const isIdle = (session: WorkspaceSession): boolean => {
      const lastUsedAt = Date.parse(session.lastUsedAt);
      return Number.isFinite(lastUsedAt) && now - lastUsedAt >= WORKSPACE_SESSION_IDLE_TTL_MS;
    };

    for (const binding of this.store.listConversationBindings()) {
      const session = sessionsById.get(binding.workspaceSessionId);
      if (!session) {
        this.store.deleteConversationBinding(binding.conversationScopeId, binding.targetKey);
      }
    }

    const boundWorkspaceIds = new Set(
      this.store.listConversationBindings().map((binding) => binding.workspaceSessionId),
    );
    const worktreeAnchors = new Map<string, WorkspaceSession>();
    for (const session of activeSessions) {
      if (session.mode !== "worktree") continue;
      const key = resolve(session.root);
      const current = worktreeAnchors.get(key);
      if (!current || current.lastUsedAt < session.lastUsedAt) {
        worktreeAnchors.set(key, session);
      }
    }

    for (const session of activeSessions) {
      if (!isIdle(session)) continue;
      if (protectedWorkspaceIds.has(session.id) || boundWorkspaceIds.has(session.id)) continue;
      if (
        session.mode === "worktree" &&
        worktreeAnchors.get(resolve(session.root))?.id === session.id
      ) {
        continue;
      }
      this.store.deleteSession(session.id);
      this.workspaces.delete(session.id);
    }
  }

  private async findReusableWorkspaceByDirectory(
    directoryKey: string,
    mode: WorkspaceMode,
  ): Promise<Workspace | undefined> {
    for (const session of this.activeSessions(mode)) {
      const root = await this.validSessionRoot(session);
      if (!root) continue;
      if (await canonicalPath(root) !== directoryKey) continue;
      return this.workspaceFromSession(session, false);
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
      return this.workspaceFromSession(session, false);
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

  private async cloneWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    return this.createWorkspaceContext({
      root: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      worktree: workspace.worktree ? { ...workspace.worktree } : undefined,
    });
  }

  private async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      hookReports: [],
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

    return this.workspaceFromSession(session, true);
  }

  private workspaceFromSession(session: WorkspaceSession, touch: boolean): Workspace {
    const existing = this.workspaces.get(session.id);
    if (existing) {
      if (touch) this.store?.touchSession(session.id);
      return existing;
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
      capabilityGuides: loadCapabilityGuides(),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
    };
    if (touch) this.store?.touchSession(session.id);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    return restoredWorkspace;
  }

  fileToolRoots(workspace: Workspace): string[] {
    return [workspace.root, tmpdir()];
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
      if (skillRead) {
        return {
          absolutePath: skillRead.absolutePath,
          readRoots: [workspace.root, skillRead.skill.baseDir],
          skillRead,
        };
      }

      const capabilityGuideRead = resolveCapabilityGuideReadPath(
        workspace.capabilityGuides,
        workspace.activatedCapabilityGuideDirs,
        inputPath,
      );
      if (capabilityGuideRead) {
        return {
          absolutePath: capabilityGuideRead.absolutePath,
          readRoots: [workspace.root, capabilityGuideRead.guide.baseDir],
          capabilityGuideRead,
        };
      }

      try {
        return {
          absolutePath: resolveAllowedPath(inputPath, workspace.root, [tmpdir()]),
          readRoots: this.fileToolRoots(workspace),
        };
      } catch {
        throw workspaceError;
      }
    }
  }

  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    if (readPath.skillRead?.isSkillFile) {
      markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
    }
    if (readPath.capabilityGuideRead?.isGuideFile) {
      markCapabilityGuideActivated(
        workspace.activatedCapabilityGuideDirs,
        readPath.capabilityGuideRead.guide,
      );
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
      capabilityGuides: loadCapabilityGuides(),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
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
    const hookReports = await this.hooks.run("WorkspaceOpen", {
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
      hookReports,
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
    const loadedRealPaths = new Set<string>();
    const systemInstructions = await readSystemInstructions(systemInstructionsPath);
    const systemInstructionsRealPath = await tryRealpath(systemInstructionsPath);

    if (systemInstructions !== undefined) {
      loadedFiles.push({
        path: systemInstructionsPath,
        content: systemInstructions,
      });
      if (systemInstructionsRealPath) loadedRealPaths.add(systemInstructionsRealPath);
    }

    for (const fileName of CONTEXT_FILE_NAMES) {
      const path = join(root, fileName);
      const content = await readResolvedProjectContextFile(path, resolvedRoot);
      if (content === undefined) continue;

      const realPath = await tryRealpath(path);
      if (realPath && loadedRealPaths.has(realPath)) continue;

      loadedFiles.push({
        path,
        content,
      });
      if (realPath) loadedRealPaths.add(realPath);
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
