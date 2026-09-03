import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ProcessManager } from "./process-sessions.js";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
  waitForCompletedProcess,
  waitForToolText,
} from "../../runtime/testing/server-fixture.js";

test("bash returns only the last 10 output lines and retrieves complete durable output by outputId", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-output");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const expectedLines = Array.from({ length: 15 }, (_, index) => `audit-line-${String(index + 1).padStart(2, "0")}`);
  const expected = `${expectedLines.join("\n")}\n`;
  const encoded = Buffer.from(expected, "utf8").toString("base64");

  const run = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: `node -e "process.stdout.write(Buffer.from('${encoded}', 'base64'))"`,
      yieldTimeMs: 10_000,
    },
    _meta: { "openai/session": "chat-bash-output" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(run.isError, undefined);
  const runText = allResponseText(run);
  assert.doesNotMatch(runText, /audit-line-01/);
  assert.doesNotMatch(runText, /audit-line-05/);
  assert.match(runText, /audit-line-06/);
  assert.match(runText, /audit-line-15/);
  assert.match(runText, /Full output ID: out_/);
  const outputId = structuredContent(run).outputId;
  assert.equal(typeof outputId, "string");
  assert.equal(structuredContent(run).outputTruncated, true);

  const full = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "output", outputId },
    _meta: { "openai/session": "chat-bash-output" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(full.isError, undefined);
  const fullText = allResponseText(full);
  assert.match(fullText, /audit-line-01/);
  assert.match(fullText, /audit-line-15/);
  assert.equal(structuredContent(full).outputId, outputId);
  assert.equal(structuredContent(full).outputTruncated, false);
});

test("bash separates feedback yield from the total execution timeout", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-shell-yield-timeout");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const startedAt = performance.now();
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "console.log('started'); setInterval(() => {}, 1_000)"`,
      yieldTimeMs: 0,
      timeoutMs: 100,
    },
  });

  assert.equal(shell.isError, undefined, allResponseText(shell));
  assert.equal(structuredContent(shell).running, true);
  assert.equal(typeof structuredContent(shell).processId, "number");
  assert.ok(performance.now() - startedAt < 500, "yieldTimeMs=0 should return a processId promptly");
  const processId = Number(structuredContent(shell).processId);

  await new Promise((resolve) => setTimeout(resolve, 180));
  const completed = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 1_000 },
  });
  assert.equal(structuredContent(completed).running, false);
  assert.equal(structuredContent(completed).timedOut, true);
  assert.match(allResponseText(completed), /timed out/i);
});

test("Host cancellation during a blocking BeforeTool Hook prevents the original bash command", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-hook-cancel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "blocking-hook.mjs");
  const operationScript = join(context.project, "cancelled-operation.mjs");
  const operationMarker = join(context.project, "cancelled-operation-ran.txt");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    operationScript,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(operationMarker)}, "ran");\n`,
  );
  await writeFile(
    join(hookDir, "blocking-cancel.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "cancelled-operation\\.mjs" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "bash",
      arguments: {
        workspaceId,
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(operationScript)}`,
        yieldTimeMs: 0,
      },
    },
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(() => readFile(operationMarker, "utf8"), /ENOENT/);
});

test("Host cancellation before processId delivery discards a process created before an AfterTool Hook", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-shell-after-hook-cancel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "after-tool-delay.mjs");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    join(hookDir, "after-tool-delay.json"),
    JSON.stringify({
      event: "AfterTool",
      matcher: { tool: "bash" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "bash",
      arguments: {
        workspaceId,
        command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1_000)"`,
        yieldTimeMs: 0,
      },
    },
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(context.processSessions.stats(), { total: 0, running: 0, completed: 0 });
  const activity = context.auditStore.getActivity("act_test_1");
  assert.equal(activity?.tool, "bash");
  assert.equal(activity?.state, "failed");
  assert.notEqual(activity?.state, "returned");
});

test("final Bash process poll creates one Bash result Activity without mutating the returned run", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-result-poll");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const firstPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-poll" },
  } as Parameters<Client["callTool"]>[0]);
  const firstTurnId = String(structuredContent(firstPanel).turnId);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('polled-result'), 120)"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(shell).running, true);
  const processId = Number(structuredContent(shell).processId);
  const outputId = String(structuredContent(shell).outputId);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");

  const stillRunning = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 0 },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(stillRunning).running, true);
  assert.equal(context.auditStore.getActivity("act_test_2"), undefined);

  const secondPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-poll" },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(structuredContent(secondPanel).turnId);

  const completed = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(completed).running, false);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  const resultActivity = context.auditStore.getActivity("act_test_2");
  assert.equal(resultActivity?.tool, "bash_result");
  assert.equal(resultActivity?.state, "done");
  assert.equal(resultActivity?.conversationScopeId, "chat-bash-result-poll");
  assert.equal(context.auditStore.getActivity("act_test_1")?.turnId, firstTurnId);
  assert.equal(resultActivity?.turnId, secondTurnId);
  assert.deepEqual(resultActivity?.result, {
    processId,
    outputId,
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(context.bashOutputStore.claimCompletion(outputId), undefined);
});

test("attached background completion creates one Bash result Activity on a later workspace tool", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-result-attached");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const firstPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  const firstTurnId = String(structuredContent(firstPanel).turnId);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('attached-result'), 50)"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-bash-result-attached" },
  });
  assert.equal(structuredContent(shell).running, true);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  const completionDeadline = performance.now() + 5_000;
  while (context.processSessions.stats().completed === 0 && performance.now() < completionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(context.processSessions.stats().completed, 1);
  const secondPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(structuredContent(secondPanel).turnId);

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  assert.equal(context.auditStore.getActivity("act_test_2")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_3")?.tool, "bash_result");
  assert.equal(context.auditStore.getActivity("act_test_3")?.state, "done");
  assert.equal(context.auditStore.getActivity("act_test_1")?.turnId, firstTurnId);
  assert.equal(context.auditStore.getActivity("act_test_2")?.turnId, secondTurnId);
  assert.equal(context.auditStore.getActivity("act_test_3")?.turnId, secondTurnId);

  const again = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(allResponseText(again), /Background process/);
  assert.equal(context.auditStore.getActivity("act_test_4")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_5"), undefined);
});

test("bash returns a processId instead of killing a command after the foreground wait", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-background");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('background-done'), 100)"`,
    },
  });

  assert.equal(shell.isError, undefined, allResponseText(shell));
  assert.equal(structuredContent(shell).running, true);
  assert.equal(typeof structuredContent(shell).processId, "number");
  assert.equal(structuredContent(shell).sessionId, structuredContent(shell).processId);
  assert.match(allResponseText(shell), /Process running with process ID/);

  const read = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "AGENTS.md" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(read), /background-done/);

  const readAgain = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.doesNotMatch(allResponseText(readAgain), /Background process/);
});

test("completed background results remain deliverable after the full-output retention window", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 1,
    completedProcessTtlMs: 50,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-retained-completion");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('retained-completion'), 20)"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(structuredContent(shell).running, true);

  await waitForCompletedProcess(processSessions);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(read), /retained-completion/);
});

test("a failed workspace tool call still carries a completed background process notice", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-error-notice");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('notice-on-error'), 300)"`,
    },
  });
  assert.equal(structuredContent(shell).running, true);

  const failedRead = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "missing-background-notice.txt" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.equal(failedRead.isError, true);
  assert.match(allResponseText(failedRead), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(failedRead), /notice-on-error/);
});

test("close_workspace delivers a completed background result instead of blocking on it", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 1 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-close-completed");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('close-completed'), 20)"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(structuredContent(shell).running, true);
  await waitForCompletedProcess(processSessions);
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.match(allResponseText(closed), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(closed), /close-completed/);
  const closedMeta = closed._meta as {
    tool?: string;
    card?: { workspaceId?: string; mode?: string; payload?: unknown };
  } | undefined;
  assert.equal(closedMeta?.tool, "close_workspace");
  assert.equal(closedMeta?.card?.workspaceId, workspaceId);
  assert.equal(closedMeta?.card?.mode, "checkout");
  assert.ok(closedMeta?.card?.payload);
});

test("close_workspace refuses a logical workspace with a running process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-close-guard");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('close-guard-done'), 80)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const blockedClose = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(blockedClose.isError, true);
  assert.match(allResponseText(blockedClose), /still owns a running process/);

  await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined);
});

test("bash action=process can explicitly keep waiting for a running process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-poll");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('polled-done'), 500)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const otherProject = join(dirname(context.project), "other-process-project");
  await mkdir(otherProject, { recursive: true });
  const secondWorkspace = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: otherProject },
  });
  const secondWorkspaceId = String(structuredContent(secondWorkspace).workspaceId);
  assert.notEqual(secondWorkspaceId, workspaceId);
  const crossWorkspace = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: secondWorkspaceId,
      action: "process",
      processId,
      yieldTimeMs: 0,
    },
  });
  assert.equal(crossWorkspace.isError, true);
  assert.match(allResponseText(crossWorkspace), /does not belong to workspace/);

  const polled = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  assert.equal(structuredContent(polled).running, false);
  assert.equal(structuredContent(polled).exitCode, 0);
  assert.match(allResponseText(polled), /polled-done/);

  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "write_stdin"), false);
});

test("codex exec_command is a top-level Activity while write_stdin remains process control", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "chat-codex-activity");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const started = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "node -e \"console.log('codex-durable-output'); setTimeout(() => {}, 150)\"",
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(started.isError, undefined);
  assert.equal(structuredContent(started).running, true);
  const processId = structuredContent(started).processId;
  const outputId = structuredContent(started).outputId;
  assert.equal(typeof processId, "number");
  assert.equal(typeof outputId, "string");
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "exec_command");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");

  const polled = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(polled.isError, undefined);

  const fullOutput = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, outputId },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(fullOutput.isError, undefined);
  assert.match(allResponseText(fullOutput), /codex-durable-output/);
  assert.equal(structuredContent(fullOutput).outputId, outputId);

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(read.isError, undefined);
  assert.equal(context.auditStore.getActivity("act_test_2")?.tool, "bash_result");
  assert.equal(context.auditStore.getActivity("act_test_3")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_4"), undefined);
});
