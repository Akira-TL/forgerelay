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

  const success = await lifecycle.run({
    activityId: "act_success",
    turnId: "turn_success",
    conversationScopeId: "conversation_1",
    tool: "read",
    workspace,
    request: { workspaceId: workspace.id, path: "README.md", omitted: undefined },
    operation: async () => ({ content: [{ type: "text", text: "hello" }], extra: undefined }),
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
});
