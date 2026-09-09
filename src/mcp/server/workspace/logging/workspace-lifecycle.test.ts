import assert from "node:assert/strict";
import test from "node:test";
import { callOpen, fixture, structuredContent } from "../../../../runtime/testing/server-fixture.js";

test("Workspace lifecycle operations emit attributable tool-call logs", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_LOG_FORMAT: "json", FORGERELAY_LOG_TOOL_CALLS: "1" },
  });
  const ordinary = await callOpen(context.client, context.project, "chat-lifecycle-logging");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "logging-composite", context: "none" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);

  const added = await captureToolCallEvents(() => context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Source", workspaceId: ordinaryId },
    },
  }));
  assert.deepEqual(toolEventProjection(added.events), [{
    tool: "open_workspace",
    workspaceId: compositeId,
    action: "member.add",
    path: "code",
    success: true,
  }]);

  const updated = await captureToolCallEvents(() => context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "update",
      member: { name: "code", newName: "source" },
    },
  }));
  assert.deepEqual(toolEventProjection(updated.events), [{
    tool: "open_workspace",
    workspaceId: compositeId,
    action: "member.update",
    path: "code -> source",
    success: true,
  }]);

  const removed = await captureToolCallEvents(() => context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "remove",
      member: { name: "source" },
    },
  }));
  assert.deepEqual(toolEventProjection(removed.events), [{
    tool: "open_workspace",
    workspaceId: compositeId,
    action: "member.remove",
    path: "source",
    success: true,
  }]);

  const compositeClosed = await captureToolCallEvents(() => context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "close" },
  }));
  assert.deepEqual(toolEventProjection(compositeClosed.events), [{
    tool: "close_workspace",
    workspaceId: compositeId,
    action: "close",
    path: "logging-composite",
    success: true,
  }]);

  await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  const compositeDeleted = await captureToolCallEvents(() => context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  }));
  assert.deepEqual(toolEventProjection(compositeDeleted.events), [{
    tool: "close_workspace",
    workspaceId: compositeId,
    action: "delete",
    path: "logging-composite",
    success: true,
  }]);

  const checkoutClosed = await captureToolCallEvents(() => context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: ordinaryId, action: "close" },
  }));
  assert.deepEqual(toolEventProjection(checkoutClosed.events), [{
    tool: "close_workspace",
    workspaceId: ordinaryId,
    action: "close",
    path: context.project,
    success: true,
  }]);

  await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: ordinaryId, context: "none" },
  });
  const checkoutDeleted = await captureToolCallEvents(() => context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: ordinaryId, action: "delete" },
  }));
  assert.deepEqual(toolEventProjection(checkoutDeleted.events), [{
    tool: "close_workspace",
    workspaceId: ordinaryId,
    action: "delete",
    path: context.project,
    success: true,
  }]);
});

async function captureToolCallEvents<T>(operation: () => Promise<T>): Promise<{
  result: T;
  events: Array<Record<string, unknown>>;
}> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  try {
    const result = await operation();
    const events = lines.flatMap((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value.event === "tool_call" ? [value] : [];
      } catch {
        return [];
      }
    });
    return { result, events };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function toolEventProjection(events: Array<Record<string, unknown>>) {
  return events.map((event) => ({
    tool: event.tool,
    workspaceId: event.workspaceId,
    action: event.action,
    path: event.path,
    success: event.success,
  }));
}
