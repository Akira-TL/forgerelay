import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { authenticateRemote, withRemoteMcpClient } from "../remote-auth.js";
import {
  installFakeSsh,
  resultText,
  setupGitRepository,
  startForge,
  startGatewayClient,
  structuredContent,
} from "./test-support.js";

void test("gateway opens, reads, and closes a workspace on a direct remote ForgeRelay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "sentinel.txt"), "gateway-local-content\n");
  await writeFile(join(remoteRoot, "sentinel.txt"), "execution-remote-content\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-owner-token-that-is-long-enough",
    instanceId: "forge-relay-execution-test",
  });

  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-owner-token-that-is-long-enough",
    instanceId: "forge-relay-gateway-test",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: remoteRoot,
      relay: "workstation",
      context: "none",
    },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const openedStructured = structuredContent(opened);
  const gatewayWorkspaceId = openedStructured.workspaceId;
  assert.equal(typeof gatewayWorkspaceId, "string");
  assert.match(String(gatewayWorkspaceId), /^rws_/);
  assert.equal(openedStructured.root, remoteRoot);
  assert.doesNotMatch(JSON.stringify(opened), /"ws_[0-9a-f]{10}"/);

  const inspected = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: gatewayWorkspaceId },
  });
  assert.equal(inspected.isError, undefined, resultText(inspected));
  const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(inspection.workspaceId, gatewayWorkspaceId);
  assert.equal(inspection.kind, "workspace");
  assert.equal(inspection.location, "relay");
  assert.equal(inspection.root, remoteRoot);
  assert.equal(inspection.routeState, "known");
  assert.equal(inspection.mode, "checkout");
  assert.equal(inspection.relay, "workstation");
  assert.equal(inspection.executionLocation, "remote:workstation");
  const inspectedJson = JSON.stringify(inspected);
  for (const forbidden of [
    remote.endpoint,
    remote.ownerToken,
    remoteRecord.accessToken,
    remoteRecord.refreshToken,
    "remoteInstanceId",
    "remoteWorkspaceId",
    "sshRoute",
  ]) {
    assert.equal(inspectedJson.includes(forbidden), false, `relayed inspect leaked ${forbidden}`);
  }
  assert.doesNotMatch(inspectedJson, /"ws_[0-9a-f]{10}"/);

  const read = await client.callTool({
    name: "read",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      path: "sentinel.txt",
    },
  });
  assert.equal(read.isError, undefined, resultText(read));
  assert.match(resultText(read), /execution-remote-content/);
  assert.doesNotMatch(resultText(read), /gateway-local-content/);
  assert.doesNotMatch(JSON.stringify(read), /"ws_[0-9a-f]{10}"/);

  const closed = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: gatewayWorkspaceId },
  });
  assert.equal(closed.isError, undefined, resultText(closed));
  assert.equal(structuredContent(closed).workspaceId, gatewayWorkspaceId);
  assert.doesNotMatch(JSON.stringify(closed), /"ws_[0-9a-f]{10}"/);

  const remoteInventory = await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "open_workspace",
      arguments: { action: "list", root: remoteRoot, state: "active" },
    }),
  );
  const inventoryStructured = structuredContent(remoteInventory);
  assert.equal((inventoryStructured.summary as { matching?: number } | undefined)?.matching, 0);

  const afterClose = await client.callTool({
    name: "read",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      path: "sentinel.txt",
    },
  });
  assert.equal(afterClose.isError, true);
  assert.match(resultText(afterClose), /workspace|unknown|not found/i);

  const openedForFailure = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: remoteRoot,
      relay: "workstation",
      context: "none",
      newWorkspace: true,
    },
  });
  assert.equal(openedForFailure.isError, undefined, resultText(openedForFailure));
  const failureGatewayWorkspaceId = String(structuredContent(openedForFailure).workspaceId);
  const activeInventory = await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "open_workspace",
      arguments: { action: "list", root: remoteRoot, state: "active" },
    }),
  );
  const activeWorkspaces = structuredContent(activeInventory).workspaces as Array<{ workspaceId?: unknown }>;
  const failureRemoteWorkspaceId = String(activeWorkspaces[0]?.workspaceId ?? "");
  assert.match(failureRemoteWorkspaceId, /^ws_[0-9a-f]{10}$/);
  await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "close_workspace",
      arguments: { workspaceId: failureRemoteWorkspaceId },
    }),
  );

  const staleRouteInspection = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: failureGatewayWorkspaceId },
  });
  assert.equal(staleRouteInspection.isError, undefined, resultText(staleRouteInspection));
  const staleRouteProjection = structuredContent(staleRouteInspection).inspection as Record<string, unknown>;
  assert.equal(staleRouteProjection.routeState, "known");
  assert.equal(staleRouteProjection.state, "closed");
  assert.equal(staleRouteProjection.status, "closed");

  const failedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId: failureGatewayWorkspaceId, path: "sentinel.txt" },
  });
  assert.equal(failedRead.isError, true);
  assert.doesNotMatch(resultText(failedRead), new RegExp(failureRemoteWorkspaceId));
  assert.match(resultText(failedRead), new RegExp(failureGatewayWorkspaceId));

  const failedClose = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: failureGatewayWorkspaceId },
  });
  assert.equal(failedClose.isError, true);
  assert.doesNotMatch(resultText(failedClose), new RegExp(failureRemoteWorkspaceId));
  assert.match(resultText(failedClose), new RegExp(failureGatewayWorkspaceId));
  t.after(() => rm(root, { recursive: true, force: true }));
});
void test("relayed persistent Workspace identity, Task truth, inspection, and delete stay execution-owned", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-persistent-"));
  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  const remoteStateDir = join(root, "remote", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "keep.txt"), "remote project survives Workspace delete\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-persistent-owner-token-long-enough",
    instanceId: "forge-relay-persistent-remote",
    taskReminderInterval: 2,
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-persistent-owner-token-long-enough",
    instanceId: "forge-relay-persistent-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const sessionA = { "openai/session": "relay-persistent-a" };
  const sessionB = { "openai/session": "relay-persistent-b" };
  const sessionC = { "openai/session": "relay-persistent-c" };
  const call = (name: string, arguments_: Record<string, unknown>, meta: Record<string, string>) =>
    client.callTool({ name, arguments: arguments_, _meta: meta } as Parameters<Client["callTool"]>[0]);

  const openedA = await call("open_workspace", {
    path: remoteRoot,
    relay: "workstation",
    context: "none",
  }, sessionA);
  assert.equal(openedA.isError, undefined, resultText(openedA));
  const gatewayWorkspaceId = String(structuredContent(openedA).workspaceId);
  assert.match(gatewayWorkspaceId, /^rws_/);

  const openedB = await call("open_workspace", {
    path: remoteRoot,
    relay: "workstation",
    context: "none",
  }, sessionB);
  assert.equal(openedB.isError, undefined, resultText(openedB));
  assert.equal(structuredContent(openedB).workspaceId, gatewayWorkspaceId);

  const createdList = await call("capability", {
    workspaceId: gatewayWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Relay acceptance" },
  }, sessionA);
  assert.equal(createdList.isError, undefined, resultText(createdList));
  const listId = String((((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id));
  assert.ok(listId);
  const taskBody = "EXECUTION_ONLY_RELAY_TASK_BODY";
  const createdTask = await call("capability", {
    workspaceId: gatewayWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId,
      subject: "Verify Relay parity",
      content: taskBody,
      status: "in_progress",
    },
  }, sessionA);
  assert.equal(createdTask.isError, undefined, resultText(createdTask));

  const firstSemanticWork = await call("read", { workspaceId: gatewayWorkspaceId, path: "keep.txt" }, sessionB);
  assert.equal(firstSemanticWork.isError, undefined, resultText(firstSemanticWork));
  assert.doesNotMatch(resultText(firstSemanticWork), /Reminder: this Workspace has unfinished active Tasks/);
  const reminderSemanticWork = await call("read", { workspaceId: gatewayWorkspaceId, path: "keep.txt" }, sessionB);
  assert.equal(reminderSemanticWork.isError, undefined, resultText(reminderSemanticWork));
  assert.match(resultText(reminderSemanticWork), /Reminder: this Workspace has unfinished active Tasks/);
  assert.equal(resultText(reminderSemanticWork).includes(taskBody), false);

  const remoteInventory = await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "open_workspace",
      arguments: { action: "list", root: remoteRoot },
    }),
  );
  const remoteWorkspaceId = String(
    ((structuredContent(remoteInventory).workspaces as Array<Record<string, unknown>>)[0]?.workspaceId),
  );
  assert.match(remoteWorkspaceId, /^ws_[0-9a-f]{10}$/);
  assert.match(await readFile(join(remoteStateDir, "workspaces", remoteWorkspaceId, "tasks.json"), "utf8"), new RegExp(taskBody));
  await assert.rejects(
    readFile(join(gatewayStateDir, "workspaces", gatewayWorkspaceId, "tasks.json"), "utf8"),
    /ENOENT/,
  );

  const closed = await call("close_workspace", { workspaceId: gatewayWorkspaceId }, sessionA);
  assert.equal(closed.isError, undefined, resultText(closed));
  assert.equal(structuredContent(closed).workspaceId, gatewayWorkspaceId);
  assert.equal(structuredContent(closed).action, "close");

  const inspectedClosed = await call("open_workspace", {
    action: "inspect",
    workspaceId: gatewayWorkspaceId,
  }, sessionB);
  assert.equal(inspectedClosed.isError, undefined, resultText(inspectedClosed));
  const closedProjection = structuredContent(inspectedClosed).inspection as Record<string, unknown>;
  assert.equal(closedProjection.workspaceId, gatewayWorkspaceId);
  assert.equal(closedProjection.location, "relay");
  assert.equal(closedProjection.state, "closed");
  assert.equal(closedProjection.status, "closed");
  const taskSummary = closedProjection.taskSummary as Record<string, unknown>;
  assert.equal(taskSummary.level, "summary");
  assert.equal(((taskSummary.lists as Array<Record<string, unknown>>)[0]?.unfinishedTaskCount), 1);
  const inspectedJson = JSON.stringify(inspectedClosed);
  assert.equal(inspectedJson.includes(taskBody), false);
  assert.equal(inspectedJson.includes(remoteWorkspaceId), false);
  assert.equal(inspectedJson.includes(remoteRecord.accessToken), false);
  assert.equal(inspectedJson.includes(remoteRecord.refreshToken), false);
  assert.equal(inspectedJson.includes(remote.endpoint), false);

  const reopened = await call("open_workspace", {
    workspaceId: gatewayWorkspaceId,
    context: "none",
  }, sessionC);
  assert.equal(reopened.isError, undefined, resultText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, gatewayWorkspaceId);
  const restored = await call("capability", {
    workspaceId: gatewayWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get", level: "headers", listId },
  }, sessionC);
  assert.equal(restored.isError, undefined, resultText(restored));
  const restoredLists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  const restoredTasks = restoredLists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(restoredTasks[0]?.subject, "Verify Relay parity");
  assert.equal(restoredTasks[0]?.content, undefined);

  const deleted = await call("close_workspace", {
    workspaceId: gatewayWorkspaceId,
    action: "delete",
  }, sessionC);
  assert.equal(deleted.isError, undefined, resultText(deleted));
  assert.equal(structuredContent(deleted).workspaceId, gatewayWorkspaceId);
  assert.equal(structuredContent(deleted).action, "delete");
  assert.equal(await readFile(join(remoteRoot, "keep.txt"), "utf8"), "remote project survives Workspace delete\n");
  await assert.rejects(
    readFile(join(remoteStateDir, "workspaces", remoteWorkspaceId, "tasks.json"), "utf8"),
    /ENOENT/,
  );

  const deletedInspection = await call("open_workspace", {
    action: "inspect",
    workspaceId: gatewayWorkspaceId,
  }, sessionA);
  assert.equal(deletedInspection.isError, true);
  const reopenedAfterDelete = await call("open_workspace", {
    path: remoteRoot,
    relay: "workstation",
    context: "none",
  }, sessionA);
  assert.equal(reopenedAfterDelete.isError, undefined, resultText(reopenedAfterDelete));
  assert.notEqual(structuredContent(reopenedAfterDelete).workspaceId, gatewayWorkspaceId);

  t.after(() => rm(root, { recursive: true, force: true }));
});
void test("relayed managed-worktree Workspace keeps identity and Task state across finalize, reopen, and delete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-worktree-persistent-"));
  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  const remoteStateDir = join(root, "remote", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await setupGitRepository(remoteRoot);
  execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: remoteRoot });

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-worktree-owner-token-long-enough",
    instanceId: "forge-relay-worktree-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-worktree-owner-token-long-enough",
    instanceId: "forge-relay-worktree-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: remoteRoot,
      relay: "workstation",
      mode: "worktree",
      context: "none",
    },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const gatewayWorkspaceId = String(structuredContent(opened).workspaceId);
  const firstWorktreeRoot = String(structuredContent(opened).root);
  assert.match(gatewayWorkspaceId, /^rws_/);
  assert.notEqual(firstWorktreeRoot, remoteRoot);

  const createdList = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Worktree relay" },
    },
  });
  assert.equal(createdList.isError, undefined, resultText(createdList));
  const listId = String((((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id));
  const createdTask = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Survive managed finalize",
        content: "WORKTREE_EXECUTION_ONLY_TASK_BODY",
        status: "in_progress",
      },
    },
  });
  assert.equal(createdTask.isError, undefined, resultText(createdTask));

  const write = await client.callTool({
    name: "write",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      path: "relay-worktree.txt",
      content: "managed relay change\n",
    },
  });
  assert.equal(write.isError, undefined, resultText(write));

  const remoteInventory = await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "open_workspace",
      arguments: { action: "list", mode: "worktree" },
    }),
  );
  const remoteWorkspaceId = String(
    ((structuredContent(remoteInventory).workspaces as Array<Record<string, unknown>>)[0]?.workspaceId),
  );
  assert.match(remoteWorkspaceId, /^ws_[0-9a-f]{10}$/);

  const closed = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: gatewayWorkspaceId, commitMessage: "TEST: (relay) finalize managed worktree" },
  });
  assert.equal(closed.isError, undefined, resultText(closed));
  assert.equal(structuredContent(closed).workspaceId, gatewayWorkspaceId);
  assert.equal(structuredContent(closed).action, "close");
  await assert.rejects(readFile(join(firstWorktreeRoot, "relay-worktree.txt"), "utf8"), /ENOENT/);
  assert.match(await readFile(join(remoteRoot, "relay-worktree.txt"), "utf8"), /^managed relay change\r?\n$/);
  assert.match(
    await readFile(join(remoteStateDir, "workspaces", remoteWorkspaceId, "tasks.json"), "utf8"),
    /WORKTREE_EXECUTION_ONLY_TASK_BODY/,
  );

  const inspectedClosed = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: gatewayWorkspaceId },
  });
  assert.equal(inspectedClosed.isError, undefined, resultText(inspectedClosed));
  const closedProjection = structuredContent(inspectedClosed).inspection as Record<string, unknown>;
  assert.equal(closedProjection.state, "closed");
  assert.equal(closedProjection.status, "closed");
  assert.equal(closedProjection.mode, "worktree");
  assert.equal(closedProjection.managed, true);
  assert.equal(closedProjection.rootValid, false);
  assert.equal(JSON.stringify(inspectedClosed).includes(remoteWorkspaceId), false);
  assert.equal(JSON.stringify(inspectedClosed).includes("WORKTREE_EXECUTION_ONLY_TASK_BODY"), false);

  const reopened = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: gatewayWorkspaceId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, resultText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, gatewayWorkspaceId);
  assert.equal(structuredContent(reopened).mode, "worktree");
  const reopenedRoot = String(structuredContent(reopened).root);
  assert.match(await readFile(join(reopenedRoot, "relay-worktree.txt"), "utf8"), /^managed relay change\r?\n$/);

  const restored = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId },
    },
  });
  assert.equal(restored.isError, undefined, resultText(restored));
  const restoredLists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  const restoredTasks = restoredLists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(restoredTasks[0]?.subject, "Survive managed finalize");
  assert.equal(restoredTasks[0]?.content, undefined);

  const deleted = await client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      action: "delete",
      commitMessage: "TEST: (relay) delete managed worktree",
    },
  });
  assert.equal(deleted.isError, undefined, resultText(deleted));
  assert.equal(structuredContent(deleted).action, "delete");
  await assert.rejects(
    readFile(join(remoteStateDir, "workspaces", remoteWorkspaceId, "tasks.json"), "utf8"),
    /ENOENT/,
  );
  const deletedInspection = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: gatewayWorkspaceId },
  });
  assert.equal(deletedInspection.isError, true);

  t.after(() => rm(root, { recursive: true, force: true }));
});
