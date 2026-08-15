import assert from "node:assert/strict";
import test from "node:test";
import {
  createCoreOperationExecutor,
  type CoreOperationContext,
} from "./core-operation-executor.js";

test("CoreOperationExecutor delegates each explicit operation without changing input or context", async () => {
  const calls: Array<{ name: string; input: unknown; context: CoreOperationContext }> = [];
  const result = (name: string) => ({ name });
  const handlers = {
    read: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "read", input, context });
      return result("read");
    },
    write: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "write", input, context });
      return result("write");
    },
    edit: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "edit", input, context });
      return result("edit");
    },
    rename: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "rename", input, context });
      return result("rename");
    },
    delete: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "delete", input, context });
      return result("delete");
    },
    shellRun: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "shellRun", input, context });
      return result("shellRun");
    },
    capabilityRun: async (input: unknown, context: CoreOperationContext) => {
      calls.push({ name: "capabilityRun", input, context });
      return result("capabilityRun");
    },
  };
  const executor = createCoreOperationExecutor(handlers);
  const controller = new AbortController();
  const context = {
    requestMeta: { host: "test" },
    signal: controller.signal,
    sessionId: "session-test",
  };

  assert.deepEqual(await executor.read({ workspaceId: "ws", path: "a.ts" }, context), result("read"));
  assert.deepEqual(await executor.write({ workspaceId: "ws", path: "a.ts", content: "x" }, context), result("write"));
  assert.deepEqual(await executor.edit({
    workspaceId: "ws",
    path: "a.ts",
    edits: [{ oldText: "x", newText: "y" }],
  }, context), result("edit"));
  assert.deepEqual(await executor.rename({ workspaceId: "ws", path: "a.ts", newPath: "b.ts" }, context), result("rename"));
  assert.deepEqual(await executor.delete({ workspaceId: "ws", path: "b.ts" }, context), result("delete"));
  assert.deepEqual(await executor.shellRun({
    workspaceId: "ws",
    command: "printf ok",
    surface: "bash",
  }, context), result("shellRun"));
  assert.deepEqual(await executor.capabilityRun({
    workspaceId: "ws",
    name: "hooks.check",
    arguments: {},
  }, context), result("capabilityRun"));

  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.context === context));
  assert.deepEqual(calls.map((call) => call.name), [
    "read",
    "write",
    "edit",
    "rename",
    "delete",
    "shellRun",
    "capabilityRun",
  ]);
});
