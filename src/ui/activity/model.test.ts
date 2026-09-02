import assert from "node:assert/strict";
import test from "node:test";
import {
  activityRefreshDelayMs,
  applyActivityIndex,
  applyActivitySnapshot,
  groupActivitySummaries,
  isActivityBashOutput,
  isActivityDetail,
  isActivityIndex,
  isHostTurnSnapshot,
  isHostTurnState,
  readActivityPanelDefaultExpanded,
  routeActivityToolResult,
  shouldFollowActivityTail,
  type ActivitySummary,
  type HostTurnSnapshot,
} from "./model.js";

function activity(
  activityId: string,
  overrides: Partial<ActivitySummary> = {},
): ActivitySummary {
  return {
    activityId,
    tool: "read",
    kind: "read",
    status: "done",
    state: "done",
    title: "Read",
    target: `${activityId}.txt`,
    detailAvailable: true,
    startedAt: "2026-08-17T00:00:00.000Z",
    finishedAt: "2026-08-17T00:00:00.010Z",
    durationMs: 10,
    ...overrides,
  };
}

function snapshot(
  revision: number,
  activities: ActivitySummary[],
  overrides: Partial<HostTurnSnapshot> = {},
): HostTurnSnapshot {
  return {
    turnId: "turn_ui",
    revision,
    changed: true,
    state: "done",
    activities,
    ...overrides,
  };
}

test("Activity Panel model reads default-expanded only from the dedicated result metadata key", () => {
  assert.equal(readActivityPanelDefaultExpanded(undefined), false);
  assert.equal(readActivityPanelDefaultExpanded({ "forgerelay/activityPanelDefaultExpanded": true }), true);
  assert.equal(readActivityPanelDefaultExpanded({ "forgerelay/activityPanelDefaultExpanded": false }), false);
  assert.equal(readActivityPanelDefaultExpanded({ activityPanelDefaultExpanded: true }), false);
});

test("Activity Panel routing preserves an active Host Turn when ordinary tool results arrive", () => {
  const hostTurn = snapshot(0, []);
  assert.equal(routeActivityToolResult(false, hostTurn), "activity");
  assert.equal(routeActivityToolResult(true, { result: "read result", path: "file.txt" }), "preserve-panel");
  assert.equal(routeActivityToolResult(false, { result: "read result", path: "file.txt" }), "tool-card");
});

test("Activity Panel model separates state-only Host Turn updates from lazy Activity indexes", () => {
  const stateOnly = { turnId: "turn_ui", revision: 0, changed: true, state: "working" as const };
  assert.equal(isHostTurnState(stateOnly), true);
  assert.equal(isActivityIndex(stateOnly), false);
  assert.equal(isHostTurnSnapshot(stateOnly), false);
  assert.equal(isActivityIndex(snapshot(0, [])), true);
  assert.equal(isHostTurnSnapshot(snapshot(1, [activity("act_member", { member: "code" })])), true);
  assert.equal(isActivityIndex(snapshot(1, [activity("act_member", { member: 42 as unknown as string })])), false);
  assert.equal(isHostTurnState({ result: "read result", path: "file.txt" }), false);
});

test("Activity Panel model validates durable Bash output independently from Activity lifecycle state", () => {
  assert.equal(isActivityBashOutput({
    outputId: "out_1",
    activityId: "act_bash",
    processId: 7,
    command: "npm test",
    output: "ok\n",
    cursor: 1,
    status: "running",
    timedOut: false,
    startedAt: "2026-08-17T00:00:00.000Z",
  }), true);
  assert.equal(isActivityBashOutput({
    outputId: "out_1",
    activityId: "act_bash",
    processId: 7,
    command: "npm test",
    output: "ok\n",
    cursor: 1,
    status: "returned",
    timedOut: false,
    startedAt: "2026-08-17T00:00:00.000Z",
  }), false);
});

test("Activity Panel model accepts lazy detail only when it carries a valid Activity summary", () => {
  const summary = activity("act_detail");
  assert.equal(isActivityDetail({ activity: summary, request: { path: "detail.txt" } }), true);
  assert.equal(isActivityDetail({ activity: summary, result: "done", error: "failed" }), true);
  assert.equal(isActivityDetail({ request: { path: "detail.txt" } }), false);
  assert.equal(isActivityDetail({ activity: { activityId: "act_detail" } }), false);
});

test("Activity Panel model merges Activity index deltas without retransmitting unchanged rows", () => {
  const current = [
    activity("act_a", { target: "a-old.txt" }),
    activity("act_b", { target: "b.txt" }),
  ];
  const delta = snapshot(5, [
    activity("act_a", { target: "a-new.txt" }),
    activity("act_c", { target: "c.txt" }),
  ]);
  assert.deepEqual(
    applyActivityIndex(current, delta).map((entry) => [entry.activityId, entry.target]),
    [["act_a", "a-new.txt"], ["act_b", "b.txt"], ["act_c", "c.txt"]],
  );
  assert.equal(applyActivityIndex(current, snapshot(4, [], { changed: false })), current);
});

test("Activity Panel model preserves summaries when an unchanged revision omits activities", () => {
  const current = snapshot(4, [activity("act_a")]);
  const unchanged = snapshot(4, [], { changed: false });
  assert.deepEqual(applyActivitySnapshot(current, unchanged), {
    ...unchanged,
    activities: current.activities,
  });

  const next = snapshot(5, [activity("act_a"), activity("act_b")]);
  assert.deepEqual(applyActivitySnapshot(current, next), next);
});

test("Activity Panel model groups Bulk and Batch children under their parent in stable order", () => {
  const parent = activity("act_parent", {
    tool: "batch",
    kind: "batch",
    title: "Batch",
    target: "3 tasks",
    detailAvailable: false,
    children: { total: 3, working: 0, done: 2, error: 1 },
  });
  const first = activity("act_first", { parentActivityId: parent.activityId });
  const second = activity("act_second", {
    parentActivityId: parent.activityId,
    tool: "bash",
    kind: "shell",
    title: "Bash",
    target: "Shell command",
    bashPhase: "done",
  });
  const orphan = activity("act_orphan", { parentActivityId: "act_missing" });
  const third = activity("act_third", {
    parentActivityId: parent.activityId,
    status: "error",
    state: "failed",
  });

  assert.deepEqual(groupActivitySummaries([parent, first, second, orphan, third]), [
    { activity: parent, children: [first, second, third] },
    { activity: orphan, children: [] },
  ]);
});

test("Activity Panel refresh policy backs off unchanged work and stops terminal or hidden polling", () => {
  assert.equal(activityRefreshDelayMs("working", 0, true), 1_000);
  assert.equal(activityRefreshDelayMs("working", 1, true), 2_000);
  assert.equal(activityRefreshDelayMs("working", 2, true), 5_000);
  assert.equal(activityRefreshDelayMs("working", 3, true), 10_000);
  assert.equal(activityRefreshDelayMs("working", 99, true), 10_000);
  assert.equal(activityRefreshDelayMs("done", 0, true), null);
  assert.equal(activityRefreshDelayMs("error", 0, true), null);
  assert.equal(activityRefreshDelayMs("working", 0, false), null);
});

test("Activity Panel model follows new rows only while the viewport is at the tail", () => {
  assert.equal(shouldFollowActivityTail({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 }), true);
  assert.equal(shouldFollowActivityTail({ scrollTop: 380, clientHeight: 200, scrollHeight: 600 }), true);
  assert.equal(shouldFollowActivityTail({ scrollTop: 250, clientHeight: 200, scrollHeight: 600 }), false);
});
