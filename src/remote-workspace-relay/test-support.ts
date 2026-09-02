import assert from "node:assert/strict";
import { execFileSync, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActivityAuditStore } from "../activity/audit-store.js";
import { BashOutputStore } from "../activity/bash-output-store.js";
import { HostTurnStore } from "../activity/host-turn-store.js";
import { ActivityLifecycle } from "../activity/lifecycle.js";
import { ActivityQueryService } from "../activity/query-service.js";
import { loadConfig } from "../config.js";
import { CodeIntelligenceManager } from "../lsp/runtime/manager.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { ProcessManager } from "../process-sessions.js";
import { createMcpServer, createServer } from "../server.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";

interface MutableChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

const childProcessModule = createRequire(import.meta.url)("node:child_process") as MutableChildProcessModule;
const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

export async function setupGitRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "ForgeRelay Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "forgerelay-test@example.invalid"], { cwd: root });
  await writeFile(join(root, "README.md"), "relay worktree fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "TEST: (relay) initialize worktree fixture"], { cwd: root, stdio: "ignore" });
}

interface RunningForge {
  endpoint: string;
  ownerToken: string;
  openAdditionalEndpoint(): Promise<string>;
}

export async function startForge(
  t: TestContext,
  options: {
    root: string;
    allowedRoot: string;
    ownerToken: string;
    instanceId: string;
    existingConfigDir?: string;
    hooks?: unknown;
    toolMode?: "minimal" | "full" | "codex";
    taskReminderInterval?: number;
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
    worktreeRoot: join(options.root, "worktrees"),
    ...(options.taskReminderInterval !== undefined ? { taskReminderInterval: options.taskReminderInterval } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  }, null, 2));

  const env = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_TOOL_MODE: options.toolMode ?? "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
  const running = createServer(loadConfig(env));
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  t.after(async () => {
    await running.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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

export async function startGatewayClient(
  t: TestContext,
  options: {
    root: string;
    allowedRoot: string;
    configDir: string;
    stateDir?: string;
    hooks?: unknown;
    toolMode?: "minimal" | "full" | "codex";
  },
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
    FORGERELAY_TOOL_MODE: options.toolMode ?? "minimal",
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

export async function installFakeSsh(t: TestContext, root: string, sshLog: string): Promise<void> {
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

export function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const parsed = parseToolResult(result);
  assert.ok(parsed.structuredContent);
  return parsed.structuredContent as Record<string, unknown>;
}

export function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const parsed = parseToolResult(result);
  return (parsed.content ?? [])
    .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): CallToolResult {
  return CallToolResultSchema.parse(result);
}
