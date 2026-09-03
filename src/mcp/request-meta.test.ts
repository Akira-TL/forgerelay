import assert from "node:assert/strict";
import test from "node:test";
import { hostConversationScopeId, openAiConversationScopeId } from "./request-meta.js";

test("undefined request metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId(undefined), undefined);
});

test("missing session metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({}), undefined);
});

test("an empty session string has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
});

test("a non-string session value has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": 42 }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": {} }), undefined);
});

test("valid OpenAI session metadata returns the raw opaque session value", () => {
  assert.equal(
    openAiConversationScopeId({ "openai/session": "chat-session-opaque-value" }),
    "chat-session-opaque-value",
  );
});

test("unrelated metadata fields do not alter the selected conversation scope", () => {
  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    "chat-session-opaque-value",
  );
});


test("host conversation scope prefers OpenAI session metadata", () => {
  assert.equal(
    hostConversationScopeId(
      { "openai/session": "chat-session-opaque-value" },
      "transport-1",
      "mcp-connection:1",
    ),
    "chat-session-opaque-value",
  );
});

test("host conversation scope falls back to MCP transport session", () => {
  assert.equal(
    hostConversationScopeId(undefined, "transport-1", "mcp-connection:1"),
    "mcp-session:transport-1",
  );
});

test("host conversation scope falls back to the MCP connection scope", () => {
  assert.equal(
    hostConversationScopeId(undefined, undefined, "mcp-connection:1"),
    "mcp-connection:1",
  );
});
