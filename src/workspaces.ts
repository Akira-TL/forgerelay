import { createHash, randomBytes } from "node:crypto";
import { realpathSync, type Stats } from "node:fs";
import type {
  WorkspaceMode,
  WorkspaceSession,
  WorkspaceStore,
} from "./workspaces/state/workspace-store.js";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  loadCapabilityGuides,
  markCapabilityGuideActivated,
  resolveCapabilityGuideReadPath,
  type CapabilityGuide,
  type CapabilityGuideReadResolution,
} from "./mcp/server/core/capabilities.js";
import type { ServerConfig } from "./runtime/config/config.js";
import { WorkspaceContextService, formatAgentsPath } from "./workspaces/context.js";
import {
  BOOTSTRAP_CONTEXT_COMPONENTS,
  bootstrapContextFingerprints,
  resolveBootstrapContextComponents,
} from "./workspaces/bootstrap.js";
import { canonicalPath, ensureCheckoutWorkspaceRoot } from "./workspaces/paths.js";
import { WorkspaceInventoryService } from "./workspaces/inventory.js";
import { WorkspaceSessionService } from "./workspaces/sessions.js";
import { HookRunner, type HookReportContainer } from "./mcp/hooks/hooks.js";
import {
  closeManagedWorktree,
  createManagedWorktree,
  discardFreshManagedWorktree,
  resolveManagedWorktreeBase,
  type ClosedManagedWorktree,
  type ManagedWorktree,
} from "./workspaces/git/git-worktrees.js";
import {
  AccessDeniedError,
  assertAllowedPath,
  isPathInsideRoot,
  resolveAllowedPath,
} from "./mcp/filesystem/roots.js";
import {
  loadWorkspaceSkills,
  markSkillActivated,
  resolveSkillReadPath,
  type LoadedSkills,
  type SkillReadResolution,
} from "./workspaces/resources/skills.js";
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

export interface AdvertisedWorkspaceInstruction {
  path: string;
  content: string;
  status: "loaded" | "available";
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
  recovery?: import("./workspaces/git/worktree-recovery.js").ManagedWorktreeRecoveryProjection;
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
  recovery?: import("./workspaces/git/worktree-recovery.js").ManagedWorktreeRecoveryProjection;
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
  private readonly hooks: HookRunner;
  private readonly context: WorkspaceContextService;
  private readonly sessions: WorkspaceSessionService;
  private readonly inventory: WorkspaceInventoryService;

  constructor(
    private readonly config: ServerConfig,
    private readonly store?: WorkspaceStore,
  ) {
    this.hooks = new HookRunner(config.hooks, config.logging);
    this.context = new WorkspaceContextService(config);
    this.sessions = new WorkspaceSessionService(config, store, this.workspaces, this.context);
    this.inventory = new WorkspaceInventoryService(config, store, this.workspaces, this.sessions);
    this.sessions.foldLegacyWorkspaceSessions();
    this.sessions.pruneIdleWorkspaceSessions(new Set(), true);
  }

  get cachedWorkspaceCount(): number {
    return this.workspaces.size;
  }

  async openWorkspace(
    input: string | OpenWorkspaceInput,
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceContext> {
    this.sessions.pruneIdleWorkspaceSessions(openOptions.protectedWorkspaceIds ?? new Set());
    this.context.pruneWorkspaceResources(this.workspaces.keys());
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

  inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    return this.inventory.inspectWorkspace(workspaceId);
  }

  listWorkspaces(
    input: WorkspaceInventoryInput = {},
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceInventoryResult> {
    return this.inventory.listWorkspaces(input, openOptions);
  }

  async resumeWorkspace(
    workspaceId: string,
    conversationScopeId: string | undefined,
    bootstrapContext: WorkspaceBootstrapContextMode = "auto",
  ): Promise<WorkspaceContext> {
    const session = this.store?.getSession(workspaceId);
    const context = session?.status === "closed" && session.mode === "worktree"
      ? await this.sessions.reopenClosedManagedWorktreeContext(session)
      : await this.sessions.reusedWorkspaceContext(await this.sessions.workspaceForOpen(workspaceId));
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

    const targetKeys = await this.sessions.workspaceTargetKeys(workspace);
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
      const root = await this.sessions.validSessionRoot(session);
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
      this.sessions.deleteConversationBindingsForWorkspace(canonicalWorkspaceId);
      this.store.setSessionStatus(canonicalWorkspaceId, "closed");
    }
    this.context.forgetWorkspaceResources(canonicalWorkspaceId);
    this.workspaces.delete(canonicalWorkspaceId);
  }

  deleteWorkspace(workspaceId: string): void {
    const session = this.getWorkspaceSession(workspaceId);
    if (session.mode === "worktree" && session.status === "active") {
      throw new Error(
        `Workspace ${session.id} is an active managed-worktree Workspace. Finalize it safely before deleting its persistent identity.`,
      );
    }

    this.sessions.deleteConversationBindingsForWorkspace(session.id);
    this.store?.deleteSession(session.id);
    this.context.forgetWorkspaceResources(session.id);
    this.workspaces.delete(session.id);
  }

  workspaceIdsForPhysicalWorkspace(workspace: Workspace): string[] {
    const root = resolve(workspace.root);
    return this.sessions.activeSessions(workspace.mode)
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
    for (const session of this.sessions.activeSessions("worktree")) {
      if (!session.sourceRoot) continue;
      if (await canonicalPath(session.sourceRoot) !== sourceKey) continue;

      const root = await this.sessions.validSessionRoot(session);
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

    const aliasedWorkspaceIds = this.sessions.activeSessions("worktree")
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
      this.sessions.deleteConversationBindingsForWorkspace(aliasedWorkspaceId);
      this.store?.setSessionStatus(aliasedWorkspaceId, "closed");
      this.context.forgetWorkspaceResources(aliasedWorkspaceId);
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

    const boundContext = await this.sessions.boundConversationContext(
      conversationScopeId,
      targetKey,
      "checkout",
      async (session, root) =>
        session.mode === "checkout" && await canonicalPath(root) === projectKey,
      bootstrapContext,
    );
    if (boundContext) return boundContext;

    const context = await this.sessions.openOnce(targetKey, async () => {
      const reusableWorkspace = await this.sessions.findReusableWorkspaceByDirectory(
        projectKey,
        "checkout",
        true,
      );
      if (!reusableWorkspace) return this.openCheckoutWorkspace(path);
      return this.sessions.reusedWorkspaceContext(reusableWorkspace);
    });
    return this.sessions.withConversationContext(
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
    const managedPath = this.sessions.tryManagedWorktreePath(path);
    if (managedPath) {
      const worktreeKey = await canonicalPath(managedPath);
      const targetKey = JSON.stringify(["worktree-path", worktreeKey]);
      const boundContext = await this.sessions.boundConversationContext(
        conversationScopeId,
        targetKey,
        "worktree",
        async (session, root) =>
          session.mode === "worktree" && await canonicalPath(root) === worktreeKey,
        bootstrapContext,
      );
      if (boundContext) return boundContext;

      const context = await this.sessions.openOnce(targetKey, async () => {
        const reusableWorkspace = await this.sessions.findReusableWorkspaceByDirectory(worktreeKey, "worktree");
        if (!reusableWorkspace) {
          throw new Error(
            `Managed worktree is not registered as an active ForgeRelay workspace: ${managedPath}. Open the source project in worktree mode to create or recover a managed worktree first.`,
          );
        }
        return this.sessions.reusedWorkspaceContext(reusableWorkspace);
      });
      return this.sessions.withConversationContext(
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
      return this.sessions.withConversationContext(
        context,
        conversationScopeId,
        targetKey,
        bootstrapContext,
      );
    }

    const boundContext = await this.sessions.boundConversationContext(
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

    const context = await this.sessions.openOnce(targetKey, async () => {
      const reusableContext = await this.sessions.findReusableWorktreeContextBySource(
        sourceKey,
        resolvedBase.targetBranch,
      );
      return reusableContext ?? this.openWorktreeWorkspace(path, input.baseRef);
    });
    return this.sessions.withConversationContext(
      context,
      conversationScopeId,
      targetKey,
      bootstrapContext,
    );
  }

  getWorkspaceSession(workspaceId: string): WorkspaceSession {
    return this.sessions.getWorkspaceSession(workspaceId);
  }

  getWorkspace(workspaceId: string): Workspace {
    return this.sessions.getWorkspace(workspaceId);
  }

  runManagedWorktreeRecovery(workspaceId: string, operation: "status" | "repair" | "cleanup") {
    return this.sessions.runManagedWorktreeRecovery(workspaceId, operation);
  }
  fileToolRoots(workspace: Workspace): string[] {
    return this.context.fileToolRoots(workspace);
  }
  resolvePath(workspace: Workspace, inputPath: string): string {
    return this.context.resolvePath(workspace, inputPath);
  }
  resolveReadPath(workspace: Workspace, inputPath: string): WorkspaceReadPath {
    return this.context.resolveReadPath(workspace, inputPath);
  }
  markReadPathLoaded(workspace: Workspace, readPath: WorkspaceReadPath): void {
    this.context.markReadPathLoaded(workspace, readPath);
  }

  readAdvertisedInstruction(
    workspace: Workspace,
    inputPath: string,
  ): Promise<AdvertisedWorkspaceInstruction> {
    return this.context.readAdvertisedInstruction(workspace, inputPath);
  }

  resolveWorkingDirectory(workspace: Workspace, workingDirectory: string | undefined): string {
    return this.context.resolveWorkingDirectory(workspace, workingDirectory);
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
      ...this.context.loadSkillsForWorkspace(input.root),
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
    const agentsFiles = await this.context.loadInitialAgentsFiles(workspace);
    const availableAgentsFiles = await this.context.findAvailableAgentsFiles(workspace, agentsFiles);
    this.context.trackWorkspaceResources(workspace, agentsFiles, availableAgentsFiles);
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

  discoverPathInstructions(workspace: Workspace, inputPath: string): Promise<LoadedAgentsFile[]> {
    return this.context.discoverPathInstructions(workspace, inputPath);
  }

  claimResourceUpdates(workspaceId: string, conversationScopeId: string | undefined) {
    return this.context.claimResourceUpdates(workspaceId, conversationScopeId);
  }

  acknowledgeResourceUpdates(workspaceId: string, conversationScopeId: string | undefined): void {
    this.context.acknowledgeResourceUpdates(workspaceId, conversationScopeId);
  }

}

export { formatAgentsPath };
export { ensureCheckoutWorkspaceRoot } from "./workspaces/paths.js";
