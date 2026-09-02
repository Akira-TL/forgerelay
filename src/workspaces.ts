import { createHash, randomBytes } from "node:crypto";
import { realpathSync, type Stats } from "node:fs";
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
  discardFreshManagedWorktree,
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
  loadSubagentProfiles,
  type SubagentProfile,
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
  agentProfiles: SubagentProfile[];
  activatedSkillDirs: Set<string>;
  activatedCapabilityGuideDirs: Set<string>;
  scannedInstructionDirs: Set<string>;
  knownInstructionPathsByDir: Map<string, string[]>;
  loadedInstructionRealPaths: Set<string>;
  loadedInstructionPaths: Set<string>;
}

export type WorkspaceBootstrapContextMode = "auto" | "full" | "none";

export type WorkspaceBootstrapComponent =
  | "agentsFiles"
  | "availableAgentsFiles"
  | "skills"
  | "skillDiagnostics"
  | "capabilityGuides"
  | "agentProfiles";

export interface WorkspaceContext extends HookReportContainer {
  workspace: Workspace;
  agentsFiles: LoadedAgentsFile[];
  availableAgentsFiles: AvailableAgentsFile[];
  contextFingerprint: string;
  bootstrapComponentFingerprints: Record<WorkspaceBootstrapComponent, string>;
  bootstrapContextComponents: WorkspaceBootstrapComponent[];
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

export interface WorkspaceInspection {
  workspaceId: string;
  kind: "workspace";
  location: "local";
  label: string;
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
    this.foldLegacyWorkspaceSessions();
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
      bootstrapContext,
    );
  }

  async inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    let session = this.store?.getSession(workspaceId);
    if (!session) {
      const workspace = this.workspaces.get(workspaceId);
      if (workspace) {
        session = {
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
        };
      }
    }
    if (!session) throw new Error(`Unknown workspaceId: ${workspaceId}.`);

    const entry = await this.inventoryEntryForSession(session, Date.now(), false);
    const { current: _current, ...inspection } = entry;
    return {
      kind: "workspace",
      location: "local",
      ...inspection,
    };
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
    const workspaceIdFilter = input.workspaceId
      ? this.store?.getSession(input.workspaceId)?.id ?? input.workspaceId
      : undefined;
    const rootKey = input.root
      ? await canonicalPath(assertAllowedPath(
          input.root,
          [...this.config.allowedRoots, this.config.worktreeRoot],
        ))
      : undefined;
    const entries = await Promise.all(sessions.map((session) =>
      this.inventoryEntryForSession(session, now, currentWorkspaceIds.has(session.id))
    ));
    const filtered: WorkspaceInventoryEntry[] = [];
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const entry = entries[index];
      if (!session || !entry) continue;
      if (workspaceIdFilter && entry.workspaceId !== workspaceIdFilter) continue;
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

  private async inventoryEntryForSession(
    session: WorkspaceSession,
    now: number,
    current: boolean,
  ): Promise<WorkspaceInventoryEntry> {
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
      current,
    };
  }

  async resumeWorkspace(
    workspaceId: string,
    conversationScopeId: string | undefined,
    bootstrapContext: WorkspaceBootstrapContextMode = "auto",
  ): Promise<WorkspaceContext> {
    const session = this.store?.getSession(workspaceId);
    const context = session?.status === "closed" && session.mode === "worktree"
      ? await this.reopenClosedManagedWorktreeContext(session)
      : await this.reusedWorkspaceContext(await this.workspaceForOpen(workspaceId));
    const workspace = context.workspace;
    if (!conversationScopeId || !this.store) {
      const bootstrapContextComponents = resolveBootstrapContextComponents(
        bootstrapContext,
        context.bootstrapComponentFingerprints,
        [],
      );
      return {
        ...context,
        bootstrapContextComponents,
        includeBootstrapContext: bootstrapContextComponents.length > 0,
      };
    }

    const targetKeys = await this.workspaceTargetKeys(workspace);
    const deliveries = targetKeys
      .map((targetKey) => this.store?.getContextDelivery(conversationScopeId, targetKey))
      .filter((delivery): delivery is NonNullable<typeof delivery> => delivery !== undefined);
    const bootstrapContextComponents = resolveBootstrapContextComponents(
      bootstrapContext,
      context.bootstrapComponentFingerprints,
      deliveries,
      context.contextFingerprint,
    );
    const includeBootstrapContext = bootstrapContextComponents.length > 0;
    for (const targetKey of targetKeys) {
      this.store.setConversationBinding({
        conversationScopeId,
        targetKey,
        workspaceSessionId: workspace.id,
      });
      if (bootstrapContext !== "none" && (includeBootstrapContext || deliveries.some((delivery) =>
        delivery.contextFingerprint === context.contextFingerprint && !delivery.componentFingerprints
      ))) {
        this.store.setContextDelivery({
          conversationScopeId,
          targetKey,
          contextFingerprint: context.contextFingerprint,
          componentFingerprints: context.bootstrapComponentFingerprints,
        });
      }
    }
    return { ...context, bootstrapContextComponents, includeBootstrapContext };
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
    const canonicalWorkspaceId = workspace.id;
    if (workspace.mode === "worktree") {
      throw new Error(
        `Workspace ${canonicalWorkspaceId} is backed by a managed worktree. Use close_workspace with its managed-worktree finalize lifecycle.`,
      );
    }

    if (this.store) {
      this.deleteConversationBindingsForWorkspace(canonicalWorkspaceId);
      this.store.setSessionStatus(canonicalWorkspaceId, "closed");
    }
    this.workspaces.delete(canonicalWorkspaceId);
  }

  deleteWorkspace(workspaceId: string): void {
    const session = this.getWorkspaceSession(workspaceId);
    if (session.mode === "worktree" && session.status === "active") {
      throw new Error(
        `Workspace ${session.id} is an active managed-worktree Workspace. Finalize it safely before deleting its persistent identity.`,
      );
    }

    this.deleteConversationBindingsForWorkspace(session.id);
    this.store?.deleteSession(session.id);
    this.workspaces.delete(session.id);
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
      this.deleteConversationBindingsForWorkspace(aliasedWorkspaceId);
      this.store?.setSessionStatus(aliasedWorkspaceId, "closed");
      this.workspaces.delete(aliasedWorkspaceId);
    }
    return { ...result, hookReports };
  }

  private async openReusableCheckout(
    path: string,
    conversationScopeId: string | undefined,
    bootstrapContext: WorkspaceBootstrapContextMode,
  ): Promise<WorkspaceContext> {
    const allowedPath = assertAllowedPath(path, this.config.allowedRoots);
    const projectKey = await canonicalPath(allowedPath);
    const targetKey = JSON.stringify(["checkout", projectKey, null]);

    const boundContext = await this.boundConversationContext(
      conversationScopeId,
      targetKey,
      "checkout",
      async (session, root) =>
        session.mode === "checkout" && await canonicalPath(root) === projectKey,
      bootstrapContext,
    );
    if (boundContext) return boundContext;

    const context = await this.openOnce(targetKey, async () => {
      const reusableWorkspace = await this.findReusableWorkspaceByDirectory(
        projectKey,
        "checkout",
        true,
      );
      if (!reusableWorkspace) return this.openCheckoutWorkspace(path);
      return this.reusedWorkspaceContext(reusableWorkspace);
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
      const boundContext = await this.boundConversationContext(
        conversationScopeId,
        targetKey,
        "worktree",
        async (session, root) =>
          session.mode === "worktree" && await canonicalPath(root) === worktreeKey,
        bootstrapContext,
      );
      if (boundContext) return boundContext;

      const context = await this.openOnce(targetKey, async () => {
        const reusableWorkspace = await this.findReusableWorkspaceByDirectory(worktreeKey, "worktree");
        if (!reusableWorkspace) {
          throw new Error(
            `Managed worktree is not registered as an active ForgeRelay workspace: ${managedPath}. Open the source project in worktree mode to create or recover a managed worktree first.`,
          );
        }
        return this.reusedWorkspaceContext(reusableWorkspace);
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

    const context = await this.openOnce(targetKey, async () => {
      const reusableContext = await this.findReusableWorktreeContextBySource(
        sourceKey,
        resolvedBase.targetBranch,
      );
      return reusableContext ?? this.openWorktreeWorkspace(path, input.baseRef);
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
      const bootstrapContextComponents = resolveBootstrapContextComponents(
        bootstrapContext,
        context.bootstrapComponentFingerprints,
        [],
      );
      return {
        ...context,
        bootstrapContextComponents,
        includeBootstrapContext: bootstrapContextComponents.length > 0,
      };
    }

    const delivery = this.store.getContextDelivery(conversationScopeId, targetKey);
    const bootstrapContextComponents = resolveBootstrapContextComponents(
      bootstrapContext,
      context.bootstrapComponentFingerprints,
      delivery ? [delivery] : [],
      context.contextFingerprint,
    );
    const includeBootstrapContext = bootstrapContextComponents.length > 0;
    this.store.setConversationBinding({
      conversationScopeId,
      targetKey,
      workspaceSessionId: context.workspace.id,
    });
    if (
      bootstrapContext !== "none" &&
      (includeBootstrapContext ||
        (delivery?.contextFingerprint === context.contextFingerprint && !delivery.componentFingerprints))
    ) {
      this.store.setContextDelivery({
        conversationScopeId,
        targetKey,
        contextFingerprint: context.contextFingerprint,
        componentFingerprints: context.bootstrapComponentFingerprints,
      });
    }
    return { ...context, bootstrapContextComponents, includeBootstrapContext };
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
      this.workspaces.delete(session.id);
    }
  }

  private foldLegacyWorkspaceSessions(): void {
    if (!this.store) return;
    const groups = new Map<string, WorkspaceSession[]>();
    for (const session of this.store.listSessions()) {
      const targetPath = canonicalPersistedWorkspacePath(session.root);
      const key = JSON.stringify([session.mode, targetPath]);
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }

    for (const sessions of groups.values()) {
      if (sessions.length < 2) continue;
      const ordered = [...sessions].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      );
      const canonical = ordered[0];
      if (!canonical) continue;
      const createdAt = ordered.reduce(
        (earliest, session) => session.createdAt < earliest ? session.createdAt : earliest,
        canonical.createdAt,
      );
      const lastUsedAt = ordered.reduce(
        (latest, session) => session.lastUsedAt > latest ? session.lastUsedAt : latest,
        canonical.lastUsedAt,
      );
      const status = ordered.some((session) => session.status === "active")
        ? "active"
        : canonical.status;
      this.store.foldSessions({
        canonicalId: canonical.id,
        aliasIds: ordered.slice(1).map((session) => session.id),
        createdAt,
        lastUsedAt,
        status,
      });
    }
  }

  private async findReusableWorkspaceByDirectory(
    directoryKey: string,
    mode: WorkspaceMode,
    reopenClosedCheckout = false,
  ): Promise<Workspace | undefined> {
    const sessions = this.store
      ? this.store.listSessions({ mode })
      : this.activeSessions(mode);
    for (const session of sessions) {
      const reusable = session.status === "active" ||
        (reopenClosedCheckout && mode === "checkout" && session.status === "closed");
      if (!reusable) continue;
      const root = await this.validSessionRoot(session);
      if (!root) continue;
      if (await canonicalPath(root) !== directoryKey) continue;
      if (session.status === "closed") {
        this.store?.setSessionStatus(session.id, "active");
        const reopened = this.store?.getSession(session.id);
        if (!reopened) continue;
        return this.workspaceFromSession(reopened, false);
      }
      return this.workspaceFromSession(session, false);
    }
    return undefined;
  }

  private async findReusableWorktreeContextBySource(
    sourceKey: string,
    targetBranch: string,
  ): Promise<WorkspaceContext | undefined> {
    const sessions = this.store
      ? this.store.listSessions({ mode: "worktree" })
      : this.activeSessions("worktree");
    const closedMatches: WorkspaceSession[] = [];
    for (const session of sessions) {
      if (!session.sourceRoot || session.targetBranch !== targetBranch) continue;
      if (await canonicalPath(session.sourceRoot) !== sourceKey) continue;
      if (session.status === "closed") {
        if (session.managed) closedMatches.push(session);
        continue;
      }
      if (session.status !== "active") continue;
      const root = await this.validSessionRoot(session);
      if (!root) continue;
      return this.reusedWorkspaceContext(this.workspaceFromSession(session, false));
    }
    if (closedMatches.length === 1) {
      return this.reopenClosedManagedWorktreeContext(closedMatches[0]!);
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
    Object.assign(workspace, this.loadSkillsForWorkspace(workspace.root));
    workspace.capabilityGuides = loadCapabilityGuides(this.config);
    workspace.agentProfiles = await loadSubagentProfiles(this.config, workspace.root);
    workspace.scannedInstructionDirs.clear();
    workspace.knownInstructionPathsByDir.clear();
    workspace.loadedInstructionRealPaths.clear();
    workspace.loadedInstructionPaths.clear();
    const agentsFiles = await this.loadInitialAgentsFiles(workspace);
    const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace, agentsFiles);
    const {
      contextFingerprint,
      componentFingerprints: bootstrapComponentFingerprints,
    } = bootstrapContextFingerprints(workspace, agentsFiles, availableAgentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      contextFingerprint,
      bootstrapComponentFingerprints,
      bootstrapContextComponents: [...BOOTSTRAP_CONTEXT_COMPONENTS],
      hookReports: [],
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  private async workspaceForOpen(workspaceId: string): Promise<Workspace> {
    const session = this.store?.getSession(workspaceId);
    if (session?.status === "closed" && session.mode === "checkout") {
      this.store?.setSessionStatus(session.id, "active");
      const reopened = this.store?.getSession(session.id);
      if (!reopened) {
        throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
      }
      return this.workspaceFromSession(reopened, true);
    }
    return this.getWorkspace(workspaceId);
  }

  private async reopenClosedManagedWorktreeContext(
    session: WorkspaceSession,
  ): Promise<WorkspaceContext> {
    const operationKey = JSON.stringify(["worktree-reopen", session.id]);
    return this.openOnce(operationKey, async () => {
      const current = this.store?.getSession(session.id);
      if (!current) {
        throw new Error(`Unknown workspaceId: ${session.id}. Call open_workspace first.`);
      }
      if (current.status === "active") {
        return this.reusedWorkspaceContext(this.getWorkspace(current.id));
      }
      if (current.status !== "closed" || current.mode !== "worktree") {
        throw new Error(`Workspace ${current.id} is not a closed managed-worktree Workspace.`);
      }
      return this.reopenClosedManagedWorktreeContextUnlocked(current);
    });
  }

  private async reopenClosedManagedWorktreeContextUnlocked(
    session: WorkspaceSession,
  ): Promise<WorkspaceContext> {
    if (!this.store) {
      throw new Error(`Workspace ${session.id} cannot be reopened without persistent Workspace state.`);
    }
    if (!session.managed || !session.sourceRoot || !session.targetBranch) {
      throw new Error(
        `Workspace ${session.id} does not have enough managed-worktree metadata to recreate its execution backing.`,
      );
    }

    const worktree = await createManagedWorktree({
      sourcePath: session.sourceRoot,
      baseRef: session.targetBranch,
      config: this.config,
    });
    const candidateSession: WorkspaceSession = {
      ...session,
      root: worktree.path,
      status: "active",
      sourceRoot: worktree.sourceRoot,
      baseRef: worktree.baseRef,
      baseSha: worktree.baseSha,
      branch: worktree.branch,
      targetBranch: worktree.targetBranch,
      managed: true,
    };
    const workspace = this.workspaceFromSession(candidateSession, false);

    try {
      const context = await this.reusedWorkspaceContext(workspace);
      this.store.replaceWorktreeBacking({
        id: session.id,
        root: worktree.path,
        sourceRoot: worktree.sourceRoot,
        baseRef: worktree.baseRef,
        baseSha: worktree.baseSha,
        branch: worktree.branch,
        targetBranch: worktree.targetBranch,
      });
      return context;
    } catch (error) {
      this.workspaces.delete(session.id);
      try {
        await discardFreshManagedWorktree({ worktree, config: this.config });
      } catch (cleanupError) {
        const original = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${original} Reopen rollback also failed: ${cleanup}`);
      }
      throw error;
    }
  }

  getWorkspaceSession(workspaceId: string): WorkspaceSession {
    const session = this.store?.getSession(workspaceId);
    if (session) return session;

    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    }
    return {
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
    };
  }

  private deleteConversationBindingsForWorkspace(workspaceId: string): void {
    if (!this.store) return;
    for (const binding of this.store.listConversationBindings()) {
      if (binding.workspaceSessionId === workspaceId) {
        this.store.deleteConversationBinding(binding.conversationScopeId, binding.targetKey);
      }
    }
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
      loadedInstructionPaths: new Set(),
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
      agentProfiles: await loadSubagentProfiles(this.config, input.root),
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
      scannedInstructionDirs: new Set(),
      knownInstructionPathsByDir: new Map(),
      loadedInstructionRealPaths: new Set(),
      loadedInstructionPaths: new Set(),
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
    const {
      contextFingerprint,
      componentFingerprints: bootstrapComponentFingerprints,
    } = bootstrapContextFingerprints(workspace, agentsFiles, availableAgentsFiles);

    return {
      workspace,
      agentsFiles,
      availableAgentsFiles,
      contextFingerprint,
      bootstrapComponentFingerprints,
      bootstrapContextComponents: [...BOOTSTRAP_CONTEXT_COMPONENTS],
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
      workspace.loadedInstructionPaths.add(systemInstructionsPath);
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
      workspace.loadedInstructionPaths.add(path);
      loaded.push({ path, content });
    }
    return loaded;
  }
}

const BOOTSTRAP_CONTEXT_COMPONENTS: readonly WorkspaceBootstrapComponent[] = [
  "agentsFiles",
  "availableAgentsFiles",
  "skills",
  "skillDiagnostics",
  "capabilityGuides",
  "agentProfiles",
];

function resolveBootstrapContextComponents(
  mode: WorkspaceBootstrapContextMode,
  currentFingerprints: Record<WorkspaceBootstrapComponent, string>,
  deliveries: Array<{ contextFingerprint: string; componentFingerprints?: Record<string, string> }>,
  contextFingerprint?: string,
): WorkspaceBootstrapComponent[] {
  if (mode === "none") return [];
  if (mode === "full") return [...BOOTSTRAP_CONTEXT_COMPONENTS];
  if (deliveries.length === 0) return [...BOOTSTRAP_CONTEXT_COMPONENTS];

  if (
    contextFingerprint &&
    deliveries.some((delivery) =>
      !delivery.componentFingerprints && delivery.contextFingerprint === contextFingerprint
    )
  ) {
    return [];
  }

  return BOOTSTRAP_CONTEXT_COMPONENTS.filter((component) =>
    !deliveries.some((delivery) =>
      delivery.componentFingerprints?.[component] === currentFingerprints[component]
    )
  );
}

function bootstrapContextFingerprints(
  workspace: Workspace,
  agentsFiles: LoadedAgentsFile[],
  availableAgentsFiles: AvailableAgentsFile[],
): {
  contextFingerprint: string;
  componentFingerprints: Record<WorkspaceBootstrapComponent, string>;
} {
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
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  return {
    contextFingerprint: hash(payload),
    componentFingerprints: {
      agentsFiles: hash(payload.agentsFiles),
      availableAgentsFiles: hash(payload.availableAgentsFiles),
      skills: hash(payload.skills),
      skillDiagnostics: hash(payload.skillDiagnostics),
      capabilityGuides: hash(payload.capabilityGuides),
      agentProfiles: hash(payload.agentProfiles),
    },
  };
}

function canonicalPersistedWorkspacePath(path: string): string {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(realpathSync(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        return resolve(path);
      }

      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
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
