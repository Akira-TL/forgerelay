import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authenticateRemote, withRemoteMcpClient } from "../auth/remote-auth.js";
import { safeManagedWorktreeRecovery } from "../result-support.js";
import {
  installFakeSsh,
  resultText,
  setupGitRepository,
  startForge,
  startGatewayClient,
  structuredContent,
} from "./test-support.js";

void test("recovery relay sanitization strips unrecognized remote fields", () => {
  assert.deepEqual(safeManagedWorktreeRecovery({
    classification: "healthy",
    conditions: [],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "matching",
    remoteWorkspaceId: "ws_secret",
    credential: "must-not-cross-gateway",
  }), {
    classification: "healthy",
    conditions: [],
    backing: "present",
    source: "available",
    gitRegistration: "registered",
    managedBranch: "present",
    targetBranch: "present",
    backingBranch: "matching",
  });
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
