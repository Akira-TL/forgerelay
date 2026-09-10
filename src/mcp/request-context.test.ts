import assert from "node:assert/strict";
import test from "node:test";
import { mcpHandlerRequestContext } from "./request-context.js";

test("MCP handler context preserves the ForgeRelay-owned request fields", () => {
  const controller = new AbortController();
  const requestMeta = { "openai/session": "conversation-1", other: "opaque" };

  const context = mcpHandlerRequestContext({
    _meta: requestMeta,
    signal: controller.signal,
    sessionId: "transport-session-1",
    requestId: 42,
  });

  assert.equal(context.requestMeta, requestMeta);
  assert.equal(context.signal, controller.signal);
  assert.equal(context.transportSessionId, "transport-session-1");
  assert.equal(context.requestId, 42);
});

test("MCP handler context keeps optional legacy fields absent", () => {
  const controller = new AbortController();

  const context = mcpHandlerRequestContext({
    signal: controller.signal,
    requestId: "request-1",
  });

  assert.equal(context.requestMeta, undefined);
  assert.equal(context.transportSessionId, undefined);
  assert.equal(context.requestId, "request-1");
});
