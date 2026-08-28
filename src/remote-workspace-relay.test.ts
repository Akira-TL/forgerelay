import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("FORGERELAY_") && !name.startsWith("DEVSPACE_")
  ),
) as NodeJS.ProcessEnv;

void test("gateway opens, reads, and closes a workspace on a direct remote ForgeRelay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-"));
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
});

void test("gateway mutates files only on the remote workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-mutations-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayHookLog = join(gatewayRoot, "file-change-hooks.log");
  const remoteHookLog = join(remoteRoot, "file-change-hooks.log");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "mutation.txt"), "gateway-must-remain\n");

  const hookConfig = (logPath: string) => ({
    AfterFileChange: [{
      command: `node -e "require('node:fs').appendFileSync('${logPath}', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`,
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
});

void test("remote bulk mutations preserve execution-instance preflight semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-bulk-"));
  t.after(() => rm(root, { recursive: true, force: true }));

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
});

void test("relayed open failures are explicit and never fall back to the gateway filesystem", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));

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
});

interface RunningForge {
  endpoint: string;
  ownerToken: string;
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
  };
}

async function startGatewayClient(
  t: TestContext,
  options: { root: string; allowedRoot: string; configDir: string; hooks?: unknown },
): Promise<Client> {
  const stateDir = join(options.root, "state");
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
