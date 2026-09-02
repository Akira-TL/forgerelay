import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../activity/audit-store.js";
import { BashOutputStore } from "../activity/bash-output-store.js";
import { HostTurnStore } from "../activity/host-turn-store.js";
import { ActivityLifecycle } from "../activity/lifecycle.js";
import { ActivityQueryService } from "../activity/query-service.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { parseHookConfig, type HookConfigInput } from "../hooks.js";
import type { IncomingArtifactAdapter } from "../incoming-artifacts.js";
import { CodeIntelligenceManager } from "../lsp/runtime/manager.js";
import { ProcessManager } from "../process-sessions.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { createMcpServer } from "../server.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkspaceRegistry } from "../workspaces.js";

const execFileAsync = promisify(execFile);

export interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  store: SqliteWorkspaceStore;
  workspaces: WorkspaceRegistry;
  processSessions: ProcessManager;
  activityLifecycle: ActivityLifecycle;
  codeIntelligence: CodeIntelligenceManager;
  auditStore: ActivityAuditStore;
  bashOutputStore: BashOutputStore;
  hostTurnStore: HostTurnStore;
  activityQueries: ActivityQueryService;
  close: () => Promise<void>;
}

export interface ServerFixtureOptions {
  git?: boolean;
  env?: NodeJS.ProcessEnv;
  hooks?: HookConfigInput;
  processSessions?: ProcessManager;
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

/**
 * Build the real in-memory MCP seam used by server integration tests. The
 * fixture owns all durable stores and runtime managers so tests exercise the
 * same composition path while keeping filesystem state isolated per test.
 */
export async function fixture(
  t: TestContext,
  options: ServerFixtureOptions = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".forgerelay", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "forgerelay@example.com"]);
    await git(project, ["config", "user.name", "ForgeRelay Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const loadedConfig = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_AGENT_DIR: agentDir,
    FORGERELAY_WIDGETS: "full",
    FORGERELAY_TOOL_MODE: "full",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    ...options.env,
  });
  const config: ServerConfig = options.hooks
    ? { ...loadedConfig, hooks: parseHookConfig(options.hooks) }
    : loadedConfig;
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const auditStore = new ActivityAuditStore(stateDir);
  const bashOutputStore = new BashOutputStore(stateDir);
  let hostTurnSequence = 0;
  const hostTurnStore = new HostTurnStore(stateDir, {
    turnId: () => `turn_host_test_${++hostTurnSequence}`,
  });
  const activityQueries = new ActivityQueryService(hostTurnStore, auditStore, bashOutputStore);
  const processSessions = options.processSessions ?? new ProcessManager({ outputAudit: bashOutputStore });
  let activitySequence = 0;
  let turnSequence = 0;
  const activityLifecycle = new ActivityLifecycle(auditStore, {
    activityId: () => `act_test_${++activitySequence}`,
    turnId: () => `turn_test_${++turnSequence}`,
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
    options.incomingArtifactAdapters ?? [],
    codeIntelligence,
    activityLifecycle,
    bashOutputStore,
    activityQueries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    await codeIntelligence.shutdown();
    processSessions.shutdown();
    hostTurnStore.close();
    bashOutputStore.close();
    auditStore.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    client,
    project,
    config,
    stateDir,
    store,
    workspaces,
    processSessions,
    activityLifecycle,
    codeIntelligence,
    auditStore,
    bashOutputStore,
    hostTurnStore,
    activityQueries,
    close,
  };
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

export async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
  newWorktree?: boolean,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
      ...(newWorktree ? { newWorktree: true } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

export function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

export function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

export function allResponseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}

export async function waitForCompletedProcess(processSessions: ProcessManager): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (processSessions.stats().completed === 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processSessions.stats().completed, 1);
}

export async function waitForToolText(
  client: Client,
  params: Parameters<Client["callTool"]>[0],
  expected: RegExp,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const deadline = performance.now() + timeoutMs;
  let result = await client.callTool(params);
  while (!expected.test(allResponseText(result)) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await client.callTool(params);
  }
  return result;
}

export function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
