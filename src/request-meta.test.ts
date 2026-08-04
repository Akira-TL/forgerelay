import assert from "node:assert/strict";
import { openAiConversationScopeId } from "./request-meta.js";

assert.equal(openAiConversationScopeId(undefined), undefined);
assert.equal(openAiConversationScopeId({}), undefined);
assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
assert.equal(openAiConversationScopeId({ "openai/session": "chat-1" }), "chat-1");

assert.equal(
  openAiConversationScopeId({
    "openai/session": "chat-1",
    "openai/subject": "user-1",
    "openai/organization": "org-1",
  }),
  "chat-1",
);
