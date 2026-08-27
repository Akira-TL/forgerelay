import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";

export interface HostTurnRecord {
  turnId: string;
  conversationScopeId?: string;
  workspaceId?: string;
  createdAt: string;
}

export interface HostTurnStoreOptions {
  now?: () => Date;
  turnId?: () => string;
}

interface HostTurnRow {
  turn_id: string;
  conversation_scope_id: string | null;
  workspace_id: string | null;
  created_at: string;
}

export class HostTurnStore {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;
  private readonly nextTurnId: () => string;

  constructor(stateDir: string, options: HostTurnStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? (() => new Date());
    this.nextTurnId = options.turnId ?? (() => `turn_${randomUUID().replaceAll("-", "")}`);
  }

  begin(conversationScopeId: string | undefined, workspaceId: string): HostTurnRecord {
    const turnId = this.nextTurnId();
    const createdAt = this.now().toISOString();
    this.database.sqlite.prepare(
      `insert into activity_host_turns (turn_id, conversation_scope_id, workspace_id, created_at)
       values (?, ?, ?, ?)`,
    ).run(turnId, conversationScopeId ?? null, workspaceId, createdAt);
    return {
      turnId,
      ...(conversationScopeId ? { conversationScopeId } : {}),
      workspaceId,
      createdAt,
    };
  }

  get(turnId: string): HostTurnRecord | undefined {
    const row = this.database.sqlite.prepare(
      "select * from activity_host_turns where turn_id = ?",
    ).get(turnId) as HostTurnRow | undefined;
    return row ? rowToTurn(row) : undefined;
  }

  current(
    conversationScopeId: string | undefined,
    workspaceId: string | undefined,
  ): HostTurnRecord | undefined {
    if (!conversationScopeId || !workspaceId) return undefined;
    const row = this.database.sqlite.prepare(
      `select * from activity_host_turns
       where conversation_scope_id = ? and workspace_id = ?
       order by rowid desc
       limit 1`,
    ).get(conversationScopeId, workspaceId) as HostTurnRow | undefined;
    return row ? rowToTurn(row) : undefined;
  }

  close(): void {
    this.database.close();
  }
}

function rowToTurn(row: HostTurnRow): HostTurnRecord {
  return {
    turnId: row.turn_id,
    ...(row.conversation_scope_id ? { conversationScopeId: row.conversation_scope_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    createdAt: row.created_at,
  };
}
