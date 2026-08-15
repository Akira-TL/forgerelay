import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

  const turn = turns.begin("conversation_query");
  assert.equal(turn.turnId, "turn_query_1");
  assert.equal(turns.current("conversation_query")?.turnId, turn.turnId);

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
  assert.equal(restoredQuery.snapshot(turn.turnId).activities.length, 7);
  assert.match(JSON.stringify(restoredQuery.detail(turn.turnId, "act_edit")), /EDIT-PATCH-SENTINEL/);
  assert.equal(restoredQuery.bashOutput(turn.turnId, outputId).output, HEAVY.bashOutput);
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

  const first = turns.begin("conversation_scope");
  const second = turns.begin("conversation_scope");
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
