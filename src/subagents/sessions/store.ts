import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, type DatabaseHandle } from "../../db/client.js";
import type { ServerConfig } from "../../config.js";
import type { HookExecutionReport } from "../../hooks.js";

export type SubagentSessionStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface SubagentSession {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerSessionId?: string;
  status: SubagentSessionStatus;
  latestResponse?: string;
  error?: string;
  hookReports?: HookExecutionReport[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubagentSessionInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  thinking?: string;
}

export interface SubagentSessionScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

interface SubagentSessionRow {
  id: string;
  workspace_id: string | null;
  workspace_root: string;
  profile_name: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  provider_session_id: string | null;
  status: string;
  latest_response: string | null;
  error: string | null;
  hook_reports_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SubagentSessionStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  list(scope: SubagentSessionScope = {}): SubagentSession[] {
    let rows: SubagentSessionRow[];
    if (scope.workspaceId) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`,
        )
        .all(scope.workspaceId) as SubagentSessionRow[];
    } else if (scope.workspaceRoot) {
      rows = this.database.sqlite
        .prepare(
          `select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`,
        )
        .all(resolve(scope.workspaceRoot)) as SubagentSessionRow[];
    } else {
      rows = this.database.sqlite
        .prepare("select * from local_agent_sessions order by updated_at desc")
        .all() as SubagentSessionRow[];
    }

    return rows.map(rowToSubagentSession);
  }

  create(input: CreateSubagentSessionInput): SubagentSession {
    const now = new Date().toISOString();
    const record: SubagentSession = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      thinking: input.thinking,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.database.sqlite
      .prepare(
        `insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          thinking,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        record.status,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  get(idOrPrefix: string): SubagentSession | undefined {
    const exact = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id = ? or provider_session_id = ?
         limit 1`,
      )
      .get(idOrPrefix, idOrPrefix) as SubagentSessionRow | undefined;
    if (exact) return rowToSubagentSession(exact);

    const matches = this.database.sqlite
      .prepare(
        `select * from local_agent_sessions
         where id like ? escape '\\' or provider_session_id like ? escape '\\'
         order by updated_at desc`,
      )
      .all(`${escapeLike(idOrPrefix)}%`, `${escapeLike(idOrPrefix)}%`) as SubagentSessionRow[];

    return matches.length === 1 ? rowToSubagentSession(matches[0]!) : undefined;
  }

  update(id: string, patch: Partial<Omit<SubagentSession, "id" | "createdAt">>): SubagentSession {
    const current = this.getById(id);
    if (!current) throw new Error(`Unknown subagent id: ${id}`);

    const updated: SubagentSession = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.database.sqlite
      .prepare(
        `update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          thinking = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          hook_reports_json = ?,
          updated_at = ?
         where id = ?`,
      )
      .run(
        updated.workspaceId ?? null,
        resolve(updated.workspaceRoot),
        updated.profileName,
        updated.provider,
        updated.model ?? null,
        updated.thinking ?? null,
        updated.providerSessionId ?? null,
        updated.status,
        updated.latestResponse ?? null,
        updated.error ?? null,
        updated.hookReports ? JSON.stringify(updated.hookReports) : null,
        updated.updatedAt,
        updated.id,
      );

    return updated;
  }

  close(): void {
    this.database.close();
  }

  private getById(id: string): SubagentSession | undefined {
    const row = this.database.sqlite
      .prepare("select * from local_agent_sessions where id = ?")
      .get(id) as SubagentSessionRow | undefined;
    return row ? rowToSubagentSession(row) : undefined;
  }
}

export function createSubagentSessionStore(config: ServerConfig): SubagentSessionStore {
  return new SubagentSessionStore(config.stateDir);
}

function rowToSubagentSession(row: SubagentSessionRow): SubagentSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: readStatus(row.status),
    latestResponse: row.latest_response ?? undefined,
    error: row.error ?? undefined,
    hookReports: parseHookReports(row.hook_reports_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHookReports(value: string | null): HookExecutionReport[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as HookExecutionReport[] : undefined;
  } catch {
    return undefined;
  }
}

function readStatus(status: string): SubagentSessionStatus {
  if (
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "error" ||
    status === "stopped"
  ) {
    return status;
  }
  return "error";
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
