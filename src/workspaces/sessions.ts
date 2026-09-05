import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCapabilityGuides } from "../mcp/server/core/capabilities.js";
import type { ServerConfig } from "../runtime/config/config.js";
import {
  createManagedWorktree,
  discardFreshManagedWorktree,
} from "./git/git-worktrees.js";
import {
  cleanupManagedWorktreeState,
  inspectManagedWorktreeRecovery,
  prepareManagedWorktreeRepair,
  rollbackManagedWorktreeRepair,
} from "./git/worktree-recovery.js";
import { AccessDeniedError, assertAllowedPath } from "../mcp/filesystem/roots.js";
import { loadSubagentProfiles } from "../subagents/profiles.js";
import type { WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./state/workspace-store.js";
import type {
  Workspace,
  WorkspaceBootstrapContextMode,
  WorkspaceContext,
} from "../workspaces.js";
import {
  BOOTSTRAP_CONTEXT_COMPONENTS,
  bootstrapContextFingerprints,
  resolveBootstrapContextComponents,
} from "./bootstrap.js";
import { WorkspaceContextService } from "./context.js";
import { canonicalPath, canonicalPersistedWorkspacePath } from "./paths.js";

const WORKSPACE_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WORKSPACE_GC_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Own persistent Workspace identity and restoration. The Registry coordinates
 * product lifecycle; this service centralizes state folding, conversation
 * bindings, idle-cache GC, and managed-worktree rehydration.
 */
export class WorkspaceSessionService {
  private readonly pendingOpens = new Map<string, Promise<WorkspaceContext>>();
  private lastWorkspaceGcAt = 0;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: WorkspaceStore | undefined,
    private readonly workspaces: Map<string, Workspace>,
    private readonly context: WorkspaceContextService,
  ) {}

  async openOnce(
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
      if (this.pendingOpens.get(operationKey) === operation) this.pendingOpens.delete(operationKey);
    }
  }

  async workspaceTargetKeys(workspace: Workspace): Promise<string[]> {
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

  async boundConversationContext(
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
    return this.withConversationContext(context, conversationScopeId, targetKey, bootstrapContext);
  }

  withConversationContext(
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

  pruneIdleWorkspaceSessions(
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
      if (!sessionsById.has(binding.workspaceSessionId)) {
        this.store.deleteConversationBinding(binding.conversationScopeId, binding.targetKey);
      }
    }
    for (const delivery of this.store.listContextDeliveries()) {
      const deliveredAt = Date.parse(delivery.deliveredAt);
      if (Number.isFinite(deliveredAt) && now - deliveredAt >= WORKSPACE_SESSION_IDLE_TTL_MS) {
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
      if (!current || current.lastUsedAt < session.lastUsedAt) worktreeAnchors.set(key, session);
    }

    for (const session of activeSessions) {
      if (!isIdle(session)) continue;
      if (protectedWorkspaceIds.has(session.id) || boundWorkspaceIds.has(session.id)) continue;
      if (session.mode === "worktree" && worktreeAnchors.get(resolve(session.root))?.id === session.id) continue;
      this.context.forgetWorkspaceResources(session.id);
      this.workspaces.delete(session.id);
    }
  }

  foldLegacyWorkspaceSessions(): void {
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
      const status = ordered.some((session) => session.status === "active") ? "active" : canonical.status;
      this.store.foldSessions({
        canonicalId: canonical.id,
        aliasIds: ordered.slice(1).map((session) => session.id),
        createdAt,
        lastUsedAt,
        status,
      });
    }
  }

  async findReusableWorkspaceByDirectory(
    directoryKey: string,
    mode: WorkspaceMode,
    reopenClosedCheckout = false,
  ): Promise<Workspace | undefined> {
    const sessions = this.store ? this.store.listSessions({ mode }) : this.activeSessions(mode);
    for (const session of sessions) {
      const reusable = session.status === "active" ||
        (reopenClosedCheckout && mode === "checkout" && session.status === "closed");
      if (!reusable) continue;
      const root = await this.validSessionRoot(session);
      if (!root || await canonicalPath(root) !== directoryKey) continue;
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

  async findReusableWorktreeContextBySource(
    sourceKey: string,
    targetBranch: string,
  ): Promise<WorkspaceContext | undefined> {
    const sessions = this.store ? this.store.listSessions({ mode: "worktree" }) : this.activeSessions("worktree");
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
    if (closedMatches.length === 1) return this.reopenClosedManagedWorktreeContext(closedMatches[0]!);
    return undefined;
  }

  activeSessions(mode: WorkspaceMode): WorkspaceSession[] {
    if (this.store) return this.store.listSessions({ status: "active", mode });
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

  async validSessionRoot(session: WorkspaceSession): Promise<string | undefined> {
    try {
      const root = this.context.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
      const rootStats = await stat(root);
      return rootStats.isDirectory() ? root : undefined;
    } catch (error) {
      if (
        error instanceof AccessDeniedError ||
        (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      ) return undefined;
      throw error;
    }
  }

  tryManagedWorktreePath(path: string): string | undefined {
    try {
      return assertAllowedPath(path, [this.config.worktreeRoot]);
    } catch (error) {
      if (error instanceof AccessDeniedError) return undefined;
      throw error;
    }
  }

  async reusedWorkspaceContext(workspace: Workspace): Promise<WorkspaceContext> {
    Object.assign(workspace, this.context.loadSkillsForWorkspace(workspace.root));
    workspace.capabilityGuides = loadCapabilityGuides(this.config);
    workspace.agentProfiles = await loadSubagentProfiles(this.config, workspace.root);
    workspace.scannedInstructionDirs.clear();
    workspace.knownInstructionPathsByDir.clear();
    workspace.loadedInstructionRealPaths.clear();
    workspace.loadedInstructionPaths.clear();
    workspace.workspaceInstructions.length = 0;
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
      hookReports: [],
      workspaceReused: true,
      includeBootstrapContext: true,
    };
  }

  async workspaceForOpen(workspaceId: string): Promise<Workspace> {
    const session = this.store?.getSession(workspaceId);
    if (session?.status === "closed" && session.mode === "checkout") {
      this.store?.setSessionStatus(session.id, "active");
      const reopened = this.store?.getSession(session.id);
      if (!reopened) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
      return this.workspaceFromSession(reopened, true);
    }
    return this.getWorkspace(workspaceId);
  }

  async reopenClosedManagedWorktreeContext(session: WorkspaceSession): Promise<WorkspaceContext> {
    const operationKey = JSON.stringify(["worktree-reopen", session.id]);
    return this.openOnce(operationKey, async () => {
      const current = this.store?.getSession(session.id);
      if (!current) throw new Error(`Unknown workspaceId: ${session.id}. Call open_workspace first.`);
      if (current.status === "active") return this.reusedWorkspaceContext(this.getWorkspace(current.id));
      if (current.status !== "closed" || current.mode !== "worktree") {
        throw new Error(`Workspace ${current.id} is not a closed managed-worktree Workspace.`);
      }
      return this.reopenClosedManagedWorktreeContextUnlocked(current);
    });
  }

  private async reopenClosedManagedWorktreeContextUnlocked(session: WorkspaceSession): Promise<WorkspaceContext> {
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
      this.context.forgetWorkspaceResources(session.id);
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

  async runManagedWorktreeRecovery(
    workspaceId: string,
    operation: "status" | "repair" | "cleanup",
  ) {
    const store = this.store;
    if (!store) {
      throw new Error(`Workspace ${workspaceId} cannot use managed-worktree recovery without persistent Workspace state.`);
    }
    const session = store.getSession(workspaceId);
    if (!session) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    if (operation === "cleanup") {
      let managedBranchOwnedByOtherWorkspace = false;
      if (session.sourceRoot && session.branch) {
        const sourceKey = canonicalPersistedWorkspacePath(session.sourceRoot);
        for (const candidate of store.listSessions({ mode: "worktree" })) {
          if (
            candidate.id === session.id ||
            !candidate.managed ||
            candidate.branch !== session.branch ||
            !candidate.sourceRoot
          ) continue;
          if (canonicalPersistedWorkspacePath(candidate.sourceRoot) === sourceKey) {
            managedBranchOwnedByOtherWorkspace = true;
            break;
          }
        }
      }
      return {
        workspaceId: session.id,
        ...await cleanupManagedWorktreeState(session, this.config, { managedBranchOwnedByOtherWorkspace }),
      };
    }

    const recovery = await inspectManagedWorktreeRecovery(session, this.config);
    if (!recovery) {
      throw new Error(`Workspace ${session.id} is not an active managed-worktree Workspace.`);
    }
    if (operation === "status") {
      return {
        workspaceId: session.id,
        repaired: false,
        recovery,
      };
    }

    const prepared = await prepareManagedWorktreeRepair(session, this.config);
    if (!prepared.prepared) {
      return {
        workspaceId: session.id,
        repaired: false,
        recovery: prepared.recovery,
        reason: prepared.reason,
      };
    }

    const cachedWorkspace = this.workspaces.get(session.id);
    try {
      this.context.forgetWorkspaceResources(session.id);
      this.workspaces.delete(session.id);
      const candidateSession: WorkspaceSession = {
        ...session,
        root: prepared.root,
      };
      const candidateWorkspace = this.workspaceFromSession(candidateSession, false);
      await this.reusedWorkspaceContext(candidateWorkspace);
      store.replaceWorktreeBacking({
        id: session.id,
        root: prepared.root,
        sourceRoot: prepared.sourceRoot,
        baseRef: prepared.baseRef,
        baseSha: prepared.baseSha,
        branch: prepared.branch,
        targetBranch: prepared.targetBranch,
      });
      return {
        workspaceId: session.id,
        repaired: true,
        previousRoot: prepared.previousRoot,
        root: prepared.root,
        branch: prepared.branch,
        targetBranch: prepared.targetBranch,
        recovery: prepared.recovery,
      };
    } catch (error) {
      this.context.forgetWorkspaceResources(session.id);
      this.workspaces.delete(session.id);
      if (cachedWorkspace) this.workspaces.set(session.id, cachedWorkspace);
      try {
        await rollbackManagedWorktreeRepair(prepared, this.config);
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Recovery rollback also failed; the temporary backing was preserved for inspection: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  getWorkspaceSession(workspaceId: string): WorkspaceSession {
    const session = this.store?.getSession(workspaceId);
    if (session) return session;
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
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

  deleteConversationBindingsForWorkspace(workspaceId: string): void {
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

  workspaceFromSession(session: WorkspaceSession, touch: boolean): Workspace {
    const existing = this.workspaces.get(session.id);
    if (existing) {
      if (touch) this.store?.touchSession(session.id);
      return existing;
    }

    const root = this.context.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
    const restoredWorkspace: Workspace = {
      id: session.id,
      root,
      mode: session.mode,
      sourceRoot: session.sourceRoot,
      worktree: session.mode === "worktree"
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
      ...this.context.loadSkillsForWorkspace(root),
      capabilityGuides: loadCapabilityGuides(this.config),
      agentProfiles: [],
      activatedSkillDirs: new Set(),
      activatedCapabilityGuideDirs: new Set(),
      scannedInstructionDirs: new Set(),
      knownInstructionPathsByDir: new Map(),
      loadedInstructionRealPaths: new Set(),
      loadedInstructionPaths: new Set(),
      workspaceInstructions: [],
    };
    if (touch) this.store?.touchSession(session.id);
    this.workspaces.set(restoredWorkspace.id, restoredWorkspace);
    return restoredWorkspace;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
