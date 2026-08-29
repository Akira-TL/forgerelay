import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActivityAuditStore } from "./activity/audit-store.js";
import { BashOutputStore } from "./activity/bash-output-store.js";
import { HostTurnStore } from "./activity/host-turn-store.js";
import { ActivityLifecycle } from "./activity/lifecycle.js";
import { ActivityQueryService } from "./activity/query-service.js";
import { loadConfig } from "./config.js";
import { CodeIntelligenceManager } from "./lsp/runtime/manager.js";
import { authenticateRemote, withRemoteMcpClient } from "./remote-auth.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessManager } from "./process-sessions.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

interface MutableChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

const childProcessModule = createRequire(import.meta.url)("node:child_process") as MutableChildProcessModule;

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("FORGERELAY_") && !name.startsWith("DEVSPACE_")
  ),
) as NodeJS.ProcessEnv;

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

void test("Composite Workspace mounts and explicitly routes a Workspace Relay member without fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-composite-relay-"));
  t.after(() => rm(root, { recursive: true, force: true }));

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
  assert.match(String(members[0]?.workspaceId), /^rws_/);

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

  const bootstrap = await client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "compute", context: "full" },
  });
  assert.equal(bootstrap.isError, undefined, resultText(bootstrap));
  const memberContext = structuredContent(bootstrap).memberContext as Record<string, unknown>;
  assert.equal(memberContext.member, "compute");
  assert.equal(memberContext.workspaceId, compositeId);
  assert.equal(memberContext.root, remoteRoot);
  assert.equal(typeof memberContext.contextFingerprint, "string");
  assert.ok(Array.isArray(memberContext.agentsFiles));
  assert.doesNotMatch(JSON.stringify(memberContext), /"ws_[0-9a-f]{10}"/);

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
});

void test("gateway mutates files only on the remote workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-mutations-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayHookLog = join(gatewayRoot, "file-change-hooks.log");
  const remoteHookLog = join(remoteRoot, "file-change-hooks.log");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "mutation.txt"), "gateway-must-remain\n");

  const hookConfig = (logPath: string) => ({
    AfterFileChange: [{
      command: `node -e "require('node:fs').appendFileSync(process.argv[1], process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')" "${logPath}"`,
      timeoutSeconds: 30,
      report: false,
    }],
  });
  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-mutation-owner-token-long-enough",
    instanceId: "forge-relay-mutation-remote",
    hooks: hookConfig(remoteHookLog),
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-mutation-owner-token-long-enough",
    instanceId: "forge-relay-mutation-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    hooks: hookConfig(gatewayHookLog),
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);

  const written = await client.callTool({
    name: "write",
    arguments: { workspaceId, path: "mutation.txt", content: "remote-alpha\n" },
  });
  assert.equal(written.isError, undefined, resultText(written));
  assert.equal(await readFile(join(remoteRoot, "mutation.txt"), "utf8"), "remote-alpha\n");
  assert.equal(await readFile(join(gatewayRoot, "mutation.txt"), "utf8"), "gateway-must-remain\n");

  const edited = await client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "mutation.txt",
      edits: [{ oldText: "remote-alpha", newText: "remote-beta" }],
    },
  });
  assert.equal(edited.isError, undefined, resultText(edited));
  assert.equal(await readFile(join(remoteRoot, "mutation.txt"), "utf8"), "remote-beta\n");

  const renamed = await client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "mutation.txt", newPath: "renamed.txt" },
  });
  assert.equal(renamed.isError, undefined, resultText(renamed));
  assert.equal(await readFile(join(remoteRoot, "renamed.txt"), "utf8"), "remote-beta\n");
  await assert.rejects(readFile(join(remoteRoot, "mutation.txt"), "utf8"));

  const deleted = await client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "renamed.txt" },
  });
  assert.equal(deleted.isError, undefined, resultText(deleted));
  await assert.rejects(readFile(join(remoteRoot, "renamed.txt"), "utf8"));
  assert.equal(await readFile(join(gatewayRoot, "mutation.txt"), "utf8"), "gateway-must-remain\n");
  assert.equal(
    (await readFile(remoteHookLog, "utf8")).replace(/\r\n/g, "\n"),
    [
      "AfterFileChange:write",
      "AfterFileChange:edit",
      "AfterFileChange:rename",
      "AfterFileChange:delete",
      "",
    ].join("\n"),
  );
  await assert.rejects(readFile(gatewayHookLog, "utf8"), /ENOENT/);

  const closed = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, resultText(closed));
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("remote bulk mutations preserve execution-instance preflight semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-bulk-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  const editPaths = ["bulk-a.txt", "bulk-b.txt", "bulk-c.txt"];
  await writeFile(join(remoteRoot, editPaths[0]!), "before common after\n");
  await writeFile(join(remoteRoot, editPaths[1]!), "before common after\n");
  await writeFile(join(remoteRoot, editPaths[2]!), "common and common\n");
  await mkdir(join(remoteRoot, "tree"), { recursive: true });
  await writeFile(join(remoteRoot, "tree", "child.txt"), "keep\n");
  await writeFile(join(gatewayRoot, editPaths[0]!), "gateway-unchanged\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-bulk-owner-token-long-enough",
    instanceId: "forge-relay-bulk-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-bulk-owner-token-long-enough",
    instanceId: "forge-relay-bulk-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);

  const preflightFailure = await client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      paths: editPaths,
      edits: [{ oldText: "common", newText: "changed" }],
    },
  });
  assert.equal(preflightFailure.isError, true);
  assert.match(resultText(preflightFailure), /unique|multiple|match/i);
  assert.equal(await readFile(join(remoteRoot, editPaths[0]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(remoteRoot, editPaths[1]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(remoteRoot, editPaths[2]!), "utf8"), "common and common\n");

  await writeFile(join(remoteRoot, editPaths[2]!), "before common after\n");
  const bulkEdited = await client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      paths: editPaths,
      edits: [{ oldText: "common", newText: "changed" }],
    },
  });
  assert.equal(bulkEdited.isError, undefined, resultText(bulkEdited));
  assert.equal(structuredContent(bulkEdited).status, "applied");
  for (const path of editPaths) {
    assert.equal(await readFile(join(remoteRoot, path), "utf8"), "before changed after\n");
  }
  assert.equal(await readFile(join(gatewayRoot, editPaths[0]!), "utf8"), "gateway-unchanged\n");

  const dangerousDelete = await client.callTool({
    name: "delete",
    arguments: {
      workspaceId,
      paths: ["tree", "tree/child.txt"],
      recursive: true,
    },
  });
  assert.equal(dangerousDelete.isError, true);
  assert.match(resultText(dangerousDelete), /overlap|nested|ancestor|descendant/i);
  assert.equal(await readFile(join(remoteRoot, "tree", "child.txt"), "utf8"), "keep\n");

  const bulkDeleted = await client.callTool({
    name: "delete",
    arguments: { workspaceId, paths: editPaths },
  });
  assert.equal(bulkDeleted.isError, undefined, resultText(bulkDeleted));
  assert.equal(structuredContent(bulkDeleted).status, "deleted");
  for (const path of editPaths) {
    await assert.rejects(readFile(join(remoteRoot, path), "utf8"), /ENOENT/);
  }

  const closed = await client.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("relayed workspace routes survive a new gateway instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-restart-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "restart.txt"), "remote-route-survived\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-restart-owner-token-long-enough",
    instanceId: "forge-relay-restart-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-restart-owner-token-long-enough",
    instanceId: "forge-relay-restart-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const firstClient = await startGatewayClient(t, {
    root: join(root, "gateway-first"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const opened = await firstClient.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.match(workspaceId, /^rws_/);

  const movedEndpoint = await remote.openAdditionalEndpoint();
  const movedRecord = await authenticateRemote(movedEndpoint, remote.ownerToken);
  assert.equal(movedRecord.instanceId, remoteRecord.instanceId);
  const oldRefreshToken = movedRecord.refreshToken;
  movedRecord.accessToken = "expired-after-gateway-restart";
  movedRecord.accessTokenExpiresAt = 0;
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-restart-owner-token-long-enough",
    instanceId: "forge-relay-restart-gateway",
    remotes: { workstation: movedRecord },
  }, null, 2), { mode: 0o600 });

  const restartedClient = await startGatewayClient(t, {
    root: join(root, "gateway-second"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const readAfterRestart = await restartedClient.callTool({
    name: "read",
    arguments: { workspaceId, path: "restart.txt" },
  });
  assert.equal(readAfterRestart.isError, undefined, resultText(readAfterRestart));
  assert.match(resultText(readAfterRestart), /remote-route-survived/);
  const refreshedAuth = JSON.parse(await readFile(join(gatewayConfigDir, "auth.json"), "utf8")) as {
    remotes?: Record<string, {
      instanceId: string;
      target: string;
      accessToken: string;
      refreshToken: string;
    }>;
  };
  const refreshedRemote = refreshedAuth.remotes?.workstation;
  assert.ok(refreshedRemote);
  assert.equal(refreshedRemote.instanceId, remoteRecord.instanceId);
  assert.equal(refreshedRemote.target, movedEndpoint);
  assert.notEqual(refreshedRemote.accessToken, "expired-after-gateway-restart");
  assert.notEqual(refreshedRemote.refreshToken, oldRefreshToken);

  const closed = await restartedClient.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, resultText(closed));
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("concurrent gateway sessions preserve every relayed workspace route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-concurrent-routes-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const remoteA = join(remoteRoot, "a");
  const remoteB = join(remoteRoot, "b");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteA, { recursive: true });
  await mkdir(remoteB, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteA, "route.txt"), "route-a\n");
  await writeFile(join(remoteB, "route.txt"), "route-b\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-concurrent-route-owner-token-long-enough",
    instanceId: "forge-relay-concurrent-route-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-concurrent-route-owner-token-long-enough",
    instanceId: "forge-relay-concurrent-route-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const clientA = await startGatewayClient(t, {
    root: join(root, "gateway-a"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const clientB = await startGatewayClient(t, {
    root: join(root, "gateway-b"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });

  const openedA = await clientA.callTool({
    name: "open_workspace",
    arguments: { path: remoteA, relay: "workstation", context: "none" },
  });
  assert.equal(openedA.isError, undefined, resultText(openedA));
  const workspaceA = String(structuredContent(openedA).workspaceId);

  const openedB = await clientB.callTool({
    name: "open_workspace",
    arguments: { path: remoteB, relay: "workstation", context: "none" },
  });
  assert.equal(openedB.isError, undefined, resultText(openedB));
  const workspaceB = String(structuredContent(openedB).workspaceId);
  assert.notEqual(workspaceA, workspaceB);

  const restartedClient = await startGatewayClient(t, {
    root: join(root, "gateway-restarted"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const readA = await restartedClient.callTool({
    name: "read",
    arguments: { workspaceId: workspaceA, path: "route.txt" },
  });
  const readB = await restartedClient.callTool({
    name: "read",
    arguments: { workspaceId: workspaceB, path: "route.txt" },
  });
  assert.equal(readA.isError, undefined, resultText(readA));
  assert.equal(readB.isError, undefined, resultText(readB));
  assert.match(resultText(readA), /route-a/);
  assert.match(resultText(readB), /route-b/);
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("ssh-routed relayed workspace rebuilds fresh tunnels across gateway instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-ssh-restart-"));

  const sshLog = join(root, "ssh.log");
  await installFakeSsh(t, root, sshLog);

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "ssh-restart.txt"), "ssh-route-survived\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  remoteRecord.sshRoute = ["jump@example.test", "target@example.test"];
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const firstClient = await startGatewayClient(t, {
    root: join(root, "gateway-first"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const opened = await firstClient.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.match(workspaceId, /^rws_/);

  const firstRead = await firstClient.callTool({
    name: "read",
    arguments: { workspaceId, path: "ssh-restart.txt" },
  });
  assert.equal(firstRead.isError, undefined, resultText(firstRead));
  const routeStateText = await readFile(
    join(gatewayStateDir, "remote-workspace-routes.json"),
    "utf8",
  );
  assert.match(routeStateText, new RegExp(remoteRecord.instanceId));
  assert.doesNotMatch(routeStateText, /workstation|jump@example\.test|target@example\.test/);
  assert.doesNotMatch(routeStateText, new RegExp(remote.endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-gateway",
    remotes: { renamed: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const restartedClient = await startGatewayClient(t, {
    root: join(root, "gateway-second"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const restartedRead = await restartedClient.callTool({
    name: "read",
    arguments: { workspaceId, path: "ssh-restart.txt" },
  });
  assert.equal(restartedRead.isError, undefined, resultText(restartedRead));
  assert.match(resultText(restartedRead), /ssh-route-survived/);

  const sshCalls = (await readFile(sshLog, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const forwardPorts = sshCalls.flatMap((args) => {
    const index = args.indexOf("-L");
    if (index < 0 || !args[index + 1]) return [];
    const match = /^127\.0\.0\.1:(\d+):/.exec(args[index + 1]!);
    return match ? [Number(match[1])] : [];
  });
  assert.ok(forwardPorts.length >= 3, JSON.stringify(sshCalls));
  assert.equal(new Set(forwardPorts).size, forwardPorts.length);
  assert.ok(sshCalls.every((args) => args.includes("jump@example.test") && args.includes("target@example.test")));

  const closed = await restartedClient.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("single-target SSH relay executes a remote workspace without ProxyJump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-ssh-single-"));

  const sshLog = join(root, "ssh.log");
  await installFakeSsh(t, root, sshLog);

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "single-ssh.txt"), "single-target-ssh-workspace\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-single-ssh-owner-token-long-enough",
    instanceId: "forge-relay-single-ssh-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  remoteRecord.sshRoute = ["target@example.test"];
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-single-ssh-owner-token-long-enough",
    instanceId: "forge-relay-single-ssh-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);

  const read = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "single-ssh.txt" },
  });
  assert.equal(read.isError, undefined, resultText(read));
  assert.match(resultText(read), /single-target-ssh-workspace/);

  const closed = await client.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));

  const sshCalls = (await readFile(sshLog, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const forwardCalls = sshCalls.filter((args) => args.includes("-L"));
  assert.ok(forwardCalls.length >= 3, JSON.stringify(sshCalls));
  assert.ok(forwardCalls.every((args) => args.includes("target@example.test")));
  assert.ok(forwardCalls.every((args) => !args.includes("-J")), JSON.stringify(sshCalls));
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("relayed open failures are explicit and never fall back to the gateway filesystem", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-errors-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const rejectedRoot = join(root, "remote-rejected");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(rejectedRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "sentinel.txt"), "gateway-fallback-must-not-run\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-error-owner-token-long-enough",
    instanceId: "forge-relay-error-remote",
  });
  const validRemote = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-error-owner-token-long-enough",
    instanceId: "forge-relay-error-gateway",
    remotes: {
      workstation: {
        ...validRemote,
        accessToken: "invalid-access-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      "bad-auth": {
        ...validRemote,
        instanceId: "forge-bad-auth-record",
        accessToken: "invalid-access-token",
        refreshToken: "invalid-refresh-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      offline: {
        instanceId: "forge-offline-test",
        target: "http://127.0.0.1:9",
        accessToken: "offline-access-token",
        refreshToken: "offline-refresh-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "devspace",
      },
    },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });

  const unknown = await client.callTool({
    name: "open_workspace",
    arguments: { path: gatewayRoot, relay: "missing", context: "none" },
  });
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /unknown remote relay alias: missing/i);

  const rejected = await client.callTool({
    name: "open_workspace",
    arguments: { path: rejectedRoot, relay: "workstation", context: "none" },
  });
  assert.equal(rejected.isError, true);
  assert.match(resultText(rejected), /remote forgerelay workstation open_workspace failed/i);
  assert.match(resultText(rejected), /outside allowed roots/i);
  assert.doesNotMatch(resultText(rejected), /gateway-fallback-must-not-run/);

  const badAuth = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "bad-auth", context: "none" },
  });
  assert.equal(badAuth.isError, true);
  assert.match(resultText(badAuth), /authentication|unauthorized|invalid|remote forgerelay/i);

  const offline = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "offline", context: "none" },
  });
  assert.equal(offline.isError, true);
  assert.match(resultText(offline), /remote forgerelay offline request failed/i);
  assert.doesNotMatch(resultText(offline), /gateway-fallback-must-not-run/);
  t.after(() => rm(root, { recursive: true, force: true }));
});

interface RunningForge {
  endpoint: string;
  ownerToken: string;
  openAdditionalEndpoint(): Promise<string>;
}

async function startForge(
  t: TestContext,
  options: {
    root: string;
    allowedRoot: string;
    ownerToken: string;
    instanceId: string;
    existingConfigDir?: string;
    hooks?: unknown;
  },
): Promise<RunningForge> {
  const configDir = options.existingConfigDir ?? join(options.root, "config");
  const stateDir = join(options.root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  if (!options.existingConfigDir) {
    await writeFile(join(configDir, "auth.json"), JSON.stringify({
      ownerToken: options.ownerToken,
      instanceId: options.instanceId,
    }, null, 2), { mode: 0o600 });
  }
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [options.allowedRoot],
    publicBaseUrl: "http://127.0.0.1:7676",
    stateDir,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  }, null, 2));

  const env = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
  const running = createServer(loadConfig(env));
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  t.after(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
  });
  return {
    endpoint: `http://127.0.0.1:${port}`,
    ownerToken: options.ownerToken,
    openAdditionalEndpoint: async () => {
      const additionalServer = running.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => additionalServer.once("listening", resolve));
      const additionalPort = (additionalServer.address() as AddressInfo).port;
      t.after(() => new Promise<void>((resolve) => additionalServer.close(() => resolve())));
      return `http://127.0.0.1:${additionalPort}`;
    },
  };
}

async function startGatewayClient(
  t: TestContext,
  options: { root: string; allowedRoot: string; configDir: string; stateDir?: string; hooks?: unknown },
): Promise<Client> {
  const stateDir = options.stateDir ?? join(options.root, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(options.configDir, "config.json"), JSON.stringify({
    allowedRoots: [options.allowedRoot],
    stateDir,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  }, null, 2));
  const config = loadConfig({
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: options.configDir,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  });
  const workspaceStore = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const auditStore = new ActivityAuditStore(stateDir);
  const bashOutputStore = new BashOutputStore(stateDir);
  const hostTurnStore = new HostTurnStore(stateDir);
  const activityQueries = new ActivityQueryService(hostTurnStore, auditStore, bashOutputStore);
  const processSessions = new ProcessManager({ outputAudit: bashOutputStore });
  const activityLifecycle = new ActivityLifecycle(auditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      activityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
  const codeIntelligence = new CodeIntelligenceManager(config);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    [],
    [],
    codeIntelligence,
    activityLifecycle,
    bashOutputStore,
    activityQueries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-workspace-relay-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await codeIntelligence.shutdown();
    processSessions.shutdown();
    hostTurnStore.close();
    bashOutputStore.close();
    auditStore.close();
    workspaceStore.close();
  });
  return client;
}

async function installFakeSsh(t: TestContext, root: string, sshLog: string): Promise<void> {
  const fakeSshPath = join(root, "fake-ssh.cjs");
  await writeFile(fakeSshPath, fakeSshRelaySource());
  const originalSpawn = childProcessModule.spawn;
  childProcessModule.spawn = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
  ) => {
    if (command !== "ssh") return originalSpawn(command, args, options);
    return originalSpawn(process.execPath, [fakeSshPath, ...args], {
      ...options,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        TEST_SSH_LOG: sshLog,
      },
    });
  }) as typeof childProcessModule.spawn;
  syncBuiltinESMExports();
  t.after(() => {
    childProcessModule.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
}

function fakeSshRelaySource(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_SSH_LOG, JSON.stringify(args) + "\\n");
const forwardIndex = args.indexOf("-L");
const forward = forwardIndex >= 0 ? args[forwardIndex + 1] : undefined;
if (!forward) {
  process.stderr.write("fake ssh: missing -L\\n");
  process.exit(40);
}
const match = /^127\\.0\\.0\\.1:(\\d+):([^:]+):(\\d+)$/.exec(forward);
if (!match) {
  process.stderr.write("fake ssh: invalid forward " + forward + "\\n");
  process.exit(41);
}
const localPort = Number(match[1]);
const remoteHost = match[2];
const remotePort = Number(match[3]);
const sockets = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect(remotePort, remoteHost);
  sockets.add(client);
  sockets.add(upstream);
  client.on("close", () => sockets.delete(client));
  upstream.on("close", () => sockets.delete(upstream));
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (error) => {
  process.stderr.write(String(error) + "\\n");
  process.exit(42);
});
server.listen(localPort, "127.0.0.1", () => {
  process.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port " + localPort + ".\\n");
});
const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const parsed = parseToolResult(result);
  assert.ok(parsed.structuredContent);
  return parsed.structuredContent as Record<string, unknown>;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const parsed = parseToolResult(result);
  return (parsed.content ?? [])
    .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): CallToolResult {
  return CallToolResultSchema.parse(result);
}
