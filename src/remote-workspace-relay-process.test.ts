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


void test("gateway routes remote commands, process lifecycle, and capabilities to the execution instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayHookLog = join(gatewayRoot, "bash-hooks.log");
  const remoteHookLog = join(remoteRoot, "bash-hooks.log");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(remoteRoot, "remote-marker.txt"), "execution-only\n");
  const remoteSkillRoot = join(root, "remote-skills");
  await mkdir(join(remoteSkillRoot, "remote-only"), { recursive: true });
  await writeFile(join(remoteSkillRoot, "remote-only", "SKILL.md"), [
    "---",
    "name: remote-only",
    "description: Skill advertised only by the execution ForgeRelay.",
    "---",
    "",
    "# Remote Only Skill",
    "This skill comes from the execution instance.",
  ].join("\n"));

  const bashHookConfig = (logPath: string, count = 1) => ({
    BeforeTool: Array.from({ length: count }, () => ({
      matcher: { tool: "bash" },
      command: `node -e "require('node:fs').appendFileSync('${logPath}', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`,
      timeoutSeconds: 30,
      report: false,
    })),
  });
  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-process-owner-token-long-enough",
    instanceId: "forge-relay-process-remote",
    hooks: bashHookConfig(remoteHookLog, 1),
    skillPath: remoteSkillRoot,
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-process-owner-token-long-enough",
    instanceId: "forge-relay-process-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    hooks: bashHookConfig(gatewayHookLog, 2),
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "full" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const openedStructured = structuredContent(opened);
  const workspaceId = String(openedStructured.workspaceId);
  const skills = openedStructured.skills as Array<{ name?: unknown; description?: unknown }> | undefined;
  assert.equal(skills?.some((skill) => skill.name === "remote-only"), true);
  const capabilityCatalog = openedStructured.capabilityCatalog as Array<{ name?: unknown }> | undefined;
  assert.equal(capabilityCatalog?.some((entry) => entry.name === "hooks.check"), true);
  const skillRead = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "skills://remote-only" },
  });
  assert.equal(skillRead.isError, undefined, resultText(skillRead));
  assert.match(resultText(skillRead), /execution instance/);

  const foreground = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: "node -e \"const fs=require('node:fs'); console.log(fs.readFileSync('remote-marker.txt','utf8').trim())\"",
    },
  });
  assert.equal(foreground.isError, undefined, resultText(foreground));
  assert.match(resultText(foreground), /execution-only/);

  const background = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: "node -e \"setTimeout(()=>console.log('REMOTE-BACKGROUND-DONE'), 250)\"",
      yieldTimeMs: 0,
    },
  });
  assert.equal(background.isError, undefined, resultText(background));
  const backgroundStructured = structuredContent(background);
  const processId = Number(backgroundStructured.processId);
  const outputId = String(backgroundStructured.outputId);
  assert.ok(Number.isInteger(processId) && processId > 0);
  assert.ok(outputId.length > 0);
  assert.equal(backgroundStructured.running, true);

  const waited = await client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  assert.equal(waited.isError, undefined, resultText(waited));
  assert.equal(structuredContent(waited).running, false);
  assert.match(resultText(waited), /REMOTE-BACKGROUND-DONE/);

  const durableOutput = await client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "output", outputId },
  });
  assert.equal(durableOutput.isError, undefined, resultText(durableOutput));
  assert.match(resultText(durableOutput), /REMOTE-BACKGROUND-DONE/);

  const closeGuardProcess = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: "node -e \"setInterval(()=>{},1000)\"",
      yieldTimeMs: 0,
    },
  });
  const closeGuardProcessId = Number(structuredContent(closeGuardProcess).processId);
  const blockedClose = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(blockedClose.isError, true);
  assert.match(resultText(blockedClose), /running process|process.*running/i);
  const stillRunning = await client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId: closeGuardProcessId, yieldTimeMs: 0 },
  });
  assert.equal(structuredContent(stillRunning).running, true);
  await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "process",
      processId: closeGuardProcessId,
      interrupt: true,
      yieldTimeMs: 5_000,
    },
  });

  const inputProcess = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: "node -e \"process.stdin.once('data',d=>{console.log('REMOTE-INPUT:'+d.toString().trim());process.exit(0)})\"",
      yieldTimeMs: 0,
    },
  });
  const inputProcessId = Number(structuredContent(inputProcess).processId);
  const inputResult = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "process",
      processId: inputProcessId,
      input: "hello-remote\n",
      yieldTimeMs: 5_000,
    },
  });
  assert.equal(inputResult.isError, undefined, resultText(inputResult));
  assert.match(resultText(inputResult), /REMOTE-INPUT:hello-remote/);

  const interruptProcess = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: "node -e \"setInterval(()=>{},1000)\"",
      yieldTimeMs: 0,
    },
  });
  const interruptProcessId = Number(structuredContent(interruptProcess).processId);
  const interrupted = await client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "process",
      processId: interruptProcessId,
      interrupt: true,
      yieldTimeMs: 5_000,
    },
  });
  assert.equal(structuredContent(interrupted).running, false);

  const described = await client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "hooks.check", action: "describe" },
  });
  assert.equal(described.isError, undefined, resultText(described));
  assert.match(resultText(described), /hooks\.check/i);

  const capability = await client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "hooks.check", action: "run", arguments: {} },
  });
  assert.equal(capability.isError, undefined, resultText(capability));
  const capabilityResult = structuredContent(capability).result as { globalHooks?: unknown } | undefined;
  assert.equal(capabilityResult?.globalHooks, 1);

  const codeIntelligence = await client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "code.intelligence", action: "describe" },
  });
  assert.equal(codeIntelligence.isError, undefined, resultText(codeIntelligence));
  assert.match(resultText(codeIntelligence), /code\.intelligence/i);

  const remoteHookText = (await readFile(remoteHookLog, "utf8")).replace(/\r\n/g, "\n");
  assert.match(remoteHookText, /BeforeTool:bash/);
  await assert.rejects(readFile(gatewayHookLog, "utf8"), /ENOENT/);

  const closed = await client.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));
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
    skillPath?: string;
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
    FORGERELAY_SKILLS: options.skillPath ? "1" : "0",
    ...(options.skillPath ? { FORGERELAY_SKILL_PATHS: options.skillPath } : {}),
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
