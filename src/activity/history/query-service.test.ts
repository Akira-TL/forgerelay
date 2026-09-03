import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityAuditStore } from "./audit-store.js";
import { BashOutputStore } from "./bash-output-store.js";
import { HostTurnStore } from "./host-turn-store.js";
import { ActivityQueryService } from "./query-service.js";

const workspace = {
  id: "ws_query",
  root: "/tmp/forgerelay-query",
  mode: "checkout" as const,
};

const HEAVY = {
  read: "READ-CONTENT-SENTINEL",
  write: "WRITE-PATCH-SENTINEL",
  edit: "EDIT-PATCH-SENTINEL",
  bashCommand: "printf BASH-COMMAND-SENTINEL",
  bashOutput: "BASH-OUTPUT-SENTINEL\n",
  capability: "CAPABILITY-DETAIL-SENTINEL",
};

test("Host Turn query contract persists summaries, lazy detail, and Bash output across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-query-test-"));

  let clock = 0;
  const now = () => new Date(Date.UTC(2026, 7, 15, 3, 0, clock++));
  const turns = new HostTurnStore(stateDir, {
    now,
    turnId: () => "turn_query_1",
  });
  const audit = new ActivityAuditStore(stateDir, { now });
  const outputs = new BashOutputStore(stateDir, {
    now,
    outputId: () => "out_query_1",
  });
  const query = new ActivityQueryService(turns, audit, outputs);
  let initialStoresClosed = false;
  let restoredTurns: HostTurnStore | undefined;
  let restoredAudit: ActivityAuditStore | undefined;
  let restoredOutputs: BashOutputStore | undefined;
  t.after(async () => {
    restoredOutputs?.close();
    restoredAudit?.close();
    restoredTurns?.close();
    if (!initialStoresClosed) {
      outputs.close();
      audit.close();
      turns.close();
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  const turn = turns.begin("conversation_query", workspace.id);
  assert.equal(turn.turnId, "turn_query_1");
  assert.equal(turn.workspaceId, workspace.id);
  assert.equal(turns.current("conversation_query", workspace.id)?.turnId, turn.turnId);

  const start = (activityId: string, tool: string, request: unknown) => audit.append({
    type: "started",
    activityId,
    turnId: turn.turnId,
    conversationScopeId: "conversation_query",
    tool,
    workspace,
    request: request as never,
  });
  const done = (activityId: string, result: unknown) => audit.append({
    type: "succeeded",
    activityId,
    result: result as never,
  });

  start("act_read", "read", { workspaceId: workspace.id, path: "src/read.ts" });
  done("act_read", { content: [{ type: "text", text: HEAVY.read }] });

  start("act_write", "write", { workspaceId: workspace.id, path: "src/write.ts", content: "new body" });
  done("act_write", { _meta: { card: { payload: { patch: HEAVY.write } } } });

  start("act_edit", "edit", { workspaceId: workspace.id, path: "src/edit.ts", oldText: "a", newText: "b" });
  done("act_edit", { _meta: { card: { payload: { patch: HEAVY.edit } } } });

  start("act_rename", "rename", { workspaceId: workspace.id, path: "src/old.ts", newPath: "src/new.ts" });
  done("act_rename", { structuredContent: { result: "Renamed." } });

  start("act_delete", "delete", { workspaceId: workspace.id, path: "src/dead.ts" });
  done("act_delete", { structuredContent: { result: "Deleted." } });

  start("act_cap", "capability", {
    workspaceId: workspace.id,
    name: "review.changes",
    action: "run",
    arguments: { secret: HEAVY.capability },
  });
  done("act_cap", { structuredContent: { result: { payload: HEAVY.capability } } });

  start("act_bash", "bash", {
    workspaceId: workspace.id,
    action: "run",
    command: HEAVY.bashCommand,
  });
  const outputId = outputs.begin({
    activityId: "act_bash",
    turnId: turn.turnId,
    conversationScopeId: "conversation_query",
    processId: 41,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    command: HEAVY.bashCommand,
    tty: false,
  });
  outputs.append(outputId, "stdout", HEAVY.bashOutput);
  outputs.finish(outputId, { exitCode: 0, timedOut: false });
  done("act_bash", {
    structuredContent: {
      result: `last-line\nFull output ID: ${outputId}`,
      outputId,
      running: false,
      exitCode: 0,
      timedOut: false,
      wallTimeMs: 25,
    },
  });

  const snapshot = query.snapshot(turn.turnId);
  assert.equal(snapshot.turnId, turn.turnId);
  assert.equal(snapshot.changed, true);
  assert.equal(snapshot.state, "done");
  assert.equal(snapshot.activities.length, 7);
  assert.ok(snapshot.revision > 0);
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_rename")?.target, "src/old.ts → src/new.ts");
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_delete")?.target, "src/dead.ts");
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_rename")?.detailAvailable, false);
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_delete")?.detailAvailable, false);
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_bash")?.commandLength, HEAVY.bashCommand.length);
  assert.equal(snapshot.activities.find((activity) => activity.activityId === "act_bash")?.outputId, outputId);

  const serializedSnapshot = JSON.stringify(snapshot);
  for (const sentinel of Object.values(HEAVY)) {
    assert.doesNotMatch(serializedSnapshot, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const unchanged = query.snapshot(turn.turnId, snapshot.revision);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, snapshot.revision);
  assert.deepEqual(unchanged.activities, []);

  const readDetail = query.detail(turn.turnId, "act_read");
  assert.match(JSON.stringify(readDetail), /READ-CONTENT-SENTINEL/);
  const capabilityDetail = query.detail(turn.turnId, "act_cap");
  assert.match(JSON.stringify(capabilityDetail), /CAPABILITY-DETAIL-SENTINEL/);
  assert.throws(() => query.detail(turn.turnId, "act_rename"), /summary-complete/i);
  assert.throws(() => query.detail(turn.turnId, "act_delete"), /summary-complete/i);

  const fullOutput = query.bashOutput(turn.turnId, outputId);
  assert.equal(fullOutput.outputId, outputId);
  assert.equal(fullOutput.command, HEAVY.bashCommand);
  assert.equal(fullOutput.output, HEAVY.bashOutput);

  outputs.close();
  audit.close();
  turns.close();
  initialStoresClosed = true;

  restoredTurns = new HostTurnStore(stateDir);
  restoredAudit = new ActivityAuditStore(stateDir);
  restoredOutputs = new BashOutputStore(stateDir);
  const restoredQuery = new ActivityQueryService(restoredTurns, restoredAudit, restoredOutputs);

  assert.equal(restoredTurns.get(turn.turnId)?.conversationScopeId, "conversation_query");
  assert.equal(restoredTurns.get(turn.turnId)?.workspaceId, workspace.id);
  assert.equal(restoredQuery.snapshot(turn.turnId).activities.length, 7);
  assert.match(JSON.stringify(restoredQuery.detail(turn.turnId, "act_edit")), /EDIT-PATCH-SENTINEL/);
  assert.equal(restoredQuery.bashOutput(turn.turnId, outputId).output, HEAVY.bashOutput);
});

test("Activity state polling stays content-free while Activity index returns only changed summaries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-query-tier-test-"));
  const turns = new HostTurnStore(stateDir, { turnId: () => "turn_tiered_query" });
  const audit = new ActivityAuditStore(stateDir);
  const outputs = new BashOutputStore(stateDir);
  const query = new ActivityQueryService(turns, audit, outputs);
  t.after(async () => {
    outputs.close();
    audit.close();
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const turn = turns.begin("conversation_tiered_query", workspace.id);
  audit.append({
    type: "started",
    activityId: "act_tier_parent",
    turnId: turn.turnId,
    conversationScopeId: "conversation_tiered_query",
    tool: "batch",
    workspace,
    request: { tasks: [{ tool: "read" }] },
  });
  audit.append({
    type: "started",
    activityId: "act_tier_read",
    parentActivityId: "act_tier_parent",
    turnId: turn.turnId,
    conversationScopeId: "conversation_tiered_query",
    tool: "read",
    workspace,
    request: { path: "src/tier.ts" },
  });

  const initialState = query.state(turn.turnId);
  assert.deepEqual(Object.keys(initialState).sort(), ["changed", "revision", "state", "turnId"]);
  assert.equal(initialState.state, "working");
  assert.equal(initialState.changed, true);

  const initialIndex = query.index(turn.turnId);
  assert.equal(initialIndex.revision, initialState.revision);
  assert.deepEqual(
    initialIndex.activities.map((activity) => activity.activityId),
    ["act_tier_parent", "act_tier_read"],
  );

  const unchangedState = query.state(turn.turnId, initialState.revision);
  assert.equal(unchangedState.changed, false);
  const unchangedIndex = query.index(turn.turnId, initialIndex.revision);
  assert.equal(unchangedIndex.changed, false);
  assert.deepEqual(unchangedIndex.activities, []);

  audit.append({
    type: "succeeded",
    activityId: "act_tier_read",
    result: { content: [{ type: "text", text: "TIERED-DETAIL-SENTINEL" }] },
  });

  const changedState = query.state(turn.turnId, initialState.revision);
  assert.equal(changedState.changed, true);
  assert.equal(changedState.state, "working");
  assert.equal("activities" in changedState, false);

  const deltaIndex = query.index(turn.turnId, initialIndex.revision);
  assert.equal(deltaIndex.changed, true);
  assert.deepEqual(
    deltaIndex.activities.map((activity) => activity.activityId),
    ["act_tier_parent", "act_tier_read"],
    "child changes also update the parent aggregate without retransmitting unrelated rows",
  );
  assert.deepEqual(deltaIndex.activities[0]?.children, { total: 1, working: 0, done: 1, error: 0 });
  assert.doesNotMatch(JSON.stringify(deltaIndex), /TIERED-DETAIL-SENTINEL/);
});

test("current Host Turn is scoped by conversation and workspace", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-query-workspace-turn-test-"));
  const turns = new HostTurnStore(stateDir, { turnId: (() => {
    let index = 0;
    return () => `turn_workspace_${++index}`;
  })() });
  const audit = new ActivityAuditStore(stateDir);
  const outputs = new BashOutputStore(stateDir);
  const query = new ActivityQueryService(turns, audit, outputs);
  t.after(async () => {
    outputs.close();
    audit.close();
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = query.beginTurn("conversation_workspace_scope", "ws_first");
  const second = query.beginTurn("conversation_workspace_scope", "ws_second");

  assert.notEqual(first.turnId, second.turnId);
  assert.equal(query.currentTurnId("conversation_workspace_scope", "ws_first"), first.turnId);
  assert.equal(query.currentTurnId("conversation_workspace_scope", "ws_second"), second.turnId);
  assert.equal(query.currentTurnId("conversation_workspace_scope", "ws_missing"), undefined);
});

test("Bash output lookup is scoped to an Activity visible in the requested Host Turn", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-query-scope-test-"));
  const turns = new HostTurnStore(stateDir, { turnId: (() => {
    let index = 0;
    return () => `turn_scope_${++index}`;
  })() });
  const audit = new ActivityAuditStore(stateDir);
  const outputs = new BashOutputStore(stateDir, { outputId: () => "out_scope" });
  const query = new ActivityQueryService(turns, audit, outputs);
  t.after(async () => {
    outputs.close();
    audit.close();
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const first = turns.begin("conversation_scope", workspace.id);
  const second = turns.begin("conversation_scope", workspace.id);
  audit.append({
    type: "started",
    activityId: "act_scope_bash",
    turnId: first.turnId,
    conversationScopeId: "conversation_scope",
    tool: "bash",
    workspace,
    request: { workspaceId: workspace.id, command: "printf scoped" },
  });
  const outputId = outputs.begin({
    activityId: "act_scope_bash",
    turnId: first.turnId,
    conversationScopeId: "conversation_scope",
    processId: 7,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    command: "printf scoped",
    tty: false,
  });
  outputs.finish(outputId, { exitCode: 0, timedOut: false });
  audit.append({ type: "succeeded", activityId: "act_scope_bash", result: { outputId } });

  assert.equal(query.bashOutput(first.turnId, outputId).outputId, outputId);
  assert.throws(() => query.bashOutput(second.turnId, outputId), /not part of Host Turn/i);
});

test("Activity query exposes parent-child aggregates without duplicating child detail", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-query-parent-test-"));
  const turns = new HostTurnStore(stateDir, { turnId: () => "turn_parent_query" });
  let audit = new ActivityAuditStore(stateDir);
  const outputs = new BashOutputStore(stateDir);
  const query = new ActivityQueryService(turns, audit, outputs);
  let auditClosed = false;
  t.after(async () => {
    if (!auditClosed) audit.close();
    outputs.close();
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const turn = turns.begin("conversation_parent_query", workspace.id);
  audit.append({
    type: "started",
    activityId: "act_bulk_read",
    turnId: turn.turnId,
    conversationScopeId: "conversation_parent_query",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, paths: ["a.ts", "b.ts"] },
  });
  audit.append({
    type: "started",
    activityId: "act_bulk_read_a",
    parentActivityId: "act_bulk_read",
    turnId: turn.turnId,
    conversationScopeId: "conversation_parent_query",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, path: "a.ts" },
  });
  audit.append({
    type: "succeeded",
    activityId: "act_bulk_read_a",
    result: { content: [{ type: "text", text: "PARENT-CHILD-DETAIL-SENTINEL" }] },
  });
  audit.append({
    type: "started",
    activityId: "act_bulk_read_b",
    parentActivityId: "act_bulk_read",
    turnId: turn.turnId,
    conversationScopeId: "conversation_parent_query",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, path: "b.ts" },
  });
  audit.append({
    type: "failed",
    activityId: "act_bulk_read_b",
    error: "missing b.ts",
  });
  audit.append({
    type: "failed",
    activityId: "act_bulk_read",
    result: { childCount: 2, succeeded: 1, failed: 1 },
    error: "1 of 2 child Activities failed.",
  });

  const snapshot = query.snapshot(turn.turnId);
  const parent = snapshot.activities.find((activity) => activity.activityId === "act_bulk_read");
  const firstChild = snapshot.activities.find((activity) => activity.activityId === "act_bulk_read_a");
  const secondChild = snapshot.activities.find((activity) => activity.activityId === "act_bulk_read_b");
  assert.equal(parent?.target, "2 files");
  assert.equal(parent?.detailAvailable, false);
  assert.deepEqual(parent?.children, { total: 2, working: 0, done: 1, error: 1 });
  assert.equal(firstChild?.parentActivityId, "act_bulk_read");
  assert.equal(secondChild?.parentActivityId, "act_bulk_read");
  assert.doesNotMatch(JSON.stringify(snapshot), /PARENT-CHILD-DETAIL-SENTINEL/);
  assert.match(JSON.stringify(query.detail(turn.turnId, "act_bulk_read_a")), /PARENT-CHILD-DETAIL-SENTINEL/);
  assert.throws(() => query.detail(turn.turnId, "act_bulk_read"), /summary-complete/i);

  audit.close();
  auditClosed = true;
  audit = new ActivityAuditStore(stateDir);
  const restored = new ActivityQueryService(turns, audit, outputs).snapshot(turn.turnId);
  auditClosed = false;
  const restoredParent = restored.activities.find((activity) => activity.activityId === "act_bulk_read");
  assert.deepEqual(restoredParent?.children, { total: 2, working: 0, done: 1, error: 1 });
  assert.equal(
    restored.activities.find((activity) => activity.activityId === "act_bulk_read_a")?.parentActivityId,
    "act_bulk_read",
  );
});

test("explicit Workspace deletion removes Activity indexes and segmented history", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-delete-test-"));
  const turns = new HostTurnStore(stateDir, { turnId: () => "turn_delete" });
  const audit = new ActivityAuditStore(stateDir);
  const outputs = new BashOutputStore(stateDir, { outputId: () => "out_delete" });
  const query = new ActivityQueryService(turns, audit, outputs);
  t.after(async () => {
    outputs.close();
    audit.close();
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const workspaceId = "ws_delete";
  const root = "/tmp/forgerelay-delete";
  const turn = query.beginTurn("conversation_delete", workspaceId);
  audit.append({
    type: "started",
    activityId: "act_delete",
    turnId: turn.turnId,
    conversationScopeId: "conversation_delete",
    tool: "bash",
    workspace: { id: workspaceId, root, mode: "checkout" },
    request: { command: "printf delete-me" },
  });
  const outputId = outputs.begin({
    activityId: "act_delete",
    turnId: turn.turnId,
    processId: 71,
    workspaceId,
    workspaceRoot: root,
    command: "printf delete-me",
    tty: false,
  });
  outputs.append(outputId, "stdout", "delete-me\n");
  outputs.finish(outputId, { exitCode: 0, timedOut: false });
  audit.append({ type: "succeeded", activityId: "act_delete", result: { outputId } });

  const activityDir = join(stateDir, "workspaces", workspaceId, "activity");
  assert.equal((await stat(activityDir)).isDirectory(), true);
  query.deleteWorkspaceHistory(stateDir, workspaceId);

  assert.equal(audit.getActivity("act_delete"), undefined);
  assert.equal(outputs.read(outputId), undefined);
  assert.equal(turns.get(turn.turnId), undefined);
  await assert.rejects(stat(activityDir), /ENOENT/);
});
