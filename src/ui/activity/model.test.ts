import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActivitySnapshot,
  groupActivitySummaries,
  isActivityBashOutput,
  isActivityDetail,
  isHostTurnSnapshot,
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

test("Activity Panel model recognizes Host Turn snapshots without mistaking tool cards for them", () => {
  assert.equal(isHostTurnSnapshot(snapshot(0, [])), true);
  assert.equal(isHostTurnSnapshot({ result: "read result", path: "file.txt" }), false);
  assert.equal(isHostTurnSnapshot({ turnId: "turn_ui", revision: 0, changed: true, state: "done" }), false);
});

test("Activity Panel model validates durable Bash output independently from Activity lifecycle state", () => {
  assert.equal(isActivityBashOutput({
    outputId: "out_1",
    activityId: "act_bash",
    processId: 7,
    command: "npm test",
    output: "ok\n",
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

test("Activity Panel model follows new rows only while the viewport is at the tail", () => {
  assert.equal(shouldFollowActivityTail({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 }), true);
  assert.equal(shouldFollowActivityTail({ scrollTop: 380, clientHeight: 200, scrollHeight: 600 }), true);
  assert.equal(shouldFollowActivityTail({ scrollTop: 250, clientHeight: 200, scrollHeight: 600 }), false);
});
