import { and, desc, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceContextDeliveries,
  workspaceConversationBindings,
  workspaceSessionAliases,
  workspaceSessions,
  type WorkspaceContextDeliveryRow,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  branch?: string;
  targetBranch?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceContextDelivery {
  conversationScopeId: string;
  targetKey: string;
  contextFingerprint: string;
  deliveredAt: string;
}

export interface SqliteWorkspaceStoreOptions {
  now?: () => Date;
  touchFlushIntervalMs?: number;
}

const DEFAULT_TOUCH_FLUSH_INTERVAL_MS = 5 * 60 * 1_000;

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    branch?: string;
    targetBranch?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  setSessionStatus(id: string, status: string): void;
  replaceWorktreeBacking(input: {
    id: string;
    root: string;
    sourceRoot: string;
    baseRef: string;
    baseSha: string;
    branch: string;
    targetBranch: string;
  }): WorkspaceSession;
  listSessions(input?: { status?: string; mode?: WorkspaceMode }): WorkspaceSession[];
  foldSessions(input: {
    canonicalId: string;
    aliasIds: string[];
    createdAt: string;
    lastUsedAt: string;
    status: string;
  }): void;
  deleteSession(id: string): void;
  listConversationBindings(): WorkspaceConversationBinding[];
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  listContextDeliveries(): WorkspaceContextDelivery[];
  getContextDelivery(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceContextDelivery | undefined;
  setContextDelivery(input: {
    conversationScopeId: string;
    targetKey: string;
    contextFingerprint: string;
  }): WorkspaceContextDelivery;
  deleteContextDelivery(conversationScopeId: string, targetKey: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly touchFlushTimer: NodeJS.Timeout;
  private readonly pendingSessionTouches = new Map<string, string>();
  private readonly pendingConversationTouches = new Map<string, {
    conversationScopeId: string;
    targetKey: string;
    lastUsedAt: string;
  }>();

  constructor(stateDir: string, options: SqliteWorkspaceStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? (() => new Date());
    const touchFlushIntervalMs = options.touchFlushIntervalMs ?? DEFAULT_TOUCH_FLUSH_INTERVAL_MS;
    if (!Number.isInteger(touchFlushIntervalMs) || touchFlushIntervalMs < 1) {
      throw new Error("Workspace touch flush interval must be a positive integer.");
    }
    this.touchFlushTimer = setInterval(() => {
      try {
        this.flushTouches();
      } catch (error) {
        console.warn(`ForgeRelay workspace touch flush failed: ${errorMessage(error)}`);
      }
    }, touchFlushIntervalMs);
    this.touchFlushTimer.unref();
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    branch?: string;
    targetBranch?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = this.now().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      branch: input.branch,
      targetBranch: input.targetBranch,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        branch: session.branch ?? null,
        targetBranch: session.targetBranch ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const sessionId = this.resolveSessionId(id);
    if (!sessionId) return undefined;
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, sessionId))
      .get();

    if (!row) return undefined;
    return applySessionTouch(rowToWorkspaceSession(row), this.pendingSessionTouches.get(sessionId));
  }

  touchSession(id: string): void {
    const sessionId = this.resolveSessionId(id);
    if (!sessionId) return;
    this.pendingSessionTouches.set(sessionId, this.now().toISOString());
  }

  setSessionStatus(id: string, status: string): void {
    const sessionId = this.resolveSessionId(id);
    if (!sessionId) return;
    this.pendingSessionTouches.delete(sessionId);
    this.database.db
      .update(workspaceSessions)
      .set({ status, lastUsedAt: this.now().toISOString() })
      .where(eq(workspaceSessions.id, sessionId))
      .run();
  }

  replaceWorktreeBacking(input: {
    id: string;
    root: string;
    sourceRoot: string;
    baseRef: string;
    baseSha: string;
    branch: string;
    targetBranch: string;
  }): WorkspaceSession {
    const sessionId = this.resolveSessionId(input.id);
    if (!sessionId) throw new Error(`Unknown workspace session: ${input.id}`);
    this.pendingSessionTouches.delete(sessionId);
    const row = this.database.db
      .update(workspaceSessions)
      .set({
        root: input.root,
        status: "active",
        sourceRoot: input.sourceRoot,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        branch: input.branch,
        targetBranch: input.targetBranch,
        managed: "true",
        lastUsedAt: this.now().toISOString(),
      })
      .where(eq(workspaceSessions.id, sessionId))
      .returning()
      .get();
    if (!row) throw new Error(`Unknown workspace session: ${input.id}`);
    return rowToWorkspaceSession(row);
  }

  listSessions(input: { status?: string; mode?: WorkspaceMode } = {}): WorkspaceSession[] {
    const conditions = [
      input.status ? eq(workspaceSessions.status, input.status) : undefined,
      input.mode ? eq(workspaceSessions.mode, input.mode) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

    const query = this.database.db
      .select()
      .from(workspaceSessions)
      .orderBy(desc(workspaceSessions.lastUsedAt));
    const rows = conditions.length === 0
      ? query.all()
      : conditions.length === 1
        ? query.where(conditions[0]).all()
        : query.where(and(...conditions)).all();

    return rows
      .map(rowToWorkspaceSession)
      .map((session) => applySessionTouch(session, this.pendingSessionTouches.get(session.id)))
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
  }

  foldSessions(input: {
    canonicalId: string;
    aliasIds: string[];
    createdAt: string;
    lastUsedAt: string;
    status: string;
  }): void {
    const aliases = input.aliasIds.filter((id) => id !== input.canonicalId);
    if (aliases.length === 0) return;
    const fold = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(`
        update workspace_sessions
           set created_at = ?, last_used_at = ?, status = ?
         where id = ?
      `).run(input.createdAt, input.lastUsedAt, input.status, input.canonicalId);
      const rebindConversation = this.database.sqlite.prepare(`
        update workspace_conversation_bindings
           set workspace_session_id = ?
         where workspace_session_id = ?
      `);
      const rebindSubagents = this.database.sqlite.prepare(`
        update local_agent_sessions
           set workspace_id = ?
         where workspace_id = ?
      `);
      const rebindAliases = this.database.sqlite.prepare(`
        update workspace_session_aliases
           set workspace_session_id = ?
         where workspace_session_id = ?
      `);
      const deleteSession = this.database.sqlite.prepare(
        "delete from workspace_sessions where id = ?",
      );
      const rememberAlias = this.database.sqlite.prepare(`
        insert into workspace_session_aliases (alias_id, workspace_session_id)
        values (?, ?)
        on conflict(alias_id) do update set workspace_session_id = excluded.workspace_session_id
      `);

      for (const aliasId of aliases) {
        rebindConversation.run(input.canonicalId, aliasId);
        rebindSubagents.run(input.canonicalId, aliasId);
        rebindAliases.run(input.canonicalId, aliasId);
        deleteSession.run(aliasId);
        rememberAlias.run(aliasId, input.canonicalId);
        this.pendingSessionTouches.delete(aliasId);
      }
    });
    fold.immediate();
  }

  deleteSession(id: string): void {
    const sessionId = this.resolveSessionId(id);
    if (!sessionId) return;
    this.pendingSessionTouches.delete(sessionId);
    this.database.db
      .delete(workspaceSessions)
      .where(eq(workspaceSessions.id, sessionId))
      .run();
  }

  listConversationBindings(): WorkspaceConversationBinding[] {
    return this.database.db
      .select()
      .from(workspaceConversationBindings)
      .all()
      .map(rowToWorkspaceConversationBinding)
      .map((binding) => applyConversationTouch(
        binding,
        this.pendingConversationTouches.get(conversationTouchKey(
          binding.conversationScopeId,
          binding.targetKey,
        ))?.lastUsedAt,
      ));
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    if (!row) return undefined;
    const binding = rowToWorkspaceConversationBinding(row);
    return applyConversationTouch(
      binding,
      this.pendingConversationTouches.get(conversationTouchKey(
        conversationScopeId,
        targetKey,
      ))?.lastUsedAt,
    );
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = this.now().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    this.pendingConversationTouches.delete(conversationTouchKey(
      input.conversationScopeId,
      input.targetKey,
    ));
    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.pendingConversationTouches.set(conversationTouchKey(conversationScopeId, targetKey), {
      conversationScopeId,
      targetKey,
      lastUsedAt: this.now().toISOString(),
    });
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.pendingConversationTouches.delete(conversationTouchKey(conversationScopeId, targetKey));
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  listContextDeliveries(): WorkspaceContextDelivery[] {
    return this.database.db
      .select()
      .from(workspaceContextDeliveries)
      .orderBy(desc(workspaceContextDeliveries.deliveredAt))
      .all()
      .map(rowToWorkspaceContextDelivery);
  }

  getContextDelivery(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceContextDelivery | undefined {
    const row = this.database.db
      .select()
      .from(workspaceContextDeliveries)
      .where(
        and(
          eq(workspaceContextDeliveries.conversationScopeId, conversationScopeId),
          eq(workspaceContextDeliveries.targetKey, targetKey),
        ),
      )
      .get();
    return row ? rowToWorkspaceContextDelivery(row) : undefined;
  }

  setContextDelivery(input: {
    conversationScopeId: string;
    targetKey: string;
    contextFingerprint: string;
  }): WorkspaceContextDelivery {
    const deliveredAt = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceContextDeliveries)
      .values({ ...input, deliveredAt })
      .onConflictDoUpdate({
        target: [
          workspaceContextDeliveries.conversationScopeId,
          workspaceContextDeliveries.targetKey,
        ],
        set: {
          contextFingerprint: input.contextFingerprint,
          deliveredAt,
        },
      })
      .returning()
      .get();
    if (!row) throw new Error("Workspace context delivery upsert returned no row.");
    return rowToWorkspaceContextDelivery(row);
  }

  deleteContextDelivery(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceContextDeliveries)
      .where(
        and(
          eq(workspaceContextDeliveries.conversationScopeId, conversationScopeId),
          eq(workspaceContextDeliveries.targetKey, targetKey),
        ),
      )
      .run();
  }

  private resolveSessionId(id: string): string | undefined {
    const direct = this.database.db
      .select({ id: workspaceSessions.id })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();
    if (direct) return direct.id;

    return this.database.db
      .select({ workspaceSessionId: workspaceSessionAliases.workspaceSessionId })
      .from(workspaceSessionAliases)
      .where(eq(workspaceSessionAliases.aliasId, id))
      .get()
      ?.workspaceSessionId;
  }

  get pendingTouchCount(): number {
    return this.pendingSessionTouches.size + this.pendingConversationTouches.size;
  }

  flushTouches(): void {
    if (this.pendingTouchCount === 0) return;

    const sessionTouches = [...this.pendingSessionTouches.entries()];
    const conversationTouches = [...this.pendingConversationTouches.values()];
    const updateSession = this.database.sqlite.prepare(
      "UPDATE workspace_sessions SET last_used_at = ? WHERE id = ?",
    );
    const updateConversation = this.database.sqlite.prepare(
      "UPDATE workspace_conversation_bindings SET last_used_at = ? WHERE conversation_scope_id = ? AND target_key = ?",
    );
    const flush = this.database.sqlite.transaction(() => {
      for (const [workspaceId, lastUsedAt] of sessionTouches) {
        updateSession.run(lastUsedAt, workspaceId);
      }
      for (const touch of conversationTouches) {
        updateConversation.run(touch.lastUsedAt, touch.conversationScopeId, touch.targetKey);
      }
    });
    flush();

    for (const [workspaceId, lastUsedAt] of sessionTouches) {
      if (this.pendingSessionTouches.get(workspaceId) === lastUsedAt) {
        this.pendingSessionTouches.delete(workspaceId);
      }
    }
    for (const touch of conversationTouches) {
      const key = conversationTouchKey(touch.conversationScopeId, touch.targetKey);
      if (this.pendingConversationTouches.get(key)?.lastUsedAt === touch.lastUsedAt) {
        this.pendingConversationTouches.delete(key);
      }
    }
  }

  close(): void {
    clearInterval(this.touchFlushTimer);
    try {
      this.flushTouches();
    } finally {
      this.database.close();
    }
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function applySessionTouch(session: WorkspaceSession, lastUsedAt: string | undefined): WorkspaceSession {
  return lastUsedAt ? { ...session, lastUsedAt } : session;
}

function applyConversationTouch(
  binding: WorkspaceConversationBinding,
  lastUsedAt: string | undefined,
): WorkspaceConversationBinding {
  return lastUsedAt ? { ...binding, lastUsedAt } : binding;
}

function conversationTouchKey(conversationScopeId: string, targetKey: string): string {
  return JSON.stringify([conversationScopeId, targetKey]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    branch: row.branch ?? undefined,
    targetBranch: row.targetBranch ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceContextDelivery(
  row: WorkspaceContextDeliveryRow,
): WorkspaceContextDelivery {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    contextFingerprint: row.contextFingerprint,
    deliveredAt: row.deliveredAt,
  };
}
