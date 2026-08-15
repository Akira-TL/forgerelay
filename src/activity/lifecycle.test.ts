import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookExecutionError } from "../hooks.js";
import { ActivityAuditStore } from "./audit-store.js";
import { ActivityLifecycle } from "./lifecycle.js";

const workspace = {
  id: "ws_lifecycle",
  root: "/tmp/forgerelay-lifecycle",
  mode: "checkout" as const,
  branch: "feat/activity",
};

test("Activity lifecycle records success, returned, failure, and BeforeTool blocks without changing operation behavior", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-activity-lifecycle-test-"));
  const auditStore = new ActivityAuditStore(stateDir, {
    now: () => new Date("2026-08-14T14:30:00.000Z"),
  });
  const lifecycle = new ActivityLifecycle(auditStore);

  t.after(async () => {
    auditStore.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  let receivedContext: unknown;
  const success = await lifecycle.run({
    activityId: "act_success",
    turnId: "turn_success",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, path: "README.md", omitted: undefined },
    operation: async (context) => {
      receivedContext = context;
      return { content: [{ type: "text", text: "hello" }], extra: undefined };
    },
  });
  assert.deepEqual(receivedContext, {
    activityId: "act_success",
    turnId: "turn_success",
    conversationScopeId: "conversation_1",
  });
  assert.deepEqual(success, { content: [{ type: "text", text: "hello" }], extra: undefined });
  assert.deepEqual(auditStore.getActivity("act_success"), {
    activityId: "act_success",
    turnId: "turn_success",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace,
    state: "done",
    request: { workspaceId: workspace.id, path: "README.md" },
    result: { content: [{ type: "text", text: "hello" }] },
    startedAt: "2026-08-14T14:30:00.000Z",
    updatedAt: "2026-08-14T14:30:00.000Z",
  });

  let receivedChildContext: unknown;
  await lifecycle.run({
    activityId: "act_child",
    turnId: "turn_success",
    parentActivityId: "act_success",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, path: "child.ts" },
    operation: async (context) => {
      receivedChildContext = context;
      return { ok: true };
    },
  });
  assert.deepEqual(receivedChildContext, {
    activityId: "act_child",
    turnId: "turn_success",
    parentActivityId: "act_success",
    conversationScopeId: "conversation_1",
  });
  assert.equal(auditStore.getActivity("act_child")?.parentActivityId, "act_success");

  await lifecycle.run({
    activityId: "act_returned",
    turnId: "turn_returned",
    tool: "bash",
    workspace,
    request: { action: "run", command: "sleep 30" },
    outcome: () => ({ type: "returned" }),
    operation: async () => ({ structuredContent: { running: true, processId: 41 } }),
  });
  assert.equal(auditStore.getActivity("act_returned")?.state, "returned");
  assert.deepEqual(auditStore.listEvents("act_returned").map((event) => event.type), ["started", "returned"]);

  const failedResult = { isError: true, content: [{ type: "text", text: "permission denied" }] };
  assert.equal(await lifecycle.run({
    activityId: "act_failed_result",
    turnId: "turn_failed_result",
    tool: "write",
    workspace,
    request: { path: "src/a.ts" },
    outcome: () => ({ type: "failed", error: "permission denied" }),
    operation: async () => failedResult,
  }), failedResult);
  assert.equal(auditStore.getActivity("act_failed_result")?.state, "failed");
  assert.equal(auditStore.getActivity("act_failed_result")?.error, "permission denied");

  const blocked = new HookExecutionError("BeforeTool", 0, "blocked by policy");
  await assert.rejects(
    lifecycle.run({
      activityId: "act_blocked",
      turnId: "turn_blocked",
      tool: "delete",
      workspace,
      request: { path: "important.txt" },
      operation: async () => { throw blocked; },
    }),
    (error) => error === blocked,
  );
  assert.equal(auditStore.getActivity("act_blocked")?.state, "blocked");

  const failed = new Error("filesystem failed");
  await assert.rejects(
    lifecycle.run({
      activityId: "act_thrown",
      turnId: "turn_thrown",
      tool: "edit",
      workspace,
      request: { path: "src/a.ts" },
      operation: async () => { throw failed; },
    }),
    (error) => error === failed,
  );
  assert.equal(auditStore.getActivity("act_thrown")?.state, "failed");
  assert.equal(auditStore.getActivity("act_thrown")?.error, "filesystem failed");

  const recorded = lifecycle.record({
    activityId: "act_bash_result",
    turnId: "turn_bash_result",
    conversationScopeId: "conversation_1",
    tool: "bash_result",
    workspace,
    request: { processId: 41, outputId: "out_41" },
    result: { exitCode: 0, outputId: "out_41" },
    outcome: { type: "succeeded" },
  });
  assert.deepEqual(recorded, {
    activityId: "act_bash_result",
    turnId: "turn_bash_result",
    conversationScopeId: "conversation_1",
  });
  assert.equal(auditStore.getActivity("act_bash_result")?.tool, "bash_result");
  assert.equal(auditStore.getActivity("act_bash_result")?.state, "done");
  assert.deepEqual(auditStore.getActivity("act_bash_result")?.result, {
    exitCode: 0,
    outputId: "out_41",
  });

  lifecycle.recordLinked({
    activityId: "act_bash_result_linked",
    sourceActivityId: "act_success",
    tool: "bash_result",
    request: { processId: 42, outputId: "out_42" },
    result: { exitCode: 7, outputId: "out_42" },
    outcome: { type: "failed", error: "Background process 42 exited with code 7." },
  });
  const linked = auditStore.getActivity("act_bash_result_linked");
  assert.equal(linked?.conversationScopeId, "conversation_1");
  assert.deepEqual(linked?.workspace, workspace);
  assert.equal(linked?.state, "failed");
});
