import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ServerConfig } from "../../config.js";
import { openDatabase, type DatabaseHandle } from "../../db/client.js";
import type { SubagentRunOutcome } from "./delivery-mailbox.js";

export type SubagentSessionStatus = "idle" | "running";

export interface SubagentRunSummary {
  id: string;
  status: "running" | SubagentRunOutcome;
  activityId?: string;
  startedAt?: string;
  finishedAt?: string;
}

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
  activeRun?: SubagentRunSummary;
  latestRun?: SubagentRunSummary;
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
  activeRun?: {
    id: string;
    activityId?: string;
    startedAt: string;
  };
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
  active_run_id: string | null;
  active_activity_id: string | null;
  active_run_started_at: string | null;
  latest_run_id: string | null;
  latest_run_outcome: string | null;
  latest_run_finished_at: string | null;
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
      status: input.activeRun ? "running" : "idle",
      ...(input.activeRun
        ? {
            activeRun: {
              id: input.activeRun.id,
              status: "running" as const,
              ...(input.activeRun.activityId ? { activityId: input.activeRun.activityId } : {}),
              startedAt: input.activeRun.startedAt,
            },
          }
        : {}),
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
          provider_session_id,
          status,
          active_run_id,
          active_activity_id,
          active_run_started_at,
          latest_run_id,
          latest_run_outcome,
          latest_run_finished_at,
          latest_response,
          error,
          hook_reports_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId ?? null,
        record.workspaceRoot,
        record.profileName,
        record.provider,
        record.model ?? null,
        record.thinking ?? null,
        null,
        record.status,
        record.activeRun?.id ?? null,
        record.activeRun?.activityId ?? null,
        record.activeRun?.startedAt ?? null,
        null,
        null,
        null,
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

  getInScope(idOrPrefix: string, scope: SubagentSessionScope): SubagentSession | undefined {
    const session = this.get(idOrPrefix);
    if (!session) return undefined;
    if (scope.workspaceId && session.workspaceId !== scope.workspaceId) return undefined;
    if (scope.workspaceRoot && session.workspaceRoot !== resolve(scope.workspaceRoot)) return undefined;
    return session;
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
          active_run_id = ?,
          active_activity_id = ?,
          active_run_started_at = ?,
          latest_run_id = ?,
          latest_run_outcome = ?,
          latest_run_finished_at = ?,
          latest_response = null,
          error = null,
          hook_reports_json = null,
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
        updated.activeRun?.id ?? null,
        updated.activeRun?.activityId ?? null,
        updated.activeRun?.startedAt ?? null,
        updated.latestRun?.id ?? null,
        updated.latestRun && updated.latestRun.status !== "running" ? updated.latestRun.status : null,
        updated.latestRun?.finishedAt ?? null,
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
  const activeRun = row.active_run_id
    ? {
        id: row.active_run_id,
        status: "running" as const,
        ...(row.active_activity_id ? { activityId: row.active_activity_id } : {}),
        ...(row.active_run_started_at ? { startedAt: row.active_run_started_at } : {}),
      }
    : undefined;
  const latestOutcome = readOutcome(row.latest_run_outcome);
  const latestRun = row.latest_run_id && latestOutcome
    ? {
        id: row.latest_run_id,
        status: latestOutcome,
        ...(row.latest_run_finished_at ? { finishedAt: row.latest_run_finished_at } : {}),
      }
    : undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    workspaceRoot: row.workspace_root,
    profileName: row.profile_name,
    provider: row.provider,
    model: row.model ?? undefined,
    thinking: row.thinking ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    status: activeRun || row.status === "starting" || row.status === "running" ? "running" : "idle",
    ...(activeRun ? { activeRun } : {}),
    ...(latestRun ? { latestRun } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readOutcome(value: string | null): SubagentRunOutcome | undefined {
  if (value === "succeeded" || value === "failed" || value === "cancelled" || value === "interrupted") {
    return value;
  }
  return undefined;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
