import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/audit-store.js";
import { BashOutputStore } from "../../../activity/bash-output-store.js";
import { HostTurnStore } from "../../../activity/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/lifecycle.js";
import { ActivityQueryService } from "../../../activity/query-service.js";
import { loadConfig } from "../../../config.js";
import { openDatabase } from "../../../db/client.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { ProcessManager } from "../../../process-sessions.js";
import { authenticateRemote } from "../../../remote-auth.js";
import { createReviewCheckpointManager } from "../../../review-checkpoints.js";
import { createMcpServer, createServer } from "../../../server.js";
import { SqliteWorkspaceStore } from "../../../workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import { SubagentSessionStore } from "../store.js";

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !key.startsWith("FORGERELAY_") && !key.startsWith("DEVSPACE_") && key !== "PORT" && key !== "HOST"
  ),
) as NodeJS.ProcessEnv;

test("Relay and Composite keep Subagent Session state on the Execution ForgeRelay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-routing-test-"));
  const remoteRoot = join(root, "execution-workspace");
  const gatewayRoot = join(root, "gateway-workspace");
  const remoteConfigDir = join(root, "execution", "config");
  const remoteStateDir = join(root, "execution", "state");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  await Promise.all([
    mkdir(remoteRoot, { recursive: true }),
    mkdir(gatewayRoot, { recursive: true }),
    mkdir(remoteConfigDir, { recursive: true }),
    mkdir(remoteStateDir, { recursive: true }),
    mkdir(gatewayConfigDir, { recursive: true }),
    mkdir(gatewayStateDir, { recursive: true }),
  ]);
  await writeFile(join(remoteRoot, "AGENTS.md"), "execution instructions\n");
  await writeFile(join(gatewayRoot, "AGENTS.md"), "gateway instructions\n");
  const providerHistoryMarker = join(remoteRoot, ".provider-native-history");
  await writeFile(providerHistoryMarker, "provider history is not ForgeRelay state\n");

  const remoteOwner = "routing-execution-owner-token-long-enough";
  await writeFile(join(remoteConfigDir, "auth.json"), JSON.stringify({
    ownerToken: remoteOwner,
    instanceId: "routing-execution-7678",
  }, null, 2), { mode: 0o600 });
  await writeFile(join(remoteConfigDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7678,
    publicBaseUrl: "http://127.0.0.1:7678",
    allowedRoots: [remoteRoot],
    stateDir: remoteStateDir,
  }, null, 2));
  const remoteConfig = loadConfig({
    ...cleanEnv,
    FORGERELAY_CONFIG_DIR: remoteConfigDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_TOOL_MODE: "minimal",
  });
  const remote = createServer(remoteConfig);
  const remoteHttp = remote.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => remoteHttp.once("listening", resolve));
  const endpoint = `http://127.0.0.1:${(remoteHttp.address() as AddressInfo).port}`;
  const remoteRecord = await authenticateRemote(endpoint, remoteOwner);

  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "routing-gateway-owner-token-long-enough",
    instanceId: "routing-gateway-7677",
    remotes: { execution: remoteRecord },
  }, null, 2), { mode: 0o600 });
  await writeFile(join(gatewayConfigDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7677,
    publicBaseUrl: "http://127.0.0.1:7677",
    allowedRoots: [gatewayRoot],
    stateDir: gatewayStateDir,
  }, null, 2));
  const gatewayConfig = loadConfig({
    ...cleanEnv,
    FORGERELAY_CONFIG_DIR: gatewayConfigDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_TOOL_MODE: "minimal",
  });
  const gateway = await connectGateway(gatewayConfig, gatewayStateDir);
  t.after(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => remoteHttp.close(() => resolve()));
    await remote.close();
    await rm(root, { recursive: true, force: true });
  });

  await gateway.client.listTools(); // Prime MCP output-schema validation before Composite remapping.

  const relayedOpen = await gateway.client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "execution", context: "full" },
  });
  assert.equal(relayedOpen.isError, undefined, text(relayedOpen));
  const gatewayWorkspaceId = String(structured(relayedOpen).workspaceId);
  const catalog = structured(relayedOpen).capabilityCatalog as Array<{ name?: string }>;
  assert.equal(catalog.some((entry) => entry.name === "subagent.session"), true);

  const routes = JSON.parse(
    await readFile(join(gatewayStateDir, "remote-workspace-routes.json"), "utf8"),
  ) as Array<{ gatewayWorkspaceId: string; remoteWorkspaceId: string }>;
  const remoteWorkspaceId = routes.find((route) => route.gatewayWorkspaceId === gatewayWorkspaceId)?.remoteWorkspaceId;
  assert.ok(remoteWorkspaceId);

  const remoteSessions = new SubagentSessionStore(remoteStateDir);
  const seeded = remoteSessions.create({
    workspaceId: remoteWorkspaceId,
    workspaceRoot: remoteRoot,
    profileName: "codex",
    provider: "codex",
  });
  remoteSessions.update(seeded.id, { providerSessionId: "provider-thread-routing" });
  remoteSessions.close();

  const relayedList = await callSession(gateway.client, gatewayWorkspaceId, { operation: "list" });
  assert.equal(relayedList.isError, undefined, text(relayedList));
  assert.deepEqual(
    (structured(relayedList).result as { sessions: Array<{ id: string }> }).sessions.map((entry) => entry.id),
    [seeded.id],
  );
  assert.equal(sessionCount(gatewayStateDir), 0);
  assert.equal(sessionCount(remoteStateDir), 1);

  const localOpen = await gateway.client.callTool({
    name: "open_workspace",
    arguments: { path: gatewayRoot, context: "full" },
  });
  const localWorkspaceId = String(structured(localOpen).workspaceId);
  const composite = await gateway.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "subagent-routing" },
  });
  const compositeId = String(structured(composite).workspaceId);
  await gateway.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "remote", purpose: "Execution member", workspaceId: gatewayWorkspaceId },
    },
  });
  await gateway.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "local", purpose: "Gateway-local member", workspaceId: localWorkspaceId },
    },
  });

  const missingMember = await callSession(gateway.client, compositeId, { operation: "list" });
  assert.equal(missingMember.isError, true);
  assert.match(text(missingMember), /requires member/i);

  const panel = await gateway.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  const turnId = String(structured(panel).turnId);
  const compositeStatus = await callSession(
    gateway.client,
    compositeId,
    { operation: "status", sessionId: seeded.id },
    "remote",
  );
  assert.equal(compositeStatus.isError, undefined, text(compositeStatus));
  assert.equal((structured(compositeStatus).result as { session: { id: string } }).session.id, seeded.id);

  const wrongMember = await callSession(
    gateway.client,
    compositeId,
    { operation: "status", sessionId: seeded.id },
    "local",
  );
  assert.equal(wrongMember.isError, true);
  assert.match(text(wrongMember), /session_not_found|Unknown Subagent Session/i);

  const snapshot = await gateway.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId },
  });
  const activities = structured(snapshot).activities as Array<{ tool?: string; member?: string }>;
  assert.equal(activities.some((activity) => activity.tool === "capability" && activity.member === "remote"), true);

  const deleted = await callSession(gateway.client, gatewayWorkspaceId, {
    operation: "delete",
    sessionId: seeded.id,
  });
  assert.equal(deleted.isError, undefined, text(deleted));
  assert.equal(sessionCount(gatewayStateDir), 0);
  assert.equal(sessionCount(remoteStateDir), 0);
  assert.equal(await readFile(providerHistoryMarker, "utf8"), "provider history is not ForgeRelay state\n");
});

function sessionCount(stateDir: string): number {
  const db = openDatabase(stateDir);
  try {
    return Number((db.sqlite.prepare("select count(*) as count from local_agent_sessions").get() as { count: number }).count);
  } finally {
    db.close();
  }
}

async function connectGateway(config: ReturnType<typeof loadConfig>, stateDir: string) {
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const audit = new ActivityAuditStore(stateDir);
  const bash = new BashOutputStore(stateDir);
  const turns = new HostTurnStore(stateDir);
  const queries = new ActivityQueryService(turns, audit, bash);
  const processes = new ProcessManager({ outputAudit: bash });
  const lifecycle = new ActivityLifecycle(audit, {
    turnIdForConversation: (scope, workspaceId) => queries.currentTurnId(scope, workspaceId),
  });
  const code = new CodeIntelligenceManager(config);
  const server = createMcpServer(
    config, workspaces, createReviewCheckpointManager(), processes, [], [], code, lifecycle, bash, queries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-subagent-routing-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      await code.shutdown();
      processes.shutdown();
      turns.close();
      bash.close();
      audit.close();
      store.close();
    },
  };
}

async function callSession(
  client: Client,
  workspaceId: string,
  args: Record<string, unknown>,
  member?: string,
) {
  return client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      ...(member ? { member } : {}),
      name: "subagent.session",
      action: "run",
      arguments: args,
    },
  });
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.flatMap((entry) =>
        typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text"
          ? [String((entry as { text?: unknown }).text ?? "")]
          : []
      ).join("\n")
    : "";
}
