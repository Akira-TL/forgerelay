import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("Composite close preserves identity and members while delete dissolves only Composite state", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "preserved.txt"), "preserved-member\n");
  const memberWorkspace = await callOpen(context.client, context.project, "chat-composite-close-member");
  const memberWorkspaceId = String(structuredContent(memberWorkspace).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "persistent-process" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Preserved source workspace",
        workspaceId: memberWorkspaceId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const running = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: memberWorkspaceId,
      command: `${node} -e \"setTimeout(() => console.log('member-finished'), 1200)\"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(running.isError, undefined, allResponseText(running));
  const processId = Number(structuredContent(running).processId);
  assert.ok(processId > 0);
  assert.equal(structuredContent(running).running, true);

  const invalidCommitMessage = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, commitMessage: "must not be used" },
  });
  assert.equal(invalidCommitMessage.isError, true);
  assert.match(allResponseText(invalidCommitMessage), /not valid.*Composite/i);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  const closedStructured = structuredContent(closed);
  assert.equal(closedStructured.kind, "composite");
  assert.equal(closedStructured.action, "close");
  assert.equal(closedStructured.status, "closed");
  assert.equal(closedStructured.dissolved, false);
  assert.equal(closedStructured.workspaceId, compositeId);
  assert.deepEqual(closedStructured.members, [{
    name: "code",
    purpose: "Preserved source workspace",
    workspaceId: memberWorkspaceId,
  }]);
  assert.match(allResponseText(closed), /identity and member topology were preserved/i);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId, status: "closed" },
  });
  const listedComposite = (structuredContent(listed).compositeWorkspaces as Array<Record<string, unknown>>)[0];
  assert.equal(listedComposite?.workspaceId, compositeId);
  assert.equal(listedComposite?.status, "closed");
  assert.equal(listedComposite?.state, "closed");
  assert.deepEqual(listedComposite?.members, closedStructured.members);

  const closedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "preserved.txt" },
  });
  assert.equal(closedRoute.isError, true);
  assert.match(allResponseText(closedRoute), /Composite Workspace .* is closed/i);

  const closedMemberMutation = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "remove",
      member: { name: "code" },
    },
  });
  assert.equal(closedMemberMutation.isError, true);
  assert.match(allResponseText(closedMemberMutation), /is closed/i);

  const unopenedMemberProject = join(dirname(context.project), "closed-composite-unopened-member");
  await mkdir(unopenedMemberProject, { recursive: true });
  await writeFile(join(unopenedMemberProject, "AGENTS.md"), "unopened member instructions\n");
  const closedAdd = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "data",
        purpose: "Must not be opened while Composite is closed",
        path: unopenedMemberProject,
      },
    },
  });
  assert.equal(closedAdd.isError, true);
  assert.match(allResponseText(closedAdd), /is closed/i);
  const unopenedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "workspace", root: unopenedMemberProject },
  });
  assert.equal((structuredContent(unopenedInventory).workspaces as Array<Record<string, unknown>>).length, 0);

  const closedPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closedPanel.isError, true);
  assert.match(allResponseText(closedPanel), /No Workspace presentation|closed/i);

  const directMemberRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "preserved.txt" },
  });
  assert.equal(directMemberRead.isError, undefined, allResponseText(directMemberRead));
  assert.match(allResponseText(directMemberRead), /preserved-member/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, compositeId);
  assert.equal(structuredContent(reopened).status, "active");
  assert.deepEqual(structuredContent(reopened).members, closedStructured.members);

  const reopenedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "preserved.txt" },
  });
  assert.equal(reopenedRoute.isError, undefined, allResponseText(reopenedRoute));
  assert.match(allResponseText(reopenedRoute), /preserved-member/);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).action, "delete");
  assert.equal(structuredContent(deleted).dissolved, true);
  assert.match(allResponseText(deleted), /Composite relationship.*dissolved/i);

  const processResult = await waitForToolText(
    context.client,
    {
      name: "bash",
      arguments: { workspaceId: memberWorkspaceId, action: "process", processId, yieldTimeMs: 2_000 },
    },
    /member-finished/,
    4_000,
  );
  assert.equal(processResult.isError, undefined, allResponseText(processResult));
  assert.match(allResponseText(processResult), /member-finished/);

  const deletedOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(deletedOpen.isError, true);
  assert.match(allResponseText(deletedOpen), /Unknown workspaceId|Unknown Composite Workspace/i);
});

test("Composite close and delete never finalize a managed-worktree member", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(
    context.client,
    context.project,
    "chat-composite-close-worktree",
    "worktree",
  );
  const worktreeStructured = structuredContent(worktree);
  const worktreeWorkspaceId = String(worktreeStructured.workspaceId);
  const worktreeRoot = String(worktreeStructured.root);
  await writeFile(join(worktreeRoot, "unfinished.txt"), "still in worktree\n");

  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "dissolve-worktree" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "isolated",
        purpose: "Managed isolated work",
        workspaceId: worktreeWorkspaceId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).status, "closed");
  assert.equal((await stat(worktreeRoot)).isDirectory(), true);
  assert.equal(await readFile(join(worktreeRoot, "unfinished.txt"), "utf8"), "still in worktree\n");

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, compositeId);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).dissolved, true);
  assert.equal((await stat(worktreeRoot)).isDirectory(), true);
  assert.equal(await readFile(join(worktreeRoot, "unfinished.txt"), "utf8"), "still in worktree\n");

  const stillOpen = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: worktreeWorkspaceId, path: "unfinished.txt" },
  });
  assert.equal(stillOpen.isError, undefined, allResponseText(stillOpen));
  assert.match(allResponseText(stillOpen), /still in worktree/);
});

test("open_workspace list action exposes canonical Workspace inventory through the MCP surface", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-list-1");
  const second = await callOpen(context.client, context.project, "chat-list-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", root: context.project },
    _meta: { "openai/session": "chat-list-1" },
  } as Parameters<Client["callTool"]>[0]);
  const structured = structuredContent(listed);
  const inventory = structured.workspaces as Array<Record<string, unknown>>;

  assert.equal(structured.action, "list");
  assert.equal(inventory.length, 1);
  assert.deepEqual(new Set(inventory.map((entry) => entry.workspaceId)), new Set([firstId]));
  assert.equal(inventory.find((entry) => entry.workspaceId === firstId)?.current, true);
  assert.equal(inventory.every((entry) => entry.mode === "checkout"), true);
  assert.equal(inventory.every((entry) => entry.status === "active"), true);
  assert.equal(inventory.every((entry) => entry.state === "active"), true);
  assert.equal(inventory.every((entry) => entry.rootValid === true), true);
  assert.equal(inventory.every((entry) => String(entry.label).startsWith("project/ws_")), true);
  assert.equal((structured.summary as Record<string, unknown>).matching, 1);
  assert.equal((structured.page as Record<string, unknown>).hasMore, false);
  assert.match(allResponseText(listed), /resume.*workspaceId/i);
  assert.match(allResponseText(listed), /close_workspace/);

  const outside = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", root: "/etc" },
    _meta: { "openai/session": "chat-list-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots/i);
});

test("open_workspace list derives stale and invalid states without refreshing last-used time", async (t) => {
  const context = await fixture(t);
  const staleOpen = await callOpen(context.client, context.project, "chat-stale");
  const staleId = String(structuredContent(staleOpen).workspaceId);
  const missingRoot = join(dirname(context.project), "missing-project");
  await mkdir(missingRoot);
  await writeFile(join(missingRoot, "AGENTS.md"), "temporary instructions\n");
  const missingOpen = await callOpen(context.client, missingRoot, "chat-missing");
  const missingId = String(structuredContent(missingOpen).workspaceId);
  await rm(missingRoot, { recursive: true, force: true });

  const staleAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString();
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(staleAt, staleId);
  } finally {
    database.close();
  }

  const staleList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", staleOnly: true },
    _meta: { "openai/session": "chat-inventory" },
  } as Parameters<Client["callTool"]>[0]);
  const staleEntries = structuredContent(staleList).workspaces as Array<Record<string, unknown>>;
  assert.equal(staleEntries.some((entry) => entry.workspaceId === staleId), true);
  assert.equal(staleEntries.every((entry) => entry.state === "stale"), true);

  const invalidList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", state: "invalid" },
    _meta: { "openai/session": "chat-inventory" },
  } as Parameters<Client["callTool"]>[0]);
  const invalidEntries = structuredContent(invalidList).workspaces as Array<Record<string, unknown>>;
  const invalid = invalidEntries.find((entry) => entry.workspaceId === missingId);
  assert.ok(invalid);
  assert.equal(invalid.status, "active");
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.rootValid, false);

  const verification = openDatabase(context.stateDir);
  try {
    const row = verification.sqlite
      .prepare("select last_used_at from workspace_sessions where id = ?")
      .get(staleId) as { last_used_at: string };
    assert.equal(row.last_used_at, staleAt);
  } finally {
    verification.close();
  }
});

test("open_workspace list exposes managed worktrees and paginates inventory", async (t) => {
  const context = await fixture(t, { git: true });
  await callOpen(context.client, context.project, "chat-page");
  const worktreeOpen = await callOpen(
    context.client,
    context.project,
    "chat-worktree-list",
    "worktree",
  );
  const worktreeId = String(structuredContent(worktreeOpen).workspaceId);

  const worktreeList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", mode: "worktree" },
    _meta: { "openai/session": "chat-worktree-list" },
  } as Parameters<Client["callTool"]>[0]);
  const worktrees = structuredContent(worktreeList).workspaces as Array<Record<string, unknown>>;
  const managed = worktrees.find((entry) => entry.workspaceId === worktreeId);
  assert.ok(managed);
  assert.equal(managed.managed, true);
  assert.equal(managed.mode, "worktree");
  assert.equal(managed.sourceRoot, context.project);
  assert.equal(managed.rootValid, true);
  assert.equal(typeof managed.branch, "string");

  const firstPage = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", limit: 1 },
    _meta: { "openai/session": "chat-page" },
  } as Parameters<Client["callTool"]>[0]);
  const firstStructured = structuredContent(firstPage);
  assert.equal((firstStructured.workspaces as unknown[]).length, 1);
  assert.equal((firstStructured.page as Record<string, unknown>).hasMore, true);

  const secondPage = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", offset: 1, limit: 1 },
    _meta: { "openai/session": "chat-page" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal((structuredContent(secondPage).workspaces as unknown[]).length, 1);
});

test("open_workspace list distinguishes closed and externally missing managed worktrees", async (t) => {
  const context = await fixture(t, { git: true });
  const closable = await callOpen(
    context.client,
    context.project,
    "chat-worktree-closed",
    "worktree",
  );
  const closableStructured = structuredContent(closable);
  const closableId = String(closableStructured.workspaceId);
  const missing = await callOpen(
    context.client,
    context.project,
    "chat-worktree-invalid",
    "worktree",
    true,
  );
  const missingStructured = structuredContent(missing);
  const missingId = String(missingStructured.workspaceId);
  const missingRoot = String(missingStructured.root);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId: closableId,
      commitMessage: "TEST: (workspace) close managed inventory fixture",
    },
  });
  assert.equal(closed.isError, undefined);
  await rm(missingRoot, { recursive: true, force: true });
  const gitStateBefore = await managedWorktreeGitState(context.project);
  const lastUsedBefore = workspaceLastUsedAt(context.stateDir, missingId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", mode: "worktree" },
    _meta: { "openai/session": "chat-worktree-invalid" },
  } as Parameters<Client["callTool"]>[0]);
  const worktrees = structuredContent(listed).workspaces as Array<Record<string, unknown>>;
  const closedEntry = worktrees.find((entry) => entry.workspaceId === closableId);
  const invalidEntry = worktrees.find((entry) => entry.workspaceId === missingId);

  assert.ok(closedEntry);
  assert.equal(closedEntry.status, "closed");
  assert.equal(closedEntry.state, "closed");
  assert.equal(closedEntry.rootValid, false);
  assert.ok(invalidEntry);
  assert.equal(invalidEntry.status, "active");
  assert.equal(invalidEntry.state, "invalid");
  assert.equal(invalidEntry.rootValid, false);
  assert.deepEqual(invalidEntry.recovery, {
    classification: "recoverable",
    conditions: ["backing-missing", "git-registration-stale"],
    backing: "missing",
    source: "available",
    gitRegistration: "stale",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "unavailable",
  });
  assert.equal(closedEntry.recovery, undefined);

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: missingId },
    _meta: { "openai/session": "chat-worktree-invalid" },
  } as Parameters<Client["callTool"]>[0]);
  const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.deepEqual(inspection.recovery, invalidEntry.recovery);
  assert.deepEqual(await managedWorktreeGitState(context.project), gitStateBefore);
  assert.equal(workspaceLastUsedAt(context.stateDir, missingId), lastUsedBefore);
});

test("open_workspace inventory reports healthy and branch-mismatched managed worktrees", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-worktree-recovery", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const worktreeRoot = String(worktree.path);

  const healthyList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const healthy = (structuredContent(healthyList).workspaces as Array<Record<string, unknown>>)[0];
  assert.deepEqual(healthy?.recovery, {
    classification: "healthy",
    conditions: [],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "matching",
  });

  await git(worktreeRoot, ["switch", "-c", "external-branch"]);
  const mismatchedInspect = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  const inspection = structuredContent(mismatchedInspect).inspection as Record<string, unknown>;
  assert.equal(inspection.state, "invalid");
  assert.equal(inspection.rootValid, true);
  assert.deepEqual(inspection.recovery, {
    classification: "manual-intervention",
    conditions: ["branch-mismatch"],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "mismatched",
  });
});

test("open_workspace inspection separates missing managed and target branches", async (t) => {
  const context = await fixture(t, { git: true });
  const managedMissingOpen = await callOpen(
    context.client,
    context.project,
    "chat-managed-branch-missing",
    "worktree",
  );
  const managedWorkspaceId = String(structuredContent(managedMissingOpen).workspaceId);
  const managedWorktree = structuredContent(managedMissingOpen).worktree as Record<string, unknown>;
  const managedBranch = String(managedWorktree.branch);
  await git(String(managedWorktree.path), ["switch", "-c", "external-managed-replacement"]);
  await git(context.project, ["branch", "-D", managedBranch]);

  const managedMissingInspect = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: managedWorkspaceId },
  });
  const managedInspection = structuredContent(managedMissingInspect).inspection as Record<string, unknown>;
  assert.deepEqual(managedInspection.recovery, {
    classification: "manual-intervention",
    conditions: ["managed-branch-missing", "branch-mismatch"],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "missing",
    targetBranch: "present",
    backingBranch: "mismatched",
  });

  const targetMissingOpen = await callOpen(
    context.client,
    context.project,
    "chat-target-branch-missing",
    "worktree",
    true,
  );
  const targetWorkspaceId = String(structuredContent(targetMissingOpen).workspaceId);
  const targetWorktree = structuredContent(targetMissingOpen).worktree as Record<string, unknown>;
  const targetBranch = String(targetWorktree.targetBranch);
  await git(context.project, ["switch", "-c", "external-target-replacement"]);
  await git(context.project, ["branch", "-D", targetBranch]);

  const targetMissingInspect = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: targetWorkspaceId },
  });
  const targetInspection = structuredContent(targetMissingInspect).inspection as Record<string, unknown>;
  assert.deepEqual(targetInspection.recovery, {
    classification: "manual-intervention",
    conditions: ["target-branch-missing"],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "missing",
    backingBranch: "matching",
  });
});

test("open_workspace inspection reports an unavailable managed-worktree source", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-source-unavailable", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktreeRoot = String((structuredContent(opened).worktree as Record<string, unknown>).path);
  await rename(join(context.project, ".git"), join(context.project, ".git-disabled"));
  await git(dirname(context.project), ["init"]);

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(inspection.state, "invalid");
  assert.equal(inspection.rootValid, true);
  assert.deepEqual(inspection.recovery, {
    classification: "manual-intervention",
    conditions: ["source-unavailable"],
    backing: "present",
    source: "unavailable",
    gitRegistration: "unavailable",
    managedBranch: "unknown",
    targetBranch: "unknown",
    backingBranch: "unavailable",
  });
  assert.equal((await stat(worktreeRoot)).isDirectory(), true);
});

test("open_workspace inspection reports a missing managed-worktree source without touching the backing", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-source-missing", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktreeRoot = String((structuredContent(opened).worktree as Record<string, unknown>).path);
  await rm(context.project, { recursive: true, force: true });
  const backingBefore = await stat(worktreeRoot);

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(inspection.state, "invalid");
  assert.equal(inspection.rootValid, true);
  assert.deepEqual(inspection.recovery, {
    classification: "manual-intervention",
    conditions: ["source-missing"],
    backing: "present",
    source: "missing",
    gitRegistration: "unavailable",
    managedBranch: "unknown",
    targetBranch: "unknown",
    backingBranch: "unavailable",
  });
  assert.equal((await stat(worktreeRoot)).ino, backingBefore.ino);
});

function workspaceLastUsedAt(stateDir: string, workspaceId: string): string {
  const database = openDatabase(stateDir);
  try {
    const row = database.sqlite
      .prepare("select last_used_at from workspace_sessions where id = ?")
      .get(workspaceId) as { last_used_at: string };
    return row.last_used_at;
  } finally {
    database.close();
  }
}

async function managedWorktreeGitState(cwd: string): Promise<{ worktrees: string; managedRefs: string }> {
  const [worktrees, managedRefs] = await Promise.all([
    execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd }),
    execFileAsync(
      "git",
      ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/forgerelay"],
      { cwd },
    ),
  ]);
  return { worktrees: worktrees.stdout, managedRefs: managedRefs.stdout };
}

