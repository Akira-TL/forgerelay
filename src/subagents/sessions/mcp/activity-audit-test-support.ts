import assert from "node:assert/strict";
import type {
  ActivityAuditEvent,
  ActivityAuditStore,
} from "../../../activity/history/audit-store.js";
import { openDatabase } from "../../../runtime/state/db/client.js";

export interface ActivityAuditIndexRow {
  activity_id: string;
  event_type: string;
  tool: string | null;
  request_json: string | null;
  result_json: string | null;
  error: string | null;
  payload_file: string | null;
  payload_offset: number | null;
  payload_length: number | null;
}

export interface ActivityAuditSnapshot {
  rows: ActivityAuditIndexRow[];
  events: ActivityAuditEvent[];
}

export function readActivityAuditSnapshot(
  stateDir: string,
  auditStore: ActivityAuditStore,
): ActivityAuditSnapshot {
  const database = openDatabase(stateDir);
  try {
    const rows = database.sqlite.prepare(
      `select activity_id, event_type, tool, request_json, result_json, error,
              payload_file, payload_offset, payload_length
       from activity_audit_events
       order by rowid`,
    ).all() as ActivityAuditIndexRow[];

    for (const row of rows) {
      assert.equal(row.request_json, null, "Activity request payload must not be stored in SQLite.");
      assert.equal(row.result_json, null, "Activity result payload must not be stored in SQLite.");
      assert.equal(row.error, null, "Activity error payload must not be stored in SQLite.");
    }

    const activityIds = [...new Set(rows.map((row) => row.activity_id))];
    return {
      rows,
      events: activityIds.flatMap((activityId) => auditStore.listEvents(activityId)),
    };
  } finally {
    database.close();
  }
}

export function activityEventsForTool(
  snapshot: ActivityAuditSnapshot,
  tool: string,
): ActivityAuditEvent[] {
  const activityIds = new Set(
    snapshot.rows
      .filter((row) => row.tool === tool)
      .map((row) => row.activity_id),
  );
  return snapshot.events.filter((event) => activityIds.has(event.activityId));
}
