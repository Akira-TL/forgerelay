import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { authenticateRemote, withRemoteMcpClient } from "../workspaces/relay/auth/remote-auth.js";
import {
  installFakeSsh,
  resultText,
  setupGitRepository,
  startForge,
  startGatewayClient,
  structuredContent,
} from "./test-support.js";

void test("Composite Workspace mounts and explicitly routes a Workspace Relay member without fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-composite-relay-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "sentinel.txt"), "gateway-local-content\n");
  await writeFile(join(remoteRoot, "sentinel.txt"), "execution-remote-content\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-composite-owner-token-long-enough",
    instanceId: "forge-relay-composite-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-composite-owner-token-long-enough",
    instanceId: "forge-relay-composite-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });

  const composite = await client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "remote-compute" },
  });
  assert.equal(composite.isError, undefined, resultText(composite));
  const compositeId = String(structuredContent(composite).workspaceId);

  const mounted = await client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "compute",
        purpose: "Remote computation",
        path: remoteRoot,
        relay: "workstation",
      },
    },
  });
  assert.equal(mounted.isError, undefined, resultText(mounted));
  const members = structuredContent(mounted).members as Array<Record<string, unknown>>;
  const memberWorkspaceId = String(members[0]?.workspaceId);
  assert.match(memberWorkspaceId, /^rws_/);

  const panel = await client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(panel.isError, undefined, resultText(panel));
  const compositeTurnId = String(structuredContent(panel).turnId);

  const read = await client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "compute", path: "sentinel.txt" },
  });
  assert.equal(read.isError, undefined, resultText(read));
  assert.match(resultText(read), /execution-remote-content/);
  assert.doesNotMatch(resultText(read), /gateway-local-content/);
  const card = (read._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(card?.workspaceId, compositeId);
  assert.equal(card?.member, "compute");

  const activitySnapshot = await client.callTool({
    name: "activity_snapshot",
    arguments: { turnId: compositeTurnId },
  });
  assert.equal(activitySnapshot.isError, undefined, resultText(activitySnapshot));
  assert.equal(structuredContent(activitySnapshot).activities, undefined);
  const activityIndex = await client.callTool({
    name: "activity_index",
    arguments: { turnId: compositeTurnId },
  });
  assert.equal(activityIndex.isError, undefined, resultText(activityIndex));
  const activities = structuredContent(activityIndex).activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.member, "compute");
  assert.equal(activities[0]?.workspaceId, memberWorkspaceId);

  const detail = await client.callTool({
    name: "activity_detail",
    arguments: { turnId: compositeTurnId, activityId: activities[0]?.activityId },
  });
  assert.equal(detail.isError, undefined, resultText(detail));
  assert.equal((structuredContent(detail).activity as Record<string, unknown>).member, "compute");

  const bootstrap = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "compute", context: "full" },
    _meta: { "openai/session": "chat-composite-relay-bootstrap" },
  });
  assert.equal(bootstrap.isError, undefined, resultText(bootstrap));
  const memberContext = structuredContent(bootstrap).memberContext as Record<string, unknown>;
  assert.equal(memberContext.member, "compute");
  assert.equal(memberContext.workspaceId, compositeId);
  assert.equal(memberContext.root, remoteRoot);
  assert.equal(typeof memberContext.contextFingerprint, "string");
  assert.ok(Array.isArray(memberContext.agentsFiles));
  assert.ok(Array.isArray(memberContext.capabilityGuides));
  assert.ok(Array.isArray(memberContext.agentProviders));
  assert.ok(Array.isArray(memberContext.agents));
  assert.doesNotMatch(JSON.stringify(memberContext), /"ws_[0-9a-f]{10}"/);

  await writeFile(join(remoteRoot, "AGENTS.md"), "updated relayed Composite instructions\n");
  const incrementalBootstrap = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "compute", context: "auto" },
    _meta: { "openai/session": "chat-composite-relay-bootstrap" },
  });
  assert.equal(incrementalBootstrap.isError, undefined, resultText(incrementalBootstrap));
  const incrementalMemberContext = structuredContent(incrementalBootstrap).memberContext as Record<string, unknown>;
  assert.match(JSON.stringify(incrementalMemberContext.agentsFiles), /updated relayed Composite instructions/);
  assert.equal(incrementalMemberContext.availableAgentsFiles, undefined);
  assert.equal(incrementalMemberContext.skills, undefined);
  assert.equal(incrementalMemberContext.capabilityGuides, undefined);
  assert.equal(incrementalMemberContext.agentProviders, undefined);
  assert.equal(incrementalMemberContext.agents, undefined);
  assert.equal(incrementalMemberContext.skillDiagnostics, undefined);

  const createdMemberList = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: memberWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite relay member" },
    },
  });
  assert.equal(createdMemberList.isError, undefined, resultText(createdMemberList));
  const memberListId = String(
    ((structuredContent(createdMemberList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const createdMemberTask = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: memberWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId: memberListId,
        subject: "Remote member Task",
        content: "COMPOSITE_REMOTE_MEMBER_TASK_BODY",
        status: "in_progress",
      },
    },
  });
  assert.equal(createdMemberTask.isError, undefined, resultText(createdMemberTask));

  const disposableComposite = await client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "remote-route-preservation" },
  });
  const disposableCompositeId = String(structuredContent(disposableComposite).workspaceId);
  const disposableMount = await client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: disposableCompositeId,
      memberAction: "add",
      member: {
        name: "compute",
        purpose: "Preserved remote route",
        workspaceId: memberWorkspaceId,
      },
    },
  });
  assert.equal(disposableMount.isError, undefined, resultText(disposableMount));
  const closed = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: disposableCompositeId },
  });
  assert.equal(closed.isError, undefined, resultText(closed));
  assert.equal(structuredContent(closed).status, "closed");
  assert.equal(structuredContent(closed).dissolved, false);

  const routeStillOpenAfterClose = await client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "sentinel.txt" },
  });
  assert.equal(routeStillOpenAfterClose.isError, undefined, resultText(routeStillOpenAfterClose));
  assert.match(resultText(routeStillOpenAfterClose), /execution-remote-content/);

  const reopenedDisposable = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: disposableCompositeId, context: "none" },
  });
  assert.equal(reopenedDisposable.isError, undefined, resultText(reopenedDisposable));
  assert.equal(structuredContent(reopenedDisposable).workspaceId, disposableCompositeId);

  const dissolved = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: disposableCompositeId, action: "delete" },
  });
  assert.equal(dissolved.isError, undefined, resultText(dissolved));
  assert.equal(structuredContent(dissolved).dissolved, true);

  const routeStillOpenAfterDelete = await client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "sentinel.txt" },
  });
  assert.equal(routeStillOpenAfterDelete.isError, undefined, resultText(routeStillOpenAfterDelete));
  assert.match(resultText(routeStillOpenAfterDelete), /execution-remote-content/);

  const remoteInventory = await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "open_workspace",
      arguments: { action: "list", root: remoteRoot, state: "active" },
    }),
  );
  const remoteWorkspaces = structuredContent(remoteInventory).workspaces as Array<{ workspaceId?: unknown }>;
  const remoteWorkspaceId = String(remoteWorkspaces[0]?.workspaceId ?? "");
  assert.match(remoteWorkspaceId, /^ws_[0-9a-f]{10}$/);
  await withRemoteMcpClient(
    remoteRecord,
    remote.endpoint,
    (remoteClient) => remoteClient.callTool({
      name: "close_workspace",
      arguments: { workspaceId: remoteWorkspaceId },
    }),
  );

  const unavailable = await client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "compute", path: "sentinel.txt" },
  });
  assert.equal(unavailable.isError, true);
  assert.doesNotMatch(resultText(unavailable), /gateway-local-content/);

  const inspectedComposite = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: compositeId },
  });
  assert.equal(inspectedComposite.isError, undefined, resultText(inspectedComposite));
  const inspectedMembers = (structuredContent(inspectedComposite).inspection as Record<string, unknown>).members as Array<Record<string, unknown>>;
  assert.equal(inspectedMembers[0]?.workspaceId, memberWorkspaceId);
  assert.equal(inspectedMembers[0]?.known, true);
  assert.equal(inspectedMembers[0]?.location, "relay");
  assert.equal(inspectedMembers[0]?.state, "closed");
  assert.equal(inspectedMembers[0]?.status, "closed");
  assert.doesNotMatch(JSON.stringify(inspectedComposite), /"ws_[0-9a-f]{10}"/);
  assert.doesNotMatch(JSON.stringify(inspectedComposite), /COMPOSITE_REMOTE_MEMBER_TASK_BODY/);

  const reopenedMember = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "compute", context: "none" },
  });
  assert.equal(reopenedMember.isError, undefined, resultText(reopenedMember));
  assert.equal(structuredContent(reopenedMember).workspaceId, compositeId);
  const reopenedMemberContext = structuredContent(reopenedMember).memberContext as Record<string, unknown>;
  assert.equal(reopenedMemberContext.member, "compute");
  assert.equal(reopenedMemberContext.workspaceId, compositeId);

  const restoredMemberTasks = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: memberWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId: memberListId },
    },
  });
  assert.equal(restoredMemberTasks.isError, undefined, resultText(restoredMemberTasks));
  const restoredMemberLists = (structuredContent(restoredMemberTasks).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  const restoredMemberTaskHeaders = restoredMemberLists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(restoredMemberTaskHeaders[0]?.subject, "Remote member Task");
  assert.equal(restoredMemberTaskHeaders[0]?.content, undefined);

  const availableAgain = await client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "compute", path: "sentinel.txt" },
  });
  assert.equal(availableAgain.isError, undefined, resultText(availableAgain));
  assert.match(resultText(availableAgain), /execution-remote-content/);
  t.after(() => rm(root, { recursive: true, force: true }));
});
void test("Composite Workspace routes Codex patch and process tools through a relayed member", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-composite-codex-relay-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-composite-codex-owner-token-long-enough",
    instanceId: "forge-relay-composite-codex-remote",
    toolMode: "codex",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-composite-codex-owner-token-long-enough",
    instanceId: "forge-relay-composite-codex-gateway",
    remotes: { compute: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    toolMode: "codex",
  });

  const composite = await client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "codex-relay" },
  });
  assert.equal(composite.isError, undefined, resultText(composite));
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "compute",
        purpose: "Remote Codex execution",
        path: remoteRoot,
        relay: "compute",
      },
    },
  });
  assert.equal(mounted.isError, undefined, resultText(mounted));
  const memberWorkspaceId = String((structuredContent(mounted).members as Array<Record<string, unknown>>)[0]?.workspaceId);
  assert.match(memberWorkspaceId, /^rws_/);

  const panel = await client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  const turnId = String(structuredContent(panel).turnId);

  const patched = await client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: compositeId,
      member: "compute",
      patch: "*** Begin Patch\n*** Add File: remote-codex.txt\n+remote patched\n*** End Patch",
    },
  });
  assert.equal(patched.isError, undefined, resultText(patched));
  assert.equal(await readFile(join(remoteRoot, "remote-codex.txt"), "utf8"), "remote patched\n");
  await assert.rejects(readFile(join(gatewayRoot, "remote-codex.txt"), "utf8"), /ENOENT/);
  const patchedCard = (patched._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(patchedCard?.workspaceId, compositeId);
  assert.equal(patchedCard?.member, "compute");

  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const started = await client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: compositeId,
      member: "compute",
      cmd: `${node} -e \"console.log('remote-codex-process'); setTimeout(() => {}, 150)\"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(started.isError, undefined, resultText(started));
  const processId = structuredContent(started).processId;
  assert.equal(typeof processId, "number");
  const startedCard = (started._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(startedCard?.workspaceId, compositeId);
  assert.equal(startedCard?.member, "compute");

  const completed = await client.callTool({
    name: "write_stdin",
    arguments: { workspaceId: compositeId, member: "compute", processId, yieldTimeMs: 1_000 },
  });
  assert.equal(completed.isError, undefined, resultText(completed));
  assert.match(resultText(completed), /remote-codex-process/);
  const completedCard = (completed._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(completedCard?.workspaceId, compositeId);
  assert.equal(completedCard?.member, "compute");

  const activitySnapshot = await client.callTool({
    name: "activity_snapshot",
    arguments: { turnId },
  });
  assert.equal(activitySnapshot.isError, undefined, resultText(activitySnapshot));
  assert.equal(structuredContent(activitySnapshot).activities, undefined);
  const activityIndex = await client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  assert.equal(activityIndex.isError, undefined, resultText(activityIndex));
  const activities = structuredContent(activityIndex).activities as Array<Record<string, unknown>>;
  assert.ok(activities.some((activity) => activity.tool === "apply_patch" && activity.member === "compute"));
  assert.ok(activities.some((activity) => activity.tool === "exec_command" && activity.member === "compute"));
  assert.doesNotMatch(JSON.stringify(activityIndex), /"ws_[0-9a-f]{10}"/);
  t.after(() => rm(root, { recursive: true, force: true }));
});
