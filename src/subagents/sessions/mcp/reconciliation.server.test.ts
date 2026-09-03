import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import { loadConfig, type ServerConfig } from "../../../runtime/config/config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { ProcessManager } from "../../../mcp/process/process-sessions.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { createMcpServer } from "../../../server.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import type { SubagentRunInput } from "../../providers/contract.js";
import type { SubagentProviderRunner } from "../execution.js";
import { SubagentSessionStore } from "../store.js";
import {
  activityEventsForTool,
  readActivityAuditSnapshot,
} from "./activity-audit-test-support.js";

const previousCodexCommand = process.env.CODEX_COMMAND;
process.env.CODEX_COMMAND = process.execPath;
after(() => {
  if (previousCodexCommand === undefined) delete process.env.CODEX_COMMAND;
  else process.env.CODEX_COMMAND = previousCodexCommand;
});

const forbiddenOldPrompt = "THIS_OLD_PROMPT_MUST_NEVER_BE_REPLAYED";

test("restart reconciliation preserves live owners and interrupts stale Runs without replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-reconcile-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_AGENT_DIR: agentDir,
    FORGERELAY_WIDGETS: "full",
    FORGERELAY_TOOL_MODE: "full",
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });

  const initial = await connect(config, stateDir);
  const opened = await callOpen(initial.client, project, "reconcile-owner");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await initial.close();

  const sessionStore = new SubagentSessionStore(stateDir);
  const staleNoContinuation = sessionStore.create({
    workspaceId,
    workspaceRoot: project,
    profileName: "codex",
    provider: "codex",
    activeRun: {
      id: "run_stale_no_cont",
      startedAt: "2026-08-30T00:00:00.000Z",
      ownerId: "dead-owner-no-cont",
      ownerPid: 999_999_991,
    },
  });
  const staleWithContinuation = sessionStore.create({
    workspaceId,
    workspaceRoot: project,
    profileName: "codex",
    provider: "codex",
    activeRun: {
      id: "run_stale_with_cont",
      startedAt: "2026-08-30T00:00:01.000Z",
      ownerId: "dead-owner-with-cont",
      ownerPid: 999_999_992,
    },
  });
  sessionStore.update(staleWithContinuation.id, { providerSessionId: "thread_existing" });
  const live = sessionStore.create({
    workspaceId,
    workspaceRoot: project,
    profileName: "codex",
    provider: "codex",
    activeRun: {
      id: "run_live",
      startedAt: "2026-08-30T00:00:02.000Z",
      ownerId: "live-owner",
      ownerPid: process.pid,
    },
  });
  sessionStore.close();

  const providerInputs: SubagentRunInput[] = [];
  const runner: SubagentProviderRunner = async (_provider, input) => {
    providerInputs.push(input);
    assert.doesNotMatch(input.prompt, new RegExp(forbiddenOldPrompt));
    return {
      provider: "codex",
      providerSessionId: input.providerSessionId ?? "thread_new",
      finalResponse: "new prompt result",
    };
  };
  const restored = await connect(config, stateDir, runner, (run) =>
    run.ownerId === "live-owner" || run.ownerId?.startsWith("subagent-owner-") === true
  );
  t.after(async () => {
    await restored.close();
    await rm(root, { recursive: true, force: true });
  });

  const interruptedWithContinuation = await callSession(
    restored.client,
    workspaceId,
    { operation: "status", sessionId: staleWithContinuation.id },
  );
  assert.equal(interruptedWithContinuation.isError, undefined, allResponseText(interruptedWithContinuation));
  const staleWithValue = sessionResult(interruptedWithContinuation);
  assert.equal(staleWithValue.session.status, "idle");
  assert.equal(staleWithValue.session.latestRun.status, "interrupted");
  assert.equal(staleWithValue.session.latestRun.id, "run_stale_with_cont");
  assert.equal(staleWithValue.session.resumable, true);
  assert.equal(providerInputs.length, 0, "reconciliation must not replay a delegated prompt");

  const interruptedNoContinuation = await callSession(
    restored.client,
    workspaceId,
    { operation: "status", sessionId: staleNoContinuation.id },
  );
  const staleNoValue = sessionResult(interruptedNoContinuation);
  assert.equal(staleNoValue.session.status, "idle");
  assert.equal(staleNoValue.session.latestRun.status, "interrupted");
  assert.equal(staleNoValue.session.resumable, false);
  assert.equal(providerInputs.length, 0);

  const liveStatus = await callSession(restored.client, workspaceId, {
    operation: "status",
    sessionId: live.id,
  });
  const liveValue = sessionResult(liveStatus);
  assert.equal(liveValue.session.status, "running");
  assert.equal(liveValue.activeRun.id, "run_live");
  assert.equal(liveValue.session.latestRun, undefined);
  assert.equal(providerInputs.length, 0);

  const resumed = await callSession(restored.client, workspaceId, {
    operation: "resume",
    sessionId: staleWithContinuation.id,
    prompt: "only this new prompt may execute",
  });
  assert.equal(resumed.isError, undefined, allResponseText(resumed));
  await eventually(() => providerInputs.length === 1);
  assert.equal(providerInputs[0]?.providerSessionId, "thread_existing");
  assert.equal(providerInputs[0]?.prompt, "only this new prompt may execute");

  const activitySnapshot = readActivityAuditSnapshot(stateDir, restored.auditStore);
  const audit = JSON.stringify(activityEventsForTool(activitySnapshot, "subagent_result"));
  assert.match(audit, /interrupted/);
  assert.match(audit, /run_stale_no_cont/);
  assert.match(audit, /run_stale_with_cont/);
  assert.doesNotMatch(audit, new RegExp(forbiddenOldPrompt));
  assert.doesNotMatch(audit, /only this new prompt may execute/);
  assert.doesNotMatch(audit, /new prompt result/);
});

async function connect(
  config: ServerConfig,
  stateDir: string,
  providerRunner?: SubagentProviderRunner,
  ownerAlive?: (run: { ownerId?: string }) => boolean,
) {
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const auditStore = new ActivityAuditStore(stateDir);
  const bashOutputStore = new BashOutputStore(stateDir);
  const hostTurnStore = new HostTurnStore(stateDir);
  const activityQueries = new ActivityQueryService(hostTurnStore, auditStore, bashOutputStore);
  const processes = new ProcessManager({ outputAudit: bashOutputStore });
  const activityLifecycle = new ActivityLifecycle(auditStore, {
    turnIdForConversation: (scope, workspaceId) => activityQueries.currentTurnId(scope, workspaceId),
  });
  const code = new CodeIntelligenceManager(config);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processes,
    [],
    [],
    code,
    activityLifecycle,
    bashOutputStore,
    activityQueries,
    {
      subagentProviderRunner: providerRunner,
      subagentOwnerAlive: ownerAlive,
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-subagent-reconcile-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let closed = false;
  return {
    client,
    auditStore,
    close: async () => {
      if (closed) return;
      closed = true;
      await client.close();
      await server.close();
      await code.shutdown();
      processes.shutdown();
      hostTurnStore.close();
      bashOutputStore.close();
      auditStore.close();
      store.close();
    },
  };
}

async function callOpen(client: Client, path: string, scope: string) {
  return client.callTool({
    name: "open_workspace",
    arguments: { path },
    _meta: { "openai/session": scope },
  } as Parameters<Client["callTool"]>[0]);
}

async function callSession(client: Client, workspaceId: string, args: Record<string, unknown>) {
  return client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "subagent.session", action: "run", arguments: args },
  });
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function sessionResult(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return structuredContent(result).result as any;
}

function allResponseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content)
    ? content.flatMap((entry) =>
        typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text"
          ? [String((entry as { text?: unknown }).text ?? "")]
          : []
      ).join("\n")
    : "";
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
