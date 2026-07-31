import { and, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceConversationBootstraps,
  workspaceConversationBindings,
  workspaceSessions,
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
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeHash: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  getConversationBinding(
    conversationScopeHash: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeHash: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeHash: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeHash: string, targetKey: string): void;
  claimConversationBootstrap(conversationScopeHash: string, projectKey: string): boolean;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
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
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  getConversationBinding(
    conversationScopeHash: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeHash, conversationScopeHash),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeHash: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeHash: input.conversationScopeHash,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeHash,
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

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeHash: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeHash, conversationScopeHash),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeHash: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeHash, conversationScopeHash),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  claimConversationBootstrap(conversationScopeHash: string, projectKey: string): boolean {
    const now = new Date().toISOString();
    const [inserted] = this.database.db
      .insert(workspaceConversationBootstraps)
      .values({
        conversationScopeHash,
        projectKey,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoNothing()
      .returning()
      .all();

    if (inserted) return true;

    this.database.db
      .update(workspaceConversationBootstraps)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(workspaceConversationBootstraps.conversationScopeHash, conversationScopeHash),
          eq(workspaceConversationBootstraps.projectKey, projectKey),
        ),
      )
      .run();
    return false;
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
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
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeHash: row.conversationScopeHash,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
