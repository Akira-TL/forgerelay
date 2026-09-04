import type Database from "better-sqlite3";

const TERMINAL_ACTIVITY_EVENTS = "'succeeded', 'returned', 'failed', 'blocked'";

export function eligibleActivityCte(sqlite: Database.Database): string {
  if (!tableExists(sqlite, "activity_audit_events") || !tableExists(sqlite, "activity_host_turns")) {
    return `with retention(cutoff) as (values (?)),
      eligible_turns(turn_id) as (select null where false),
      eligible_activities(activity_id) as (select null where false)`;
  }

  const runningBash = tableExists(sqlite, "bash_output_streams")
    ? `exists (
         select 1 from bash_output_streams running_bash
          where running_bash.activity_id = started.activity_id
            and running_bash.status = 'running'
       )`
    : "false";
  const hasSubagents = tableExists(sqlite, "local_agent_sessions");
  const hasActiveRunId = hasSubagents && columnExists(sqlite, "local_agent_sessions", "active_run_id");
  const hasActiveActivityId = hasSubagents && columnExists(sqlite, "local_agent_sessions", "active_activity_id");
  const activeSubagentPredicate = hasSubagents
    ? hasActiveRunId
      ? "(active_subagent.status = 'running' or active_subagent.active_run_id is not null)"
      : "active_subagent.status = 'running'"
    : "false";
  const activeSubagent = hasSubagents && hasActiveActivityId
    ? `exists (
         select 1 from local_agent_sessions active_subagent
          where active_subagent.active_activity_id = started.activity_id
            and ${activeSubagentPredicate}
       )`
    : "false";
  const unknownActiveSubagent = hasSubagents
    ? hasActiveActivityId
      ? `exists (
           select 1 from local_agent_sessions active_subagent
            where ${activeSubagentPredicate}
              and active_subagent.active_activity_id is null
         )`
      : `exists (
           select 1 from local_agent_sessions active_subagent
            where ${activeSubagentPredicate}
         )`
    : "false";

  return `with retention(cutoff) as (values (?)),
          latest_activity_events as (
            select activity_id, max(sequence) as sequence
              from activity_audit_events
             group by activity_id
          ), started_activities as (
            select started.activity_id, started.turn_id
              from activity_audit_events started
             where started.event_type = 'started' and started.turn_id is not null
          ), protected_turns as (
            select distinct started.turn_id
              from started_activities started
             where ${runningBash} or ${activeSubagent}
          ), eligible_turns as (
            select turn_state.turn_id
              from activity_host_turns turn_state, retention
             where turn_state.created_at < retention.cutoff
               and not (${unknownActiveSubagent})
               and turn_state.turn_id not in (select turn_id from protected_turns)
               and not exists (
                 select 1
                   from started_activities started
                   join latest_activity_events latest on latest.activity_id = started.activity_id
                   join activity_audit_events latest_event
                     on latest_event.activity_id = latest.activity_id
                    and latest_event.sequence = latest.sequence
                  where started.turn_id = turn_state.turn_id
                    and (
                      latest_event.created_at >= retention.cutoff
                      or latest_event.event_type not in (${TERMINAL_ACTIVITY_EVENTS})
                    )
               )
          ), eligible_activities as (
            select started.activity_id
              from started_activities started
              join eligible_turns turn_state on turn_state.turn_id = started.turn_id
          )`;
}

export function bashBytesExpression(sqlite: Database.Database): string {
  const parts = [columnExists(sqlite, "bash_output_streams", "output_bytes") ? "coalesce(output_bytes, 0)" : "0"];
  if (columnExists(sqlite, "bash_output_streams", "command_length")) parts.push("coalesce(command_length, 0)");
  if (columnExists(sqlite, "bash_output_streams", "error_length")) parts.push("coalesce(error_length, 0)");
  return parts.join(" + ");
}

export function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

export function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  return (sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}
