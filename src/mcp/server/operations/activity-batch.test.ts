import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import { buildCapabilityFingerprint } from "../core/capabilities.js";
import { loadConfig } from "../../../runtime/config/config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../runtime/state/db/client.js";
import type { IncomingArtifactAdapter } from "../../artifacts/incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { ProcessManager } from "../../process/process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../../workspaces/relay/auth/remote-auth.js";
import { createMcpServer, createServer } from "../../../server.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  responseCard,
  responseText,
  structuredContent,
  waitForCompletedProcess,
  waitForToolText,
} from "../../../runtime/testing/server-fixture.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const canonicalToolNames = [
  "open_workspace",
  "activity_panel",
  "activity_snapshot",
  "activity_index",
  "activity_detail",
  "activity_output",
  "workspace_instruction",
  "capability",
  "close_workspace",
  "read",
  "write",
  "edit",
  "rename",
  "delete",
  "bash",
] as const;

test("Activity Panel exposes the default-expanded preference only through app result metadata", async (t) => {
  const collapsed = await fixture(t);
  const collapsedOpened = await callOpen(collapsed.client, collapsed.project, "chat-activity-panel-collapsed");
  const collapsedWorkspaceId = String(structuredContent(collapsedOpened).workspaceId);
  const collapsedPanel = await collapsed.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: collapsedWorkspaceId },
  });
  assert.equal(
    (collapsedPanel._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelDefaultExpanded"],
    false,
  );

  const expanded = await fixture(t, {
    env: { FORGERELAY_ACTIVITY_PANEL_EXPANDED: "1" },
  });
  const expandedOpened = await callOpen(expanded.client, expanded.project, "chat-activity-panel-expanded");
  const expandedWorkspaceId = String(structuredContent(expandedOpened).workspaceId);
  const expandedPanel = await expanded.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: expandedWorkspaceId },
  });
  assert.equal(
    (expandedPanel._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelDefaultExpanded"],
    true,
  );
  assert.equal(structuredContent(expandedPanel).turnId, "turn_host_test_1");
  assert.equal(structuredContent(expandedPanel).activityPanelDefaultExpanded, undefined);
});

test("Activity Panel establishes one durable Host Turn with state-only polling and lazy index, detail, and Bash output queries", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-activity-query-contract";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);
  assert.equal(turnId, "turn_host_test_1");
  assert.equal(structuredContent(panel).state, "working");
  assert.equal(structuredContent(panel).revision, 0);

  await writeFile(join(context.project, "query-secret.txt"), "READ-QUERY-SECRET\n");
  const read = await call("read", { workspaceId, path: "query-secret.txt" });
  assert.equal(read.isError, undefined);
  const written = await call("write", {
    workspaceId,
    path: "query-write.txt",
    content: "WRITE-QUERY-SECRET\n",
  });
  assert.equal(written.isError, undefined);
  const renamed = await call("rename", {
    workspaceId,
    path: "query-write.txt",
    newPath: "query-renamed.txt",
  });
  assert.equal(renamed.isError, undefined);
  const bash = await call("bash", {
    workspaceId,
    action: "run",
    command: "node -e \"console.log('BASH-QUERY-OUTPUT-SECRET')\"",
    yieldTimeMs: 10_000,
  });
  assert.equal(bash.isError, undefined);
  const outputId = String(structuredContent(bash).outputId);

  const snapshot = await call("activity_snapshot", { turnId });
  assert.equal(snapshot.isError, undefined);
  const snapshotStructured = structuredContent(snapshot);
  assert.equal(snapshotStructured.changed, true);
  assert.equal(snapshotStructured.state, "done");
  assert.equal(snapshotStructured.activities, undefined);
  assert.deepEqual(snapshot.content, []);

  const index = await call("activity_index", { turnId });
  assert.equal(index.isError, undefined);
  const indexStructured = structuredContent(index);
  assert.deepEqual(index.content, []);
  const activities = indexStructured.activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 4);
  assert.deepEqual(activities.map((activity) => activity.activityId), [
    "act_test_1",
    "act_test_2",
    "act_test_3",
    "act_test_4",
  ]);
  assert.ok(activities.every((activity) => context.auditStore.getActivity(String(activity.activityId))?.turnId === turnId));
  assert.equal(activities.find((activity) => activity.activityId === "act_test_3")?.target, "query-write.txt → query-renamed.txt");
  assert.equal(activities.find((activity) => activity.activityId === "act_test_3")?.detailAvailable, false);
  assert.equal(activities.find((activity) => activity.activityId === "act_test_4")?.outputId, outputId);
  const serializedSnapshot = JSON.stringify(indexStructured);
  assert.doesNotMatch(serializedSnapshot, /READ-QUERY-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /WRITE-QUERY-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /BASH-QUERY-OUTPUT-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /console\.log/);

  const readDetail = await call("activity_detail", { turnId, activityId: "act_test_1" });
  assert.equal(readDetail.isError, undefined);
  assert.match(JSON.stringify(structuredContent(readDetail)), /READ-QUERY-SECRET/);

  const renameDetail = await call("activity_detail", { turnId, activityId: "act_test_3" });
  assert.equal(renameDetail.isError, true);
  assert.match(allResponseText(renameDetail), /summary-complete/i);

  const fullOutput = await call("activity_output", { turnId, outputId });
  assert.equal(fullOutput.isError, undefined);
  assert.match(String(structuredContent(fullOutput).command), /console\.log/);
  assert.match(String(structuredContent(fullOutput).output), /BASH-QUERY-OUTPUT-SECRET/);
  const outputCursor = Number(structuredContent(fullOutput).cursor);
  assert.ok(Number.isInteger(outputCursor) && outputCursor >= 0);

  context.bashOutputStore.append(outputId, "stdout", "BASH-QUERY-OUTPUT-DELTA\n");
  const deltaOutput = await call("activity_output", { turnId, outputId, cursor: outputCursor });
  assert.equal(deltaOutput.isError, undefined);
  assert.equal(structuredContent(deltaOutput).output, "BASH-QUERY-OUTPUT-DELTA\n");
  assert.ok(Number(structuredContent(deltaOutput).cursor) > outputCursor);

  const revision = Number(snapshotStructured.revision);
  const unchanged = await call("activity_snapshot", { turnId, knownRevision: revision });
  assert.equal(structuredContent(unchanged).changed, false);
  assert.equal(structuredContent(unchanged).activities, undefined);
  const unchangedIndex = await call("activity_index", { turnId, knownRevision: Number(indexStructured.revision) });
  assert.equal(structuredContent(unchangedIndex).changed, false);
  assert.deepEqual(structuredContent(unchangedIndex).activities, []);

  const secondPanel = await call("activity_panel", { workspaceId });
  const secondTurnId = String(structuredContent(secondPanel).turnId);
  assert.equal(secondTurnId, "turn_host_test_2");
  await call("read", { workspaceId, path: "AGENTS.md" });
  const secondSnapshot = await call("activity_snapshot", { turnId: secondTurnId });
  assert.equal(structuredContent(secondSnapshot).activities, undefined);
  assert.equal((structuredContent(await call("activity_index", { turnId: secondTurnId })).activities as unknown[]).length, 1);
  assert.equal(context.auditStore.getActivity("act_test_5")?.turnId, secondTurnId);
  assert.equal((structuredContent(await call("activity_index", { turnId })).activities as unknown[]).length, 4);
});

test("batch.execute runs heterogeneous core tasks with one parent Activity and ordered child results", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "read" },
        handlers: [{
          name: "Batch child read hook",
          command: "node -e \"require('node:fs').appendFileSync('batch-hook-count.txt', '1\\n')\"",
          report: true,
        }],
      }],
    },
  });
  const conversation = "chat-batch-core";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  await writeFile(join(context.project, "batch-read.txt"), "BATCH-READ-SENTINEL\n");
  await writeFile(join(context.project, "batch-edit.txt"), "before edit-target after\n");
  await writeFile(join(context.project, "batch-rename-before.txt"), "rename me\n");
  await writeFile(join(context.project, "batch-delete.txt"), "delete me\n");
  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 4,
      tasks: [
        { id: "read", operation: "read", path: "batch-read.txt" },
        { id: "write", operation: "write", path: "batch-written.txt", content: "BATCH-WRITE-SENTINEL\n" },
        {
          id: "edit",
          operation: "edit",
          path: "batch-edit.txt",
          edits: [{ oldText: "edit-target", newText: "edited" }],
        },
        { id: "rename", operation: "rename", path: "batch-rename-before.txt", newPath: "batch-rename-after.txt" },
        { id: "delete", operation: "delete", path: "batch-delete.txt" },
        { id: "missing", operation: "read", path: "batch-missing.txt" },
        { id: "bash", operation: "bash.run", command: "node -e \"console.log('BATCH-BASH-SENTINEL')\"" },
      ],
    },
  });
  assert.equal(batch.isError, undefined);
  const batchValue = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(batchValue.status, "partial");
  assert.equal(batchValue.tasks, 7);
  assert.equal(batchValue.completed, 6);
  assert.equal(batchValue.failed, 1);
  const results = batchValue.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((entry) => [entry.id, entry.operation, entry.status]), [
    ["read", "read", "done"],
    ["write", "write", "done"],
    ["edit", "edit", "done"],
    ["rename", "rename", "done"],
    ["delete", "delete", "done"],
    ["missing", "read", "error"],
    ["bash", "bash.run", "done"],
  ]);
  assert.match(JSON.stringify(results[0]), /BATCH-READ-SENTINEL/);
  assert.match(JSON.stringify(results[5]), /ENOENT|no such file/i);
  assert.match(JSON.stringify(results[6]), /BATCH-BASH-SENTINEL/);
  const bashChildResult = results[6]?.result as Record<string, unknown>;
  const bashStructured = bashChildResult.structuredContent as Record<string, unknown>;
  assert.equal(typeof bashStructured.outputId, "string");
  assert.equal(bashStructured.running, false);
  assert.equal(
    (await readFile(join(context.project, "batch-hook-count.txt"), "utf8")).trim().split("\n").length,
    2,
  );

  assert.equal(await readFile(join(context.project, "batch-written.txt"), "utf8"), "BATCH-WRITE-SENTINEL\n");
  assert.equal(await readFile(join(context.project, "batch-edit.txt"), "utf8"), "before edited after\n");
  assert.equal(await readFile(join(context.project, "batch-rename-after.txt"), "utf8"), "rename me\n");
  await assert.rejects(readFile(join(context.project, "batch-rename-before.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "batch-delete.txt"), "utf8"), /ENOENT/);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  const activities = snapshot.activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 8);
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.equal(parent?.title, "Batch");
  assert.equal(parent?.target, "7 tasks");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.detailAvailable, false);
  assert.deepEqual(parent?.children, { total: 7, working: 0, done: 6, error: 1 });
  const children = activities.filter((activity) => activity.parentActivityId === parent?.activityId);
  assert.equal(children.length, 7);
  assert.deepEqual(children.map((activity) => activity.tool).sort(), [
    "bash", "delete", "edit", "read", "read", "rename", "write",
  ]);
  const parentAudit = context.auditStore.getActivity(String(parent?.activityId));
  assert.doesNotMatch(
    JSON.stringify(parentAudit),
    /BATCH-READ-SENTINEL|BATCH-WRITE-SENTINEL|BATCH-BASH-SENTINEL|edit-target/,
  );
  assert.deepEqual(parentAudit?.result, { childCount: 7, completed: 6, failed: 1 });
});

test("batch.execute runs Capability children through declared batch policy and audits unsupported children", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-capability";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  await writeFile(join(context.project, "batch-capability-read.txt"), "BATCH-CAPABILITY-READ\n");
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 3,
      tasks: [
        { id: "hooks", operation: "capability.run", name: "hooks.check", arguments: {} },
        { id: "unsupported", operation: "capability.run", name: "batch.execute", arguments: { tasks: [] } },
        { id: "read", operation: "read", path: "batch-capability-read.txt" },
      ],
    },
  });
  assert.equal(batch.isError, undefined);
  const value = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(value.status, "partial");
  assert.equal(value.completed, 2);
  assert.equal(value.failed, 1);
  const results = value.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((entry) => [entry.id, entry.operation, entry.status]), [
    ["hooks", "capability.run", "done"],
    ["unsupported", "capability.run", "error"],
    ["read", "read", "done"],
  ]);
  assert.match(JSON.stringify(results[0]), /globalHooks|projectHooks/);
  assert.match(JSON.stringify(results[1]), /capability_batch_unsupported|not supported inside batch\.execute/);
  assert.match(JSON.stringify(results[2]), /BATCH-CAPABILITY-READ/);

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 2, error: 1 });
  const children = activities.filter((activity) => activity.parentActivityId === parent?.activityId);
  assert.deepEqual(children.map((activity) => [activity.tool, activity.status]).sort(), [
    ["capability", "done"],
    ["capability", "error"],
    ["read", "done"],
  ]);
});

test("Host cancellation stops queued batch tasks and creates no fake child Activities", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-cancel";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const turn = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(turn).turnId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "batch-cancel-hook.mjs");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    join(hookDir, "batch-cancel.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "batch-cancel-first" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "capability",
      arguments: {
        workspaceId,
        name: "batch.execute",
        action: "run",
        arguments: {
          concurrency: 1,
          tasks: [
            { id: "first", operation: "bash.run", command: "echo batch-cancel-first" },
            { id: "queued-a", operation: "write", path: "batch-cancel-a.txt", content: "should-not-run\n" },
            { id: "queued-b", operation: "write", path: "batch-cancel-b.txt", content: "should-not-run\n" },
          ],
        },
      },
      _meta: { "openai/session": conversation },
    } as Parameters<Client["callTool"]>[0],
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(readFile(join(context.project, "batch-cancel-a.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "batch-cancel-b.txt"), "utf8"), /ENOENT/);

  const snapshot = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  const activities = structuredContent(snapshot).activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 2);
  const parent = activities.find((activity) => activity.tool === "batch");
  const child = activities.find((activity) => activity.parentActivityId === parent?.activityId);
  assert.equal(parent?.status, "error");
  assert.equal(child?.tool, "bash");
  assert.equal(child?.status, "error");
});

test("batch.execute accepts 100 tasks and persists 100 child Activities", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-hundred";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 10,
      tasks: Array.from({ length: 100 }, (_, index) => ({
        id: `hooks-${index}`,
        operation: "capability.run",
        name: "hooks.check",
        arguments: {},
      })),
    },
  });
  assert.equal(batch.isError, undefined);
  const value = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(value.status, "done");
  assert.equal(value.tasks, 100);
  assert.equal(value.completed, 100);
  assert.equal(value.failed, 0);
  const results = value.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 100);
  assert.deepEqual(results.map((entry) => entry.id), Array.from({ length: 100 }, (_, index) => `hooks-${index}`));

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.equal(activities.length, 101);
  assert.deepEqual(parent?.children, { total: 100, working: 0, done: 100, error: 0 });
});

test("batch.execute rejects more than 100 tasks before creating a Batch Activity", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-limit";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const rejected = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: Array.from({ length: 101 }, (_, index) => ({
        id: `task-${index}`,
        operation: "read",
        path: `file-${index}.txt`,
      })),
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(allResponseText(rejected), /invalid_arguments|100|too big/i);

  const nested = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: [{ id: "nested", operation: "batch.execute", tasks: [] }],
    },
  });
  assert.equal(nested.isError, true);
  assert.match(allResponseText(nested), /invalid_arguments|operation/i);

  const processControl = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: [{ id: "process", operation: "bash.run", command: "echo no", processId: 1 }],
    },
  });
  assert.equal(processControl.isError, true);
  assert.match(allResponseText(processControl), /invalid_arguments|unrecognized/i);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  assert.deepEqual(snapshot.activities, []);
});

