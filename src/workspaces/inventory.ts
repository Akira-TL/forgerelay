import { basename, resolve } from "node:path";
import type { ServerConfig } from "../runtime/config/config.js";
import { assertAllowedPath } from "../mcp/filesystem/roots.js";
import type { WorkspaceSession, WorkspaceStore } from "./state/workspace-store.js";
import type {
  OpenWorkspaceOptions,
  Workspace,
  WorkspaceInspection,
  WorkspaceInventoryEntry,
  WorkspaceInventoryInput,
  WorkspaceInventoryResult,
  WorkspaceInventoryState,
} from "../workspaces.js";
import { canonicalPath } from "./paths.js";
import { WorkspaceSessionService } from "./sessions.js";

const WORKSPACE_STALE_REMINDER_MS = 2 * 24 * 60 * 60 * 1_000;

/** Build bounded read-only projections over persistent Workspace sessions. */
export class WorkspaceInventoryService {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: WorkspaceStore | undefined,
    private readonly workspaces: Map<string, Workspace>,
    private readonly sessions: WorkspaceSessionService,
  ) {}

  async inspectWorkspace(workspaceId: string): Promise<WorkspaceInspection> {
    let session = this.store?.getSession(workspaceId);
    if (!session) {
      const workspace = this.workspaces.get(workspaceId);
      if (workspace) session = workspaceSessionSnapshot(workspace);
    }
    if (!session) throw new Error(`Unknown workspaceId: ${workspaceId}.`);

    const entry = await this.inventoryEntryForSession(session, Date.now(), false);
    const { current: _current, ...inspection } = entry;
    return { kind: "workspace", location: "local", ...inspection };
  }

  async listWorkspaces(
    input: WorkspaceInventoryInput = {},
    openOptions: OpenWorkspaceOptions = {},
  ): Promise<WorkspaceInventoryResult> {
    this.sessions.pruneIdleWorkspaceSessions(openOptions.protectedWorkspaceIds ?? new Set());
    const now = Date.now();
    const sessions = this.store
      ? this.store.listSessions()
      : [...this.workspaces.values()].map(workspaceSessionSnapshot);
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
      summary: { total: entries.length, matching: filtered.length, ...summary },
      page: { offset, limit, hasMore: offset + limit < filtered.length },
    };
  }

  private async inventoryEntryForSession(
    session: WorkspaceSession,
    now: number,
    current: boolean,
  ): Promise<WorkspaceInventoryEntry> {
    const rootValid = await this.sessions.validSessionRoot(session) !== undefined;
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
}

function workspaceSessionSnapshot(workspace: Workspace): WorkspaceSession {
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
