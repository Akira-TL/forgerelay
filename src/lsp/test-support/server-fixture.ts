import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../activity/history/audit-store.js";
import { BashOutputStore } from "../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../activity/history/query-service.js";
import { loadConfig, type ServerConfig } from "../../runtime/config/config.js";
import { createReviewCheckpointManager } from "../../workspaces/review/review-checkpoints.js";
import { ProcessManager } from "../../mcp/process/process-sessions.js";
import { createMcpServer } from "../../server.js";
import { SqliteWorkspaceStore } from "../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../workspaces.js";
import { CodeIntelligenceManager, type CodeIntelligenceManagerOptions } from "../runtime/manager.js";

export interface CodeIntelligenceServerFixture {
  client: Client;
  project: string;
  codeIntelligence: CodeIntelligenceManager;
  close: () => Promise<void>;
}

export async function createCodeIntelligenceServerFixture(
  t: TestContext,
  options: { codeIntelligenceOptions?: CodeIntelligenceManagerOptions } = {},
): Promise<CodeIntelligenceServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-code-intelligence-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");

  const config: ServerConfig = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_AGENT_DIR: agentDir,
    FORGERELAY_WIDGETS: "full",
    FORGERELAY_TOOL_MODE: "full",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const auditStore = new ActivityAuditStore(stateDir);
  const bashOutputStore = new BashOutputStore(stateDir);
  const hostTurnStore = new HostTurnStore(stateDir);
  const activityQueries = new ActivityQueryService(hostTurnStore, auditStore, bashOutputStore);
  const processSessions = new ProcessManager({ outputAudit: bashOutputStore });
  const activityLifecycle = new ActivityLifecycle(auditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      activityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
  const codeIntelligence = new CodeIntelligenceManager(config, options.codeIntelligenceOptions);
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
  const client = new Client({ name: "forgerelay-code-intelligence-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

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
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  });

  return { client, project, codeIntelligence, close };
}

export async function callOpen(
  client: Client,
  path: string,
  conversationScopeId: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "open_workspace",
    arguments: { path },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
}

export function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}
