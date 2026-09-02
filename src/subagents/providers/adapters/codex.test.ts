import assert from "node:assert/strict";
import type {
  ExternalCommandRequest,
  ExternalCommandResult,
} from "../runtime/external-command.js";
import {
  CodexSubagentAdapter,
  codexCommandArgs,
  parseCodexJsonLines,
} from "./codex.js";

const requests: ExternalCommandRequest[] = [];
const runner = async (request: ExternalCommandRequest): Promise<ExternalCommandResult> => {
  requests.push(request);
  const resumeIndex = request.args.indexOf("resume");
  const sessionId = resumeIndex >= 0 ? request.args[resumeIndex + 1] : "new-thread";
  return {
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: sessionId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: `response:${request.stdin}` },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  };
};

const adapter = new CodexSubagentAdapter(runner, {
  ...process.env,
  CODEX_COMMAND: "/custom/codex",
});
const readOnly = await adapter.run({
  prompt: "inspect only",
  workspace: "/tmp/project",
});

assert.equal(readOnly.provider, "codex");
assert.equal(readOnly.providerSessionId, "new-thread");
assert.equal(readOnly.finalResponse, "response:inspect only");
assert.equal(requests[0]?.command, "/custom/codex");
assert.equal(requests[0]?.stdin, "inspect only");
assert.deepEqual(requests[0]?.args, [
  "exec",
  "--json",
  "--sandbox",
  "read-only",
  "--cd",
  "/tmp/project",
  "--config",
  'approval_policy="never"',
]);

await adapter.run({
  prompt: "make change",
  workspace: "/tmp/project",
  writeMode: "allowed",
  model: "gpt-5.4",
  thinking: "high",
});
assert.deepEqual(requests[1]?.args, [
  "exec",
  "--json",
  "--sandbox",
  "workspace-write",
  "--cd",
  "/tmp/project",
  "--config",
  'approval_policy="never"',
  "--model",
  "gpt-5.4",
  "--config",
  'model_reasoning_effort="high"',
]);

const controller = new AbortController();
const resumed = await adapter.run({
  prompt: "continue",
  workspace: "/tmp/project",
  providerSessionId: "existing-thread",
  writeMode: "full_access",
  signal: controller.signal,
});
assert.equal(resumed.providerSessionId, "existing-thread");
assert.equal(requests[2]?.signal, controller.signal);
assert.deepEqual(requests[2]?.args, [
  "exec",
  "--json",
  "--sandbox",
  "danger-full-access",
  "--cd",
  "/tmp/project",
  "--config",
  'approval_policy="never"',
  "resume",
  "existing-thread",
]);

assert.deepEqual(
  codexCommandArgs({ prompt: "x", workspace: "C:/repo", writeMode: "read_only" }).slice(0, 6),
  ["exec", "--json", "--sandbox", "read-only", "--cd", "C:/repo"],
);

assert.deepEqual(
  parseCodexJsonLines([
    "not json",
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
  ].join("\n")),
  { providerSessionId: "thread-1", finalResponse: "final", error: undefined },
);

assert.equal(
  parseCodexJsonLines(JSON.stringify({
    type: "turn.failed",
    error: { message: "quota exceeded" },
  })).error,
  "quota exceeded",
);

const mismatched = new CodexSubagentAdapter(async () => ({
  stdout: [
    JSON.stringify({ type: "thread.started", thread_id: "replacement-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "unexpected" } }),
  ].join("\n"),
  stderr: "",
  exitCode: 0,
}));
await assert.rejects(
  mismatched.run({
    prompt: "continue",
    workspace: "/tmp/project",
    providerSessionId: "expected-thread",
  }),
  /different session id/,
);
