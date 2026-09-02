import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { WorkspaceMode } from "../workspace-store.js";

export type ActivityAuditJsonValue =
  | null
  | boolean
  | number
  | string
  | ActivityAuditJsonValue[]
  | { [key: string]: ActivityAuditJsonValue };

export interface ActivityWorkspaceSnapshot {
  id?: string;
  root: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  branch?: string;
  targetBranch?: string;
}

interface ActivityAuditEventBase {
  id: string;
  activityId: string;
  sequence: number;
  createdAt: string;
}

export interface ActivityStartedAuditEvent extends ActivityAuditEventBase {
  type: "started";
  turnId: string;
  parentActivityId?: string;
  conversationScopeId?: string;
  tool: string;
  workspace: ActivityWorkspaceSnapshot;
  request?: ActivityAuditJsonValue;
}

export interface ActivitySucceededAuditEvent extends ActivityAuditEventBase {
  type: "succeeded";
  result?: ActivityAuditJsonValue;
}

export interface ActivityReturnedAuditEvent extends ActivityAuditEventBase {
  type: "returned";
  result?: ActivityAuditJsonValue;
}

export interface ActivityFailedAuditEvent extends ActivityAuditEventBase {
  type: "failed";
  result?: ActivityAuditJsonValue;
  error: string;
}

export interface ActivityBlockedAuditEvent extends ActivityAuditEventBase {
  type: "blocked";
  error: string;
}

export type ActivityAuditEvent =
  | ActivityStartedAuditEvent
  | ActivitySucceededAuditEvent
  | ActivityReturnedAuditEvent
  | ActivityFailedAuditEvent
  | ActivityBlockedAuditEvent;

type ActivityAuditGeneratedFields = "id" | "sequence" | "createdAt";

export type AppendActivityAuditEventInput =
  | Omit<ActivityStartedAuditEvent, ActivityAuditGeneratedFields>
  | Omit<ActivitySucceededAuditEvent, ActivityAuditGeneratedFields>
  | Omit<ActivityReturnedAuditEvent, ActivityAuditGeneratedFields>
  | Omit<ActivityFailedAuditEvent, ActivityAuditGeneratedFields>
  | Omit<ActivityBlockedAuditEvent, ActivityAuditGeneratedFields>;

export type ActivityRecordState = "executing" | "returned" | "done" | "failed" | "blocked";

export interface ActivityRecord {
  activityId: string;
  turnId: string;
  parentActivityId?: string;
  conversationScopeId?: string;
  tool: string;
  workspace: ActivityWorkspaceSnapshot;
  state: ActivityRecordState;
  request?: ActivityAuditJsonValue;
  result?: ActivityAuditJsonValue;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ActivityAuditStoreOptions {
  now?: () => Date;
}

interface ActivityAuditEventRow {
  id: string;
  activity_id: string;
  sequence: number;
  event_type: string;
  turn_id: string | null;
  parent_activity_id: string | null;
  conversation_scope_id: string | null;
  tool: string | null;
  workspace_id: string | null;
  workspace_root: string | null;
  workspace_mode: string | null;
  workspace_source_root: string | null;
  workspace_branch: string | null;
  workspace_target_branch: string | null;
  request_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
}

export class ActivityAuditStore {
  private readonly database: DatabaseHandle;
  private readonly now: () => Date;

  constructor(stateDir: string, options: ActivityAuditStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? (() => new Date());
  }

  append(input: AppendActivityAuditEventInput): ActivityAuditEvent {
    return this.database.sqlite.transaction(() => {
      const existing = this.readRows(input.activityId);
      if (input.type === "started") {
        if (existing.length > 0) {
          throw new Error(`Activity ${input.activityId} already has audit events.`);
        }
        if (input.parentActivityId) {
          const parent = this.getActivity(input.parentActivityId);
          if (!parent) {
            throw new Error(`Unknown parent Activity: ${input.parentActivityId}.`);
          }
          if (parent.turnId !== input.turnId) {
            throw new Error(
              `Parent Activity ${input.parentActivityId} belongs to Host Turn ${parent.turnId}, not ${input.turnId}.`,
            );
          }
        }
      } else if (existing.length === 0 || existing[0]?.event_type !== "started") {
        throw new Error(`Activity ${input.activityId} must start before recording ${input.type}.`);
      }

      const sequence = existing.length + 1;
      const id = `evt_${randomUUID().replaceAll("-", "")}`;
      const createdAt = this.now().toISOString();
      const row = eventInputToRow(input, { id, sequence, createdAt });

      this.database.sqlite.prepare(
        `insert into activity_audit_events (
          id,
          activity_id,
          sequence,
          event_type,
          turn_id,
          parent_activity_id,
          conversation_scope_id,
          tool,
          workspace_id,
          workspace_root,
          workspace_mode,
          workspace_source_root,
          workspace_branch,
          workspace_target_branch,
          request_json,
          result_json,
          error,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.activity_id,
        row.sequence,
        row.event_type,
        row.turn_id,
        row.parent_activity_id,
        row.conversation_scope_id,
        row.tool,
        row.workspace_id,
        row.workspace_root,
        row.workspace_mode,
        row.workspace_source_root,
        row.workspace_branch,
        row.workspace_target_branch,
        row.request_json,
        row.result_json,
        row.error,
        row.created_at,
      );

      return rowToEvent(row);
    })();
  }

  listEvents(activityId: string): ActivityAuditEvent[] {
    return this.readRows(activityId).map(rowToEvent);
  }

  listActivitiesByTurn(turnId: string): ActivityRecord[] {
    const rows = this.database.sqlite.prepare(
      `select activity_id from activity_audit_events
       where event_type = 'started' and turn_id = ?
       order by rowid asc`,
    ).all(turnId) as Array<{ activity_id: string }>;
    return rows.flatMap(({ activity_id }) => {
      const activity = this.getActivity(activity_id);
      return activity ? [activity] : [];
    });
  }

  turnRevision(turnId: string): number {
    return this.turnState(turnId).revision;
  }

  turnState(turnId: string): {
    revision: number;
    total: number;
    working: number;
    error: number;
  } {
    const row = this.database.sqlite.prepare(
      `with turn_activities as (
         select activity_id
         from activity_audit_events
         where event_type = 'started' and turn_id = ?
       ), turn_events as (
         select event.rowid, event.activity_id, event.event_type
         from activity_audit_events event
         join turn_activities turn_activity on turn_activity.activity_id = event.activity_id
       ), latest_events as (
         select event.event_type
         from turn_events event
         join (
           select activity_id, max(rowid) as rowid
           from turn_events
           group by activity_id
         ) latest on latest.rowid = event.rowid
       )
       select
         (select count(*) from turn_events) as revision,
         count(*) as total,
         coalesce(sum(case when event_type = 'started' then 1 else 0 end), 0) as working,
         coalesce(sum(case when event_type in ('failed', 'blocked') then 1 else 0 end), 0) as error
       from latest_events`,
    ).get(turnId) as {
      revision: number;
      total: number;
      working: number;
      error: number;
    };
    return row;
  }

  activityIdsSinceTurnRevision(turnId: string, knownRevision: number): string[] {
    const offset = Math.max(0, Math.floor(knownRevision));
    const rows = this.database.sqlite.prepare(
      `select activity_id, min(rowid) as first_rowid
       from (
         select event.rowid, event.activity_id
         from activity_audit_events event
         where event.activity_id in (
           select activity_id
           from activity_audit_events
           where event_type = 'started' and turn_id = ?
         )
         order by event.rowid asc
         limit -1 offset ?
       )
       group by activity_id
       order by first_rowid asc`,
    ).all(turnId, offset) as Array<{ activity_id: string }>;
    return rows.map((row) => row.activity_id);
  }

  getActivity(activityId: string): ActivityRecord | undefined {
    const events = this.listEvents(activityId);
    const started = events[0];
    if (!started || started.type !== "started") return undefined;

    let state: ActivityRecordState = "executing";
    let result: ActivityAuditJsonValue | undefined;
    let error: string | undefined;
    let updatedAt = started.createdAt;

    for (const event of events.slice(1)) {
      updatedAt = event.createdAt;
      switch (event.type) {
        case "started":
          break;
        case "succeeded":
          state = "done";
          result = event.result;
          error = undefined;
          break;
        case "returned":
          state = "returned";
          result = event.result;
          error = undefined;
          break;
        case "failed":
          state = "failed";
          result = event.result;
          error = event.error;
          break;
        case "blocked":
          state = "blocked";
          result = undefined;
          error = event.error;
          break;
      }
    }

    return {
      activityId: started.activityId,
      turnId: started.turnId,
      ...(started.parentActivityId ? { parentActivityId: started.parentActivityId } : {}),
      ...(started.conversationScopeId ? { conversationScopeId: started.conversationScopeId } : {}),
      tool: started.tool,
      workspace: started.workspace,
      state,
      ...(started.request !== undefined ? { request: started.request } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      startedAt: started.createdAt,
      updatedAt,
    };
  }

  close(): void {
    this.database.close();
  }

  private readRows(activityId: string): ActivityAuditEventRow[] {
    return this.database.sqlite.prepare(
      `select * from activity_audit_events
       where activity_id = ?
       order by sequence asc`,
    ).all(activityId) as ActivityAuditEventRow[];
  }
}

function eventInputToRow(
  input: AppendActivityAuditEventInput,
  identity: { id: string; sequence: number; createdAt: string },
): ActivityAuditEventRow {
  if (input.type === "started") {
    return {
      id: identity.id,
      activity_id: input.activityId,
      sequence: identity.sequence,
      event_type: input.type,
      turn_id: input.turnId,
      parent_activity_id: input.parentActivityId ?? null,
      conversation_scope_id: input.conversationScopeId ?? null,
      tool: input.tool,
      workspace_id: input.workspace.id ?? null,
      workspace_root: input.workspace.root,
      workspace_mode: input.workspace.mode,
      workspace_source_root: input.workspace.sourceRoot ?? null,
      workspace_branch: input.workspace.branch ?? null,
      workspace_target_branch: input.workspace.targetBranch ?? null,
      request_json: serializeJson(input.request),
      result_json: null,
      error: null,
      created_at: identity.createdAt,
    };
  }

  return {
    id: identity.id,
    activity_id: input.activityId,
    sequence: identity.sequence,
    event_type: input.type,
    turn_id: null,
    parent_activity_id: null,
    conversation_scope_id: null,
    tool: null,
    workspace_id: null,
    workspace_root: null,
    workspace_mode: null,
    workspace_source_root: null,
    workspace_branch: null,
    workspace_target_branch: null,
    request_json: null,
    result_json: "result" in input ? serializeJson(input.result) : null,
    error: "error" in input ? input.error : null,
    created_at: identity.createdAt,
  };
}

function rowToEvent(row: ActivityAuditEventRow): ActivityAuditEvent {
  const base = {
    id: row.id,
    activityId: row.activity_id,
    sequence: row.sequence,
    createdAt: row.created_at,
  };

  switch (row.event_type) {
    case "started":
      if (!row.turn_id || !row.tool || !row.workspace_root || !isWorkspaceMode(row.workspace_mode)) {
        throw new Error(`Activity audit start event ${row.id} is missing required context.`);
      }
      return {
        ...base,
        type: "started",
        turnId: row.turn_id,
        ...(row.parent_activity_id ? { parentActivityId: row.parent_activity_id } : {}),
        ...(row.conversation_scope_id ? { conversationScopeId: row.conversation_scope_id } : {}),
        tool: row.tool,
        workspace: {
          ...(row.workspace_id ? { id: row.workspace_id } : {}),
          root: row.workspace_root,
          mode: row.workspace_mode,
          ...(row.workspace_source_root ? { sourceRoot: row.workspace_source_root } : {}),
          ...(row.workspace_branch ? { branch: row.workspace_branch } : {}),
          ...(row.workspace_target_branch ? { targetBranch: row.workspace_target_branch } : {}),
        },
        ...(row.request_json !== null ? { request: parseJson(row.request_json) } : {}),
      };
    case "succeeded":
      return {
        ...base,
        type: "succeeded",
        result: parseJson(row.result_json),
      };
    case "returned":
      return {
        ...base,
        type: "returned",
        result: parseJson(row.result_json),
      };
    case "failed":
      if (!row.error) throw new Error(`Activity audit failed event ${row.id} is missing an error.`);
      return {
        ...base,
        type: "failed",
        result: parseJson(row.result_json),
        error: row.error,
      };
    case "blocked":
      if (!row.error) throw new Error(`Activity audit blocked event ${row.id} is missing an error.`);
      return {
        ...base,
        type: "blocked",
        error: row.error,
      };
    default:
      throw new Error(`Unknown Activity audit event type: ${row.event_type}`);
  }
}

function isWorkspaceMode(value: string | null): value is WorkspaceMode {
  return value === "checkout" || value === "worktree";
}

function serializeJson(value: ActivityAuditJsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string | null): ActivityAuditJsonValue | undefined {
  return value === null ? undefined : JSON.parse(value) as ActivityAuditJsonValue;
}
