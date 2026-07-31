import assert from "node:assert/strict";
import { openAiConversationScopeHash } from "./request-meta.js";

assert.equal(openAiConversationScopeHash(undefined), undefined);
assert.equal(openAiConversationScopeHash({}), undefined);
assert.equal(openAiConversationScopeHash({ "openai/session": "" }), undefined);

const sessionOnly = openAiConversationScopeHash({ "openai/session": "chat-1" });
assert.match(sessionOnly ?? "", /^[a-f0-9]{64}$/);
assert.equal(
  sessionOnly,
  openAiConversationScopeHash({ "openai/session": "chat-1" }),
);
assert.notEqual(
  sessionOnly,
  openAiConversationScopeHash({ "openai/session": "chat-2" }),
);

assert.equal(
  sessionOnly,
  openAiConversationScopeHash({
    "openai/session": "chat-1",
    "openai/subject": "user-1",
    "openai/organization": "org-1",
  }),
);
