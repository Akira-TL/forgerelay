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

test("read permits absolute allowed-root inspection without opening a Workspace", async (t) => {
  const context = await fixture(t);
  const inspectPath = join(context.project, "unscoped-inspect.txt");
  await writeFile(inspectPath, "UNSCOPED-READ-SENTINEL\n");

  assert.equal(context.workspaces.cachedWorkspaceCount, 0);
  const read = await context.client.callTool({
    name: "read",
    arguments: { path: inspectPath },
  });
  assert.equal(read.isError, undefined);
  assert.match(allResponseText(read), /UNSCOPED-READ-SENTINEL/);
  assert.equal(context.workspaces.cachedWorkspaceCount, 0);

  const relative = await context.client.callTool({
    name: "read",
    arguments: { path: "unscoped-inspect.txt" },
  });
  assert.equal(relative.isError, true);
  assert.match(allResponseText(relative), /absolute paths inside configured allowedRoots/i);

  const outsideRoot = await mkdtemp(join(tmpdir(), "forgerelay-unscoped-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outsidePath = join(outsideRoot, "outside.txt");
  await writeFile(outsidePath, "OUTSIDE-SENTINEL\n");
  const outside = await context.client.callTool({
    name: "read",
    arguments: { path: outsidePath },
  });
  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots|access denied|not allowed/i);
  assert.doesNotMatch(allResponseText(outside), /OUTSIDE-SENTINEL/);
  assert.equal(context.workspaces.cachedWorkspaceCount, 0);
});

test("bulk Read returns ordered per-file results and persists one parent Activity with child Reads", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "read" },
        handlers: [{
          name: "Bulk read preflight",
          command: "node -e \"process.exit(0)\"",
        }],
      }],
    },
  });
  const conversation = "chat-bulk-read";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  await writeFile(join(context.project, "bulk-a.txt"), "BULK-READ-A-SENTINEL\n");
  await writeFile(join(context.project, "bulk-b.txt"), "BULK-READ-B-SENTINEL\n");
  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);

  const read = await call("read", {
    workspaceId,
    paths: ["bulk-a.txt", "bulk-b.txt", "bulk-missing.txt"],
  });
  assert.equal(read.isError, undefined);
  const readStructured = structuredContent(read);
  const results = readStructured.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((result) => [result.path, result.status]), [
    ["bulk-a.txt", "done"],
    ["bulk-b.txt", "done"],
    ["bulk-missing.txt", "error"],
  ]);
  assert.match(String(results[0]?.result), /BULK-READ-A-SENTINEL/);
  assert.match(String(results[1]?.result), /BULK-READ-B-SENTINEL/);
  assert.match(String(results[2]?.result), /ENOENT|no such file/i);
  assert.equal(readStructured.files, 3);
  assert.equal(readStructured.failed, 1);
  assert.equal((allResponseText(read).match(/Bulk read preflight \(BeforeTool, global\) passed/g) ?? []).length, 3);

  const ambiguous = await call("read", {
    workspaceId,
    path: "bulk-a.txt",
    paths: ["bulk-b.txt"],
  });
  assert.equal(ambiguous.isError, true);
  assert.match(allResponseText(ambiguous), /exactly one of path or paths/i);
  const empty = await call("read", { workspaceId, paths: [] });
  assert.equal(empty.isError, true);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  const activities = snapshot.activities as Array<Record<string, unknown>>;
  assert.deepEqual(activities.map((activity) => activity.activityId), [
    "act_test_1",
    "act_test_2",
    "act_test_3",
    "act_test_4",
  ]);
  const parent = activities[0];
  assert.equal(parent?.target, "3 files");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.detailAvailable, false);
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 2, error: 1 });
  assert.ok(activities.slice(1).every((activity) => activity.parentActivityId === "act_test_1"));
  assert.ok(activities.every((activity) => context.auditStore.getActivity(String(activity.activityId))?.turnId === turnId));
  assert.deepEqual(context.auditStore.getActivity("act_test_1")?.result, {
    childCount: 3,
    succeeded: 2,
    failed: 1,
  });
  assert.doesNotMatch(JSON.stringify(context.auditStore.getActivity("act_test_1")), /BULK-READ-A-SENTINEL|BULK-READ-B-SENTINEL/);
  assert.doesNotMatch(JSON.stringify(snapshot), /BULK-READ-A-SENTINEL|BULK-READ-B-SENTINEL/);

  const firstDetail = await call("activity_detail", { turnId, activityId: "act_test_2" });
  assert.match(JSON.stringify(structuredContent(firstDetail)), /BULK-READ-A-SENTINEL/);
  const parentDetail = await call("activity_detail", { turnId, activityId: "act_test_1" });
  assert.equal(parentDetail.isError, true);
  assert.match(allResponseText(parentDetail), /summary-complete/i);
});

test("bulk Edit preflights every target before mutation and records child edits only after preflight", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-bulk-edit";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const paths = ["edit-a.txt", "edit-b.txt", "edit-c.txt"];
  await writeFile(join(context.project, paths[0]!), "before common after\n");
  await writeFile(join(context.project, paths[1]!), "before common after\n");
  await writeFile(join(context.project, paths[2]!), "common and common\n");

  const failedTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const preflightFailure = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(preflightFailure.isError, true);
  assert.match(allResponseText(preflightFailure), /unique|multiple|match/i);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(context.project, paths[1]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(context.project, paths[2]!), "utf8"), "common and common\n");
  const failedActivities = structuredContent(await call("activity_index", { turnId: failedTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(failedActivities.length, 1);
  assert.equal(failedActivities[0]?.target, "3 files");
  assert.equal(failedActivities[0]?.status, "error");
  assert.equal(failedActivities[0]?.detailAvailable, false);
  assert.equal(failedActivities[0]?.children, undefined);

  const duplicateTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const duplicateFailure = await call("edit", {
    workspaceId,
    paths: [paths[0], paths[0]],
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(duplicateFailure.isError, true);
  assert.match(allResponseText(duplicateFailure), /overlap|same file/i);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "before common after\n");
  const duplicateActivities = structuredContent(await call("activity_index", { turnId: duplicateTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(duplicateActivities.length, 1);

  await writeFile(join(context.project, paths[2]!), "before common after\n");
  const successTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const edited = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(edited.isError, undefined);
  const editedResult = structuredContent(edited);
  assert.equal(editedResult.status, "applied");
  assert.equal(editedResult.files, 3);
  assert.equal(editedResult.completed, 3);
  assert.equal(editedResult.unexecuted, 0);
  assert.deepEqual((editedResult.results as Array<Record<string, unknown>>).map((entry) => [entry.path, entry.status]), [
    [paths[0], "done"], [paths[1], "done"], [paths[2], "done"],
  ]);
  for (const path of paths) {
    assert.equal(await readFile(join(context.project, path), "utf8"), "before changed after\n");
  }
  const successActivities = structuredContent(await call("activity_index", { turnId: successTurn })).activities as Array<Record<string, unknown>>;
  const parent = successActivities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.target, "3 files");
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 3, error: 0 });
  assert.equal(successActivities.filter((activity) => activity.parentActivityId === parent?.activityId).length, 3);
});

test("bulk Edit stops after a mutation-phase Hook failure and reports unexecuted targets", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "edit", pathRegex: "partial-b\\.txt$" },
        handlers: [{ name: "Block second bulk edit", command: "node -e \"process.exit(13)\"" }],
      }],
    },
  });
  const conversation = "chat-bulk-edit-partial";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const paths = ["partial-a.txt", "partial-b.txt", "partial-c.txt"];
  for (const path of paths) await writeFile(join(context.project, path), "common\n");
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const edited = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(edited.isError, true);
  const result = structuredContent(edited);
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.unexecuted, 1);
  assert.deepEqual((result.results as Array<Record<string, unknown>>).map((entry) => [entry.path, entry.status]), [
    [paths[0], "done"], [paths[1], "error"], [paths[2], "unexecuted"],
  ]);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "changed\n");
  assert.equal(await readFile(join(context.project, paths[1]!), "utf8"), "common\n");
  assert.equal(await readFile(join(context.project, paths[2]!), "utf8"), "common\n");

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.status, "error");
  assert.deepEqual(parent?.children, { total: 2, working: 0, done: 1, error: 1 });
  assert.equal(activities.filter((activity) => activity.parentActivityId === parent?.activityId).length, 2);
});

test("bulk Delete preflights all targets and rejects dangerous overlaps before deleting anything", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-bulk-delete";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  await writeFile(join(context.project, "delete-a.txt"), "a\n");
  await writeFile(join(context.project, "delete-b.txt"), "b\n");
  await mkdir(join(context.project, "delete-dir"));
  await writeFile(join(context.project, "delete-dir", "child.txt"), "child\n");

  const failedTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const nonEmptyFailure = await call("delete", {
    workspaceId,
    paths: ["delete-a.txt", "delete-dir"],
    recursive: false,
  });
  assert.equal(nonEmptyFailure.isError, true);
  assert.match(allResponseText(nonEmptyFailure), /not empty|non-empty/i);
  assert.equal(await readFile(join(context.project, "delete-a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(join(context.project, "delete-dir", "child.txt"), "utf8"), "child\n");
  const failedActivities = structuredContent(await call("activity_index", { turnId: failedTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(failedActivities.length, 1);
  assert.equal(failedActivities[0]?.target, "2 paths");
  assert.equal(failedActivities[0]?.detailAvailable, false);

  const overlapTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const overlapFailure = await call("delete", {
    workspaceId,
    paths: ["delete-dir", "delete-dir/child.txt"],
    recursive: true,
  });
  assert.equal(overlapFailure.isError, true);
  assert.match(allResponseText(overlapFailure), /overlap|ancestor|descendant/i);
  assert.equal(await readFile(join(context.project, "delete-dir", "child.txt"), "utf8"), "child\n");
  const overlapActivities = structuredContent(await call("activity_index", { turnId: overlapTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(overlapActivities.length, 1);

  const successTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const deleted = await call("delete", {
    workspaceId,
    paths: ["delete-a.txt", "delete-b.txt"],
  });
  assert.equal(deleted.isError, undefined);
  const deletedResult = structuredContent(deleted);
  assert.equal(deletedResult.status, "deleted");
  assert.equal(deletedResult.completed, 2);
  assert.equal(deletedResult.unexecuted, 0);
  await assert.rejects(readFile(join(context.project, "delete-a.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "delete-b.txt"), "utf8"), /ENOENT/);
  const successActivities = structuredContent(await call("activity_index", { turnId: successTurn })).activities as Array<Record<string, unknown>>;
  const parent = successActivities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.target, "2 paths");
  assert.deepEqual(parent?.children, { total: 2, working: 0, done: 2, error: 0 });
});

test("write can create a file in the OS temp directory without opening it as a workspace", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-write");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: tempFile, content: "hello from temp\n" },
  });

  assert.equal(written.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "hello from temp\n");
});

test("read can inspect a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-read");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "read from temp\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: tempFile },
  });

  assert.equal(read.isError, undefined);
  assert.match(allResponseText(read), /read from temp/);
});

test("edit can modify a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-edit");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "before temp edit\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: tempFile,
      edits: [{ oldText: "before temp edit", newText: "after temp edit" }],
    },
  });

  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "after temp edit\n");
});

test("rename and delete are core tools in regular and codex modes", async (t) => {
  const regular = await fixture(t);
  const codex = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });

  for (const context of [regular, codex]) {
    const tools = await context.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("rename"));
    assert.ok(names.includes("delete"));
  }
});

test("rename and delete mutate workspace paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "before.txt"), "workspace mutation\n");

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "before.txt", newPath: "after.txt" },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(join(context.project, "after.txt"), "utf8"), "workspace mutation\n");
  await assert.rejects(readFile(join(context.project, "before.txt"), "utf8"), /ENOENT/);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "after.txt" },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(join(context.project, "after.txt"), "utf8"), /ENOENT/);
});

test("rename and delete mutate OS temp paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const before = join(tempRoot, "before.txt");
  const after = join(tempRoot, "after.txt");
  await writeFile(before, "temp mutation\n");
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: before, newPath: after },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(after, "utf8"), "temp mutation\n");

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: after },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(after, "utf8"), /ENOENT/);
});

test("delete refuses the workspace root itself", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-delete-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: ".", recursive: true },
  });

  assert.equal(deleted.isError, true);
  assert.match(allResponseText(deleted), /allowed root itself/i);
  assert.equal(await readFile(join(context.project, "AGENTS.md"), "utf8") !== "", true);
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "delete");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "failed");
});

test("codex apply_patch can create a file in the OS temp directory", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "chat-temp-apply-patch");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "patched-temp.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: `*** Begin Patch\n*** Add File: ${tempFile}\n+patched temp\n*** End Patch`,
    },
  });

  assert.equal(patched.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "patched temp\n");
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "apply_patch");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "done");
});

test("Composite Workspace routes Codex apply_patch and process tools through an explicit member", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const ordinary = await callOpen(context.client, context.project, "chat-codex-composite-member");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "codex-composite" },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Codex member",
        workspaceId: ordinaryId,
      },
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const panelOpened = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(panelOpened).turnId);

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      patch: "*** Begin Patch\n*** Add File: composite-codex.txt\n+patched\n*** End Patch",
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(patched.isError, undefined, allResponseText(patched));
  assert.equal(await readFile(join(context.project, "composite-codex.txt"), "utf8"), "patched\n");
  const patchedCard = (patched._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(patchedCard?.workspaceId, compositeId);
  assert.equal(patchedCard?.member, "code");

  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const started = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      cmd: `${node} -e \"console.log('composite-codex-process'); setTimeout(() => {}, 150)\"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(started.isError, undefined, allResponseText(started));
  const processId = structuredContent(started).processId;
  assert.equal(typeof processId, "number");
  const startedCard = (started._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(startedCard?.workspaceId, compositeId);
  assert.equal(startedCard?.member, "code");

  const completed = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId: compositeId, member: "code", processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(completed.isError, undefined, allResponseText(completed));
  assert.match(allResponseText(completed), /composite-codex-process/);
  const completedCard = (completed._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(completedCard?.workspaceId, compositeId);
  assert.equal(completedCard?.member, "code");

  const panel = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(panel.isError, undefined);
  const activities = structuredContent(panel).activities as Array<Record<string, unknown>>;
  assert.deepEqual(activities.map((activity) => [activity.tool, activity.member]), [
    ["apply_patch", "code"],
    ["exec_command", "code"],
  ]);
  for (const record of ["act_test_1", "act_test_2"]) {
    assert.equal(context.auditStore.getActivity(record)?.workspace.id, ordinaryId);
  }
});

test("temp file access rejects symlinks that escape the OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable outside-temp target on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-symlink");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const escapedPath = join(tempRoot, "escaped-hosts");
  await symlink("/etc/hosts", escapedPath);
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const escaped = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: escapedPath },
  });

  assert.equal(escaped.isError, true);
  assert.match(allResponseText(escaped), /outside allowed roots/i);
});

test("file tools still reject arbitrary paths outside the workspace and OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable non-temp path on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-outside-file-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const outside = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "/etc/hosts" },
  });

  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots/i);
});

test("open_workspace does not treat the OS temp directory as an implicit workspace root", async (t) => {
  const context = await fixture(t);

  const opened = await callOpen(context.client, tmpdir(), "chat-temp-workspace");

  assert.equal(opened.isError, true);
  assert.match(allResponseText(opened), /outside allowed roots/i);
});

