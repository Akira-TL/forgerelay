import assert from "node:assert/strict";
import test from "node:test";
import {
  FORGERELAY_CONVERSATION_META_KEY,
  forgeRelayConversationScopeId,
  hostContextDeliveryScopeId,
  hostConversationScopeId,
  openAiConversationScopeId,
} from "./request-meta.js";

test("undefined request metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId(undefined), undefined);
  assert.equal(forgeRelayConversationScopeId(undefined), undefined);
});

test("missing or malformed session metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({}), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": 42 }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": {} }), undefined);
  assert.equal(forgeRelayConversationScopeId({ [FORGERELAY_CONVERSATION_META_KEY]: "" }), undefined);
  assert.equal(forgeRelayConversationScopeId({ [FORGERELAY_CONVERSATION_META_KEY]: 42 }), undefined);
});

test("valid OpenAI session metadata returns the raw opaque session value", () => {
  assert.equal(
    openAiConversationScopeId({ "openai/session": "chat-session-opaque-value" }),
    "chat-session-opaque-value",
  );
});

test("ForgeRelay vendor conversation metadata is explicitly namespaced", () => {
  assert.equal(
    forgeRelayConversationScopeId({ [FORGERELAY_CONVERSATION_META_KEY]: "host-conversation-1" }),
    "forgerelay-conversation:host-conversation-1",
  );
});

test("host conversation scope preserves OpenAI precedence over ForgeRelay metadata", () => {
  assert.equal(
    hostConversationScopeId({
      requestMeta: {
        "openai/session": "chat-session-opaque-value",
        [FORGERELAY_CONVERSATION_META_KEY]: "host-conversation-1",
      },
      transportSessionId: "transport-1",
      requestId: 7,
      protocolEra: "modern",
    }, "mcp-connection:1"),
    "chat-session-opaque-value",
  );
});

test("host conversation scope accepts ForgeRelay vendor metadata before transport fallback", () => {
  assert.equal(
    hostConversationScopeId({
      requestMeta: { [FORGERELAY_CONVERSATION_META_KEY]: "host-conversation-1" },
      transportSessionId: "transport-1",
      requestId: 7,
      protocolEra: "modern",
    }, "mcp-connection:1"),
    "forgerelay-conversation:host-conversation-1",
  );
});

test("modern host conversation scope is request-scoped without stable metadata", () => {
  assert.equal(
    hostConversationScopeId({
      requestId: "request-7",
      transportSessionId: "must-not-be-used",
      protocolEra: "modern",
    }, "mcp-connection:1"),
    "mcp-request:mcp-connection:1:request-7",
  );
});

test("legacy host conversation scope falls back to MCP transport session", () => {
  assert.equal(
    hostConversationScopeId({ transportSessionId: "transport-1", protocolEra: "legacy" }, "mcp-connection:1"),
    "mcp-session:transport-1",
  );
});

test("legacy host conversation scope falls back to the MCP connection scope", () => {
  assert.equal(
    hostConversationScopeId({ protocolEra: "legacy" }, "mcp-connection:1"),
    "mcp-connection:1",
  );
});

test("legacy context delivery stays unbound without stable conversation metadata", () => {
  assert.equal(
    hostContextDeliveryScopeId({ protocolEra: "legacy" }, "mcp-connection:1"),
    undefined,
  );
});

test("modern context delivery uses request scope without stable metadata", () => {
  assert.equal(
    hostContextDeliveryScopeId({ protocolEra: "modern", requestId: 9 }, "mcp-connection:1"),
    "mcp-request:mcp-connection:1:9",
  );
});

test("context delivery accepts ForgeRelay vendor metadata in either era", () => {
  assert.equal(
    hostContextDeliveryScopeId({
      protocolEra: "legacy",
      requestMeta: { [FORGERELAY_CONVERSATION_META_KEY]: "host-conversation-1" },
    }, "mcp-connection:1"),
    "forgerelay-conversation:host-conversation-1",
  );
});
