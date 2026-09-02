import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { ActivityAuditStore } from "./audit-store.js";

test("Activity audit survives restart and Workspace deletion", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-audit-test-"));
  let now = new Date("2026-08-14T12:00:00.000Z");
  const clock = () => new Date(now);
  const workspaceStore = new SqliteWorkspaceStore(stateDir, {
    now: clock,
    touchFlushIntervalMs: 60 * 60 * 1_000,
  });
  let auditStore = new ActivityAuditStore(stateDir, { now: clock });

  t.after(async () => {
    auditStore.close();
    workspaceStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  workspaceStore.createSession({
    id: "ws_audit",
    root: "/tmp/forgerelay-audit-workspace",
    mode: "checkout",
  });

  auditStore.append({
    type: "started",
    activityId: "act_read",
    turnId: "turn_1",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace: {
      id: "ws_audit",
      root: "/tmp/forgerelay-audit-workspace",
      mode: "checkout",
      branch: "feat/audit",
    },
    request: { path: "README.md" },
  });

  now = new Date("2026-08-14T12:00:01.000Z");
  auditStore.append({
    type: "succeeded",
    activityId: "act_read",
    result: { lines: 12 },
  });

  assert.deepEqual(auditStore.listEvents("act_read").map((event) => [event.sequence, event.type]), [
    [1, "started"],
    [2, "succeeded"],
  ]);

  assert.deepEqual(auditStore.getActivity("act_read"), {
    activityId: "act_read",
    turnId: "turn_1",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace: {
      id: "ws_audit",
      root: "/tmp/forgerelay-audit-workspace",
      mode: "checkout",
      branch: "feat/audit",
    },
    state: "done",
    request: { path: "README.md" },
    result: { lines: 12 },
    startedAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:01.000Z",
  });

  auditStore.close();
  workspaceStore.deleteSession("ws_audit");
  auditStore = new ActivityAuditStore(stateDir, { now: clock });

  const restored = auditStore.getActivity("act_read");
  assert.equal(restored?.state, "done");
  assert.equal(restored?.workspace.id, "ws_audit");
  assert.equal(restored?.workspace.root, "/tmp/forgerelay-audit-workspace");
  assert.deepEqual(restored?.request, { path: "README.md" });
  assert.deepEqual(restored?.result, { lines: 12 });
});

test("Activity audit stores payloads in Workspace log shards instead of SQLite text columns", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-file-backed-test-"));
  const auditStore = new ActivityAuditStore(stateDir);
  t.after(async () => {
    auditStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const request = { path: "src/large.ts", content: "request payload".repeat(1_000) };
  const result = { content: "result payload".repeat(1_000) };
  auditStore.append({
    type: "started",
    activityId: "act_file_backed",
    turnId: "turn_file_backed",
    tool: "write",
    workspace: {
      id: "ws_filebacked",
      root: "/tmp/forgerelay-file-backed",
      mode: "checkout",
    },
    request,
  });
  auditStore.append({
    type: "succeeded",
    activityId: "act_file_backed",
    result,
  });

  const sqlite = new Database(join(stateDir, "forgerelay.sqlite"), { readonly: true });
  try {
    const rows = sqlite.prepare(
      `select request_json, result_json, error, payload_file, payload_offset, payload_length
       from activity_audit_events where activity_id = ? order by sequence`,
    ).all("act_file_backed") as Array<{
      request_json: string | null;
      result_json: string | null;
      error: string | null;
      payload_file: string | null;
      payload_offset: number | null;
      payload_length: number | null;
    }>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.request_json, null);
      assert.equal(row.result_json, null);
      assert.equal(row.error, null);
      assert.ok(row.payload_file?.includes("workspaces/ws_filebacked/activity/events"));
      assert.ok((row.payload_offset ?? -1) >= 0);
      assert.ok((row.payload_length ?? 0) > 0);
    }
  } finally {
    sqlite.close();
  }

  assert.deepEqual(auditStore.getActivity("act_file_backed")?.request, request);
  assert.deepEqual(auditStore.getActivity("act_file_backed")?.result, result);
});

test("Activity audit represents failed and hook-blocked outcomes without rewriting earlier facts", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-audit-outcomes-test-"));
  const auditStore = new ActivityAuditStore(stateDir, {
    now: () => new Date("2026-08-14T13:00:00.000Z"),
  });

  t.after(async () => {
    auditStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspace = {
    id: "ws_outcomes",
    root: "/tmp/forgerelay-audit-outcomes",
    mode: "checkout" as const,
  };

  auditStore.append({
    type: "started",
    activityId: "act_failed",
    turnId: "turn_failed",
    tool: "edit",
    workspace,
    request: { path: "src/a.ts" },
  });
  auditStore.append({
    type: "failed",
    activityId: "act_failed",
    error: "permission denied",
  });

  auditStore.append({
    type: "started",
    activityId: "act_blocked",
    turnId: "turn_blocked",
    tool: "bash",
    workspace,
    request: { command: "git push origin main" },
  });
  auditStore.append({
    type: "blocked",
    activityId: "act_blocked",
    error: "BeforeTool hook blocked command",
  });

  assert.equal(auditStore.getActivity("act_failed")?.state, "failed");
  assert.equal(auditStore.getActivity("act_failed")?.error, "permission denied");
  assert.equal(auditStore.getActivity("act_blocked")?.state, "blocked");
  assert.equal(auditStore.getActivity("act_blocked")?.error, "BeforeTool hook blocked command");
  assert.deepEqual(auditStore.listEvents("act_blocked").map((event) => event.type), [
    "started",
    "blocked",
  ]);
});

test("Activity audit persists durable parent-child linkage across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-parent-test-"));
  let auditStore = new ActivityAuditStore(stateDir);
  let closed = false;
  t.after(async () => {
    if (!closed) auditStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspace = {
    id: "ws_parent",
    root: "/tmp/forgerelay-parent",
    mode: "checkout" as const,
  };
  assert.throws(() => auditStore.append({
    type: "started",
    activityId: "act_orphan",
    parentActivityId: "act_missing_parent",
    turnId: "turn_parent",
    tool: "read",
    workspace,
    request: { path: "orphan.ts" },
  }), /unknown parent Activity/i);

  auditStore.append({
    type: "started",
    activityId: "act_parent",
    turnId: "turn_parent",
    tool: "read",
    workspace,
    request: { paths: ["a.ts", "b.ts"] },
  });
  assert.throws(() => auditStore.append({
    type: "started",
    activityId: "act_cross_turn",
    parentActivityId: "act_parent",
    turnId: "turn_other",
    tool: "read",
    workspace,
    request: { path: "cross.ts" },
  }), /belongs to Host Turn turn_parent, not turn_other/i);

  auditStore.append({
    type: "started",
    activityId: "act_child",
    parentActivityId: "act_parent",
    turnId: "turn_parent",
    tool: "read",
    workspace,
    request: { path: "a.ts" },
  });
  auditStore.append({ type: "succeeded", activityId: "act_child", result: { lines: 1 } });
  auditStore.append({ type: "succeeded", activityId: "act_parent", result: { childCount: 1 } });

  assert.equal(auditStore.getActivity("act_child")?.parentActivityId, "act_parent");
  assert.equal(auditStore.getActivity("act_parent")?.parentActivityId, undefined);

  auditStore.close();
  closed = true;
  auditStore = new ActivityAuditStore(stateDir);
  closed = false;

  assert.equal(auditStore.getActivity("act_child")?.parentActivityId, "act_parent");
  assert.deepEqual(
    auditStore.listActivitiesByTurn("turn_parent").map((activity) => [activity.activityId, activity.parentActivityId]),
    [["act_parent", undefined], ["act_child", "act_parent"]],
  );
});
