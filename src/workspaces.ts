import { createHash, randomBytes } from "node:crypto";
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
} from "./subagents/profiles.js";

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
  scannedInstructionDirs: Set<string>;
  knownInstructionPathsByDir: Map<string, string[]>;
  loadedInstructionRealPaths: Set<string>;
}

export type WorkspaceBootstrapContextMode = "auto" | "full" | "none";

export interface WorkspaceContext extends HookReportContainer {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  contextFingerprint: string;
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
  context?: WorkspaceBootstrapContextMode;
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

export type WorkspaceInventoryState = "active" | "stale" | "invalid" | "closed";

export interface WorkspaceInventoryEntry {
  label: string;
  workspaceId: string;
  root: string;
  status: string;
  state: WorkspaceInventoryState;
  mode: WorkspaceMode;
  sourceRoot?: string;
  branch?: string;
  targetBranch?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
  idleMs: number;
  rootValid: boolean;
  current: boolean;
}

export interface WorkspaceInventoryInput {
  workspaceId?: string;
  status?: string;
  state?: WorkspaceInventoryState;
  mode?: WorkspaceMode;
  root?: string;
  staleOnly?: boolean;
  offset?: number;
  limit?: number;
}

export interface WorkspaceInventoryResult {
  workspaces: WorkspaceInventoryEntry[];
  summary: {
    total: number;
    matching: number;
    active: number;
    stale: number;
    invalid: number;
    closed: number;
  };
  page: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
}

export interface OpenWorkspaceOptions {
  conversationScopeId?: string;
  protectedWorkspaceIds?: ReadonlySet<string>;
}

const WORKSPACE_STALE_REMINDER_MS = 2 * 24 * 60 * 60 * 1_000;
const WORKSPACE_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WORKSPACE_GC_INTERVAL_MS = 60 * 60 * 1_000;
const INITIAL_INSTRUCTION_DISCOVERY_DEPTH = 1;

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

  get cachedWorkspaceCount(): number {
    return this.workspaces.size;
  }

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    this.pruneIdleWorkspaceSessions(openOptions.protectedWorkspaceIds ?? new Set());
    const workspaceInput = typeof input === "string" ? { path: input } : input;

    const bootstrapContext = workspaceInput.context ?? "auto";

    if (workspaceInput.workspaceId) {
      return this.resumeWorkspace(
        workspaceInput.workspaceId,
        openOptions.conversationScopeId,
        bootstrapContext,
      );
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
      bootstrapContext,
    );
  }

  async listWorkspaces(
    input: WorkspaceInventoryInput = {},
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceInventoryResult> {
    this.pruneIdleWorkspaceSessions(openOptions.protectedWorkspaceIds ?? new Set());
    const now = Date.now();
    const sessions = this.store
      ? this.store.listSessions()
      : [...this.workspaces.values()].map((workspace) => ({
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
        } satisfies WorkspaceSession));
    const currentWorkspaceIds = new Set(
      openOptions.conversationScopeId && this.store
        ? this.store
            .listConversationBindings()
            .filter((binding) => binding.conversationScopeId === openOptions.conversationScopeId)
            .map((binding) => binding.workspaceSessionId)
        : [],
    );
    const rootKey = input.root
      ? await canonicalPath(assertAllowedPath(
          input.root,
          [...this.config.allowedRoots, this.config.worktreeRoot],
        ))
      : undefined;
    const entries = await Promise.all(sessions.map(async (session): Promise<WorkspaceInventoryEntry> => {
      const rootValid = await this.validSessionRoot(session) !== undefined;
      const lastUsedAt = Date.parse(session.lastUsedAt);
      const idleMs = Number.isFinite(lastUsedAt) ? Math.max(0, now - lastUsedAt) : 0;
      const state: WorkspaceInventoryState = session.status !== "active"
        ? "closed"
        : !rootValid
          ? "invalid"
          : idleMs >= WORKSPACE_STALE_REMINDER_MS
            ? "stale"
            : "active";
      const projectRoot = session.sourceRoot ?? session.root;
      return {
        label: `${basename(resolve(projectRoot)) || "workspace"}/${session.id}`,
        workspaceId: session.id,
        root: session.root,
        status: session.status,
        state,
        mode: session.mode,
        sourceRoot: session.sourceRoot,
        branch: session.branch,
        targetBranch: session.targetBranch,
        managed: session.managed,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        idleMs,
        rootValid,
        current: currentWorkspaceIds.has(session.id),
      };
    }));
    const filtered: WorkspaceInventoryEntry[] = [];
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const entry = entries[index];
      if (!session || !entry) continue;
      if (input.workspaceId && entry.workspaceId !== input.workspaceId) continue;
      if (input.status && entry.status !== input.status) continue;
      if (input.state && entry.state !== input.state) continue;
      if (input.mode && entry.mode !== input.mode) continue;
      if (input.staleOnly && entry.state !== "stale") continue;
      if (rootKey) {
        const sessionRootKey = await canonicalPath(session.root);
        const sourceRootKey = session.sourceRoot ? await canonicalPath(session.sourceRoot) : undefined;
        if (sessionRootKey !== rootKey && sourceRootKey !== rootKey) continue;
      }
      filtered.push(entry);
    }
    const summary = filtered.reduce(
      (counts, entry) => {
        counts[entry.state] += 1;
        return counts;
      },
      { active: 0, stale: 0, invalid: 0, closed: 0 },
    );
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));

    return {
      workspaces: filtered.slice(offset, offset + limit),
      summary: {
        total: entries.length,
        matching: filtered.length,
        ...summary,
      },
      page: {
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
      },
    };
  }

  async resumeWorkspace(
    workspaceId: string,
    conversationScopeId: string | undefined,
    bootstrapContext: WorkspaceBootstrapContextMode = "auto",
  ): Promise<WorkspaceContext> {
    const workspace = this.getWorkspace(workspaceId);
    const context = await this.reusedWorkspaceContext(workspace);
    if (!conversationScopeId || !this.store) {
      return {
        ...context,
        includeBootstrapContext: bootstrapContext !== "none",
      };
    }

    const targetKeys = await this.workspaceTargetKeys(workspace);
    const contextAlreadyDelivered = targetKeys.some((targetKey) =>
      this.store?.getContextDelivery(conversationScopeId, targetKey)?.contextFingerprint ===
        context.contextFingerprint
    );
    const includeBootstrapContext = resolveBootstrapContextVisibility(
      bootstrapContext,
      contextAlreadyDelivered,
    );
    for (const targetKey of targetKeys) {
      this.store.setConversationBinding({
        conversationScopeId,
        targetKey,
        workspaceSessionId: workspace.id,
      });
      if (includeBootstrapContext) {
        this.store.setContextDelivery({
          conversationScopeId,
          targetKey,
          contextFingerprint: context.contextFingerprint,
        });
      }
    }
    return { ...context, includeBootstrapContext };
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
    bootstrapContext: WorkspaceBootstrapContextMode,
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
        bootstrapContext,
      );
      if (boundContext) return boundContext;
    }

    if (newWorkspace) {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(projectKey, "checkout");
      const freshContext = reusableWorkspace
        ? await this.cloneWorkspaceContext(reusableWorkspace)
        : await this.openCheckoutWorkspace(path);
      return this.withConversationContext(
        freshContext,
        conversationScopeId,
        targetKey,
        bootstrapContext,
      );
    }

    const operationKey = this.conversationOpenKey(targetKey, conversationScopeId);
    const context = await this.openOnce(operationKey, async () => {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(projectKey, "checkout");
      if (!reusableWorkspace) return this.openCheckoutWorkspace(path);
      return conversationScopeId && this.store
        ? this.cloneWorkspaceContext(reusableWorkspace)
        : this.reusedWorkspaceContext(reusableWorkspace);
    });
    return this.withConversationContext(
      context,
      conversationScopeId,
      targetKey,
      bootstrapContext,
    );
  }

  private async openReusableWorktree(
    input: OpenWorkspaceInput,
    conversationScopeId: string | undefined,
  ): Promise<WorkspaceContext> {
    const path = input.path;
    if (!path) throw new Error("Worktree mode requires path.");
    const bootstrapContext = input.context ?? "auto";
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
          bootstrapContext,
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
          bootstrapContext,
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
      return this.withConversationContext(
        context,
        conversationScopeId,
        targetKey,
        bootstrapContext,
      );
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
      return this.withConversationContext(
        context,
        conversationScopeId,
        targetKey,
        bootstrapContext,
      );
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
        bootstrapContext,
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
      return this.withConversationContext(
        freshContext,
        conversationScopeId,
        targetKey,
        bootstrapContext,
      );
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
    return this.withConversationContext(
      context,
      conversationScopeId,
      targetKey,
      bootstrapContext,
    );
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
    bootstrapContext: WorkspaceBootstrapContextMode,
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
    return this.withConversationContext(
      context,
      conversationScopeId,
      targetKey,
      bootstrapContext,
    );
  }

  private withConversationContext(
    context: WorkspaceContext,
    conversationScopeId: string | undefined,
    targetKey: string,
    bootstrapContext: WorkspaceBootstrapContextMode,
  ): WorkspaceContext {
    if (!conversationScopeId || !this.store) {
      return {
        ...context,
        includeBootstrapContext: bootstrapContext !== "none",
      };
    }

    const delivery = this.store.getContextDelivery(conversationScopeId, targetKey);
    const includeBootstrapContext = resolveBootstrapContextVisibility(
      bootstrapContext,
      delivery?.contextFingerprint === context.contextFingerprint,
    );
    this.store.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    if (includeBootstrapContext) {
      this.store.setContextDelivery({
        conversationScopeId,
        targetKey,
        contextFingerprint: context.contextFingerprint,
      });
    }
    return { ...context, includeBootstrapContext };
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
    for (const delivery of this.store.listContextDeliveries()) {
      const deliveredAt = Date.parse(delivery.deliveredAt);
      if (
        Number.isFinite(deliveredAt) &&
        now - deliveredAt >= WORKSPACE_SESSION_IDLE_TTL_MS
      ) {
        this.store.deleteContextDelivery(delivery.conversationScopeId, delivery.targetKey);
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
    Object.assign(workspace, this.loadSkillsForWorkspace(workspace.root));
    workspace.capabilityGuides = loadCapabilityGuides(this.config);
    workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
    workspace.scannedInstructionDirs.clear();
    workspace.knownInstructionPathsByDir.clear();
    workspace.loadedInstructionRealPaths.clear();
    const agentsFiles = await this.loadInitialAgentsFiles(workspace);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace, agentsFiles);
    const contextFingerprint = bootstrapContextFingerprint(
      workspace,
      agentsFiles,
      availableAgentsFiles,
    );

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      contextFingerprint,
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
      capabilityGuides: loadCapabilityGuides(this.config),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
      scannedInstructionDirs: new Set(),
      knownInstructionPathsByDir: new Map(),
      loadedInstructionRealPaths: new Set(),
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
    if (inputPath.startsWith("skills://")) {
      const skillRead = resolveSkillReadPath(
        workspace.skills,
        workspace.activatedSkillDirs,
        inputPath,
      );
      if (!skillRead) {
        throw new Error(
          `Skill resource is not readable before its skill is loaded: ${inputPath}. Read skills://<name> first.`,
        );
      }
      return {
        absolutePath: skillRead.absolutePath,
        readRoots: [workspace.root, skillRead.skill.baseDir],
        skillRead,
      };
    }

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
      capabilityGuides: loadCapabilityGuides(this.config),
      agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
      scannedInstructionDirs: new Set(),
      knownInstructionPathsByDir: new Map(),
      loadedInstructionRealPaths: new Set(),
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
    const agentsFiles = await this.loadInitialAgentsFiles(workspace);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace, agentsFiles);
    const contextFingerprint = bootstrapContextFingerprint(
      workspace,
      agentsFiles,
      availableAgentsFiles,
    );

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      contextFingerprint,
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

  private async loadInitialAgentsFiles(workspace: Workspace): Promise<LoadedAgentsFile[]> {
    const systemInstructionsPath = resolve(this.config.systemInstructionsPath);
    const loadedFiles: LoadedAgentsFile[] = [];
    const systemInstructions = await readSystemInstructions(systemInstructionsPath);
    const systemInstructionsRealPath = await tryRealpath(systemInstructionsPath);

    if (systemInstructions !== undefined) {
      loadedFiles.push({
        path: systemInstructionsPath,
        content: systemInstructions,
      });
      if (systemInstructionsRealPath) {
        workspace.loadedInstructionRealPaths.add(systemInstructionsRealPath);
      }
    }

    await this.discoverInstructionTree(
      workspace,
      workspace.root,
      INITIAL_INSTRUCTION_DISCOVERY_DEPTH,
    );
    loadedFiles.push(...await this.loadKnownInstructionsInDirectory(workspace, workspace.root));
    return loadedFiles;
  }

  private async findAvailableAgentsFiles(
    workspace: Workspace,
    loadedFiles: LoadedAgentsFile[],
  ): Promise<AvailableAgentsFile[]> {
    const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
    const discovered: AvailableAgentsFile[] = [];

    for (const paths of workspace.knownInstructionPathsByDir.values()) {
      for (const path of paths) {
        if (loadedPaths.has(path)) continue;
        const realPath = await tryRealpath(path);
        if (realPath && workspace.loadedInstructionRealPaths.has(realPath)) continue;
        discovered.push({ path });
      }
    }

    return discovered.sort((a, b) => a.path.localeCompare(b.path));
  }

  async discoverPathInstructions(
    workspace: Workspace,
    inputPath: string,
  ): Promise<LoadedAgentsFile[]> {
    const absolutePath = resolve(inputPath);
    if (!isPathInsideRoot(absolutePath, workspace.root)) return [];

    const targetDirectory = dirname(absolutePath);
    const relationship = relative(workspace.root, targetDirectory);
    if (
      relationship === ".." ||
      relationship.startsWith(`..${sep}`) ||
      resolve(targetDirectory) === resolve(this.config.agentDir) ||
      isPathInsideRoot(targetDirectory, resolve(this.config.agentDir))
    ) {
      return [];
    }

    const directories = [resolve(workspace.root)];
    if (relationship) {
      let current = resolve(workspace.root);
      for (const segment of relationship.split(sep).filter(Boolean)) {
        if (SKIPPED_CONTEXT_DIRS.has(segment)) break;
        current = join(current, segment);
        directories.push(current);
      }
    }

    const loaded: LoadedAgentsFile[] = [];
    for (const directory of directories) {
      await this.discoverInstructionTree(workspace, directory, 0);
      loaded.push(...await this.loadKnownInstructionsInDirectory(workspace, directory));
    }
    return loaded;
  }

  private async discoverInstructionTree(
    workspace: Workspace,
    directory: string,
    remainingDepth: number,
  ): Promise<void> {
    const resolvedDirectory = resolve(directory);
    if (workspace.scannedInstructionDirs.has(resolvedDirectory)) return;
    workspace.scannedInstructionDirs.add(resolvedDirectory);

    if (
      resolvedDirectory !== resolve(workspace.root) &&
      isPathInsideRoot(resolvedDirectory, resolve(this.config.agentDir))
    ) {
      return;
    }

    let entries;
    try {
      entries = await opendir(resolvedDirectory);
    } catch {
      return;
    }

    const instructionPaths: string[] = [];
    const childDirectories: string[] = [];
    for await (const entry of entries) {
      const path = join(resolvedDirectory, entry.name);
      if (entry.isFile() && CONTEXT_FILE_NAMES.has(entry.name)) {
        instructionPaths.push(path);
        continue;
      }
      if (
        remainingDepth > 0 &&
        entry.isDirectory() &&
        !SKIPPED_CONTEXT_DIRS.has(entry.name)
      ) {
        childDirectories.push(path);
      }
    }

    workspace.knownInstructionPathsByDir.set(
      resolvedDirectory,
      instructionPaths.sort((left, right) => left.localeCompare(right)),
    );
    if (remainingDepth <= 0) return;

    for (const childDirectory of childDirectories) {
      await this.discoverInstructionTree(workspace, childDirectory, remainingDepth - 1);
    }
  }

  private async loadKnownInstructionsInDirectory(
    workspace: Workspace,
    directory: string,
  ): Promise<LoadedAgentsFile[]> {
    const resolvedDirectory = resolve(directory);
    const paths = workspace.knownInstructionPathsByDir.get(resolvedDirectory) ?? [];
    const loaded: LoadedAgentsFile[] = [];
    const resolvedRoot = (await tryRealpath(workspace.root)) ?? resolve(workspace.root);
    const realDirectory = (await tryRealpath(resolvedDirectory)) ?? resolvedDirectory;

    for (const path of paths) {
      const realPath = await tryRealpath(path);
      if (!realPath) continue;
      if (!isPathInsideRoot(realPath, resolvedRoot)) continue;
      if (dirname(realPath) !== realDirectory) continue;
      if (workspace.loadedInstructionRealPaths.has(realPath)) continue;

      let content: string;
      try {
        content = await readFile(realPath, "utf8");
      } catch (error) {
        if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
        throw error;
      }

      workspace.loadedInstructionRealPaths.add(realPath);
      loaded.push({ path, content });
    }
    return loaded;
  }
}

function resolveBootstrapContextVisibility(
  mode: WorkspaceBootstrapContextMode,
  contextAlreadyDelivered: boolean,
): boolean {
  if (mode === "full") return true;
  if (mode === "none") return false;
  return !contextAlreadyDelivered;
}

function bootstrapContextFingerprint(
  workspace: Workspace,
  agentsFiles: LoadedAgentsFile[],
  availableAgentsFiles: AvailableAgentsFile[],
): string {
  const payload = {
    agentsFiles: agentsFiles
      .map((file) => ({ path: resolve(file.path), content: file.content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    availableAgentsFiles: availableAgentsFiles
      .map((file) => resolve(file.path))
      .sort((left, right) => left.localeCompare(right)),
    skills: workspace.skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: resolve(skill.filePath),
        disableModelInvocation: skill.disableModelInvocation ?? false,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath)
      ),
    skillDiagnostics: workspace.skillDiagnostics,
    capabilityGuides: workspace.capabilityGuides
      .map((guide) => ({
        name: guide.name,
        description: guide.description,
        whenToRead: guide.whenToRead,
        filePath: resolve(guide.filePath),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    agentProfiles: workspace.agentProfiles
      .map((profile) => ({
        name: profile.name,
        description: profile.description,
        provider: profile.provider,
        model: profile.model,
        thinking: profile.thinking,
        filePath: resolve(profile.filePath),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
