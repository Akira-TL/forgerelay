import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { loadConfig, type ServerConfig } from "../../../config.js";
import { openDatabase } from "../../../db/client.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { ProcessManager } from "../../../process-sessions.js";
import { createReviewCheckpointManager } from "../../../review-checkpoints.js";
import { createMcpServer } from "../../../server.js";
import { SqliteWorkspaceStore } from "../../../workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import type { SubagentRunInput } from "../../providers/contract.js";
import type { SubagentProviderRunner } from "../execution.js";

const canonicalToolNames = [
  "open_workspace",
  "activity_panel",
  "activity_snapshot",
  "activity_detail",
  "activity_output",
  "capability",
  "close_workspace",
  "read",
  "write",
  "edit",
  "rename",
  "delete",
  "bash",
] as const;

test("subagent.session tracer launches through capability without persisting conversation payloads", async (t) => {
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const providerInputs: SubagentRunInput[] = [];
  const secretPrompt = "SECRET delegated prompt must never enter SQLite";
  const secretFinalResponse = "SECRET final response must be delivered, not persisted in SQLite";
  const secretProviderError = "SECRET provider error must be delivered, not persisted in SQLite";
  const context = await fixture(t, async (_provider, input) => {
    providerInputs.push(input);
    await providerGate;
    if (input.prompt.includes("FAIL_PROVIDER")) throw new Error(secretProviderError);
    return {
      provider: "codex",
      providerSessionId: "codex-thread-test-1",
      finalResponse: secretFinalResponse,
    };
  });

  const tools = await context.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), canonicalToolNames);
  assert.equal(tools.tools.some((tool) => tool.name.startsWith("subagent_")), false);

  const opened = await callOpen(context.client, context.project, "subagent-capability-chat");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{
    name: string;
    batchPolicy: string;
    guide: { name: string };
  }>;
  const subagentCapability = catalog.find((entry) => entry.name === "subagent.session");
  assert.deepEqual(subagentCapability, {
    name: "subagent.session",
    description: "Coordinate provider-backed Subagent Sessions in the current Execution Workspace.",
    available: true,
    batchPolicy: "unsupported",
    guide: {
      name: "subagents",
      path: (subagentCapability as { guide?: { path?: string } } | undefined)?.guide?.path,
      readBeforeFirstUse: true,
    },
  });

  const started = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "start", target: "reviewer", prompt: secretPrompt },
    },
  });
  assert.equal(started.isError, undefined, responseText(started));
  const startResult = structuredContent(started).result as {
    operation: string;
    session: Record<string, unknown>;
    run: Record<string, unknown>;
  };
  assert.equal(startResult.operation, "start");
  assert.equal(startResult.session.status, "running");
  assert.equal(startResult.session.profileName, "reviewer");
  assert.equal(startResult.session.provider, "codex");
  assert.match(String(startResult.session.id), /^agt_/);
  assert.match(String(startResult.run.id), /^run_/);
  assert.equal(startResult.run.status, "running");
  const sessionId = String(startResult.session.id);
  const runId = String(startResult.run.id);

  await eventually(() => providerInputs.length === 1);
  assert.match(providerInputs[0]?.prompt ?? "", /Review changes\./);
  assert.match(providerInputs[0]?.prompt ?? "", new RegExp(secretPrompt));

  const status = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "status", sessionId },
    },
  });
  assert.equal(status.isError, undefined, responseText(status));
  const statusResult = structuredContent(status).result as {
    operation: string;
    session: Record<string, unknown>;
    activeRun?: Record<string, unknown>;
  };
  assert.equal(statusResult.operation, "status");
  assert.equal(statusResult.session.status, "running");
  assert.equal(statusResult.activeRun?.id, runId);

  const listed = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "list" },
    },
  });
  assert.equal(listed.isError, undefined, responseText(listed));
  const listResult = structuredContent(listed).result as {
    operation: string;
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(listResult.operation, "list");
  assert.deepEqual(listResult.sessions.map((session) => session.id), [sessionId]);

  releaseProvider();
  const delivered = await waitForDelivery(
    context.client,
    workspaceId,
    secretFinalResponse,
  );
  assert.equal(delivered, true, "completed Subagent response should be delivered once");

  const afterDelivery = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "list" },
    },
  });
  assert.doesNotMatch(allResponseText(afterDelivery), new RegExp(secretFinalResponse));

  const failedStart = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: {
        operation: "start",
        target: "reviewer",
        prompt: "FAIL_PROVIDER without persisting the provider error body",
      },
    },
  });
  assert.equal(failedStart.isError, undefined, allResponseText(failedStart));
  const failureDelivered = await waitForDelivery(
    context.client,
    workspaceId,
    secretProviderError,
  );
  assert.equal(failureDelivered, true, "failed Subagent error should be delivered once");

  const sqlite = openDatabase(context.stateDir);
  try {
    const activityRows = sqlite.sqlite.prepare(
      "select activity_id, event_type, tool, request_json, result_json, error from activity_audit_events order by rowid",
    ).all() as Array<{
      activity_id: string;
      event_type: string;
      tool: string | null;
      request_json: string | null;
      result_json: string | null;
      error: string | null;
    }>;
    const persistedActivity = JSON.stringify(activityRows);
    assert.doesNotMatch(persistedActivity, new RegExp(secretPrompt));
    assert.doesNotMatch(persistedActivity, /Review changes\./);
    assert.doesNotMatch(persistedActivity, new RegExp(secretFinalResponse));
    assert.doesNotMatch(persistedActivity, new RegExp(secretProviderError));
    const linkedStarted = activityRows.find((row) => row.tool === "subagent_result");
    assert.ok(linkedStarted);
    assert.match(linkedStarted.request_json ?? "", new RegExp(sessionId));
    assert.match(linkedStarted.request_json ?? "", new RegExp(runId));
    const linkedFinished = activityRows.find((row) =>
      row.activity_id === linkedStarted.activity_id && row.event_type === "succeeded"
    );
    assert.ok(linkedFinished);
    assert.match(linkedFinished.result_json ?? "", /succeeded/);
    const linkedActivityIds = new Set(
      activityRows.filter((row) => row.tool === "subagent_result").map((row) => row.activity_id),
    );
    const failedLinked = activityRows.find((row) =>
      row.event_type === "failed" && linkedActivityIds.has(row.activity_id)
    );
    assert.equal(failedLinked?.error, "Subagent Run failed.");

    const sessionRow = sqlite.sqlite.prepare(
      "select latest_response, hook_reports_json, error from local_agent_sessions where id = ?",
    ).get(sessionId) as {
      latest_response: string | null;
      hook_reports_json: string | null;
      error: string | null;
    };
    assert.equal(sessionRow.latest_response, null);
    assert.equal(sessionRow.hook_reports_json, null);
    assert.equal(sessionRow.error, null);
  } finally {
    sqlite.close();
  }
});

test("subagent completion mailbox survives server restart and is delivered once", async (t) => {
  const secretFinalResponse = "restart durable Subagent completion";
  const context = await fixture(t, async () => ({
    provider: "codex",
    providerSessionId: "codex-thread-restart",
    finalResponse: secretFinalResponse,
  }));
  const opened = await callOpen(context.client, context.project, "subagent-restart-chat");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const started = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: {
        operation: "start",
        target: "reviewer",
        prompt: "Produce one durable completion.",
      },
    },
    _meta: { "openai/session": "subagent-restart-chat" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(started.isError, undefined, allResponseText(started));
  assert.doesNotMatch(allResponseText(started), new RegExp(secretFinalResponse));
  const startedValue = structuredContent(started).result as {
    session: { id: string };
    run: { id: string };
  };
  const mailboxPath = join(context.stateDir, "subagent-delivery", `${startedValue.session.id}.json`);
  await waitForFile(mailboxPath);

  await context.close();
  const restored = await restoreFixture(t, context.config, context.stateDir);
  const restoredOpen = await callOpen(restored.client, context.project, "subagent-restart-chat");
  assert.equal(structuredContent(restoredOpen).workspaceId, workspaceId);
  assert.doesNotMatch(allResponseText(restoredOpen), new RegExp(secretFinalResponse));
  await stat(mailboxPath);

  const delivered = await restored.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "status", sessionId: startedValue.session.id },
    },
  });
  assert.equal(delivered.isError, undefined, allResponseText(delivered));
  assert.match(allResponseText(delivered), new RegExp(secretFinalResponse));
  await assert.rejects(stat(mailboxPath), /ENOENT/);

  const listed = await restored.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: { operation: "list" },
    },
  });
  assert.equal(listed.isError, undefined, allResponseText(listed));
  assert.doesNotMatch(allResponseText(listed), new RegExp(secretFinalResponse));
  const sessions = (structuredContent(listed).result as { sessions: Array<{ id: string }> }).sessions;
  assert.deepEqual(sessions.map((session) => session.id), [startedValue.session.id]);

  // Close the restarted server before the fixture-level temp-directory cleanup.
  // Windows refuses to unlink SQLite files while the restored handles remain open.
  await restored.close();
});

interface SubagentServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  close(): Promise<void>;
}

async function fixture(
  t: TestContext,
  subagentProviderRunner: SubagentProviderRunner,
): Promise<SubagentServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const connected = await connectFixture(config, stateDir, subagentProviderRunner);
  t.after(async () => {
    await connected.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...connected, project, config, stateDir };
}

async function restoreFixture(
  t: TestContext,
  config: ServerConfig,
  stateDir: string,
): Promise<Omit<SubagentServerFixture, "project" | "config" | "stateDir">> {
  const restored = await connectFixture(config, stateDir);
  t.after(restored.close);
  return restored;
}

async function connectFixture(
  config: ServerConfig,
  stateDir: string,
  subagentProviderRunner?: SubagentProviderRunner,
): Promise<{ client: Client; close(): Promise<void> }> {
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
    { subagentProviderRunner },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-subagent-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let closed = false;
  return {
    client,
    close: async () => {
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
    },
  };
}

async function callOpen(client: Client, path: string, conversationScopeId: string) {
  return client.callTool({
    name: "open_workspace",
    arguments: { path },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return allResponseText(result).split("\n")[0] ?? "";
}

function allResponseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
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

async function waitForDelivery(
  client: Client,
  workspaceId: string,
  expected: string,
  attempts = 100,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await client.callTool({
      name: "read",
      arguments: { workspaceId, path: "AGENTS.md" },
    });
    if (allResponseText(result).includes(expected)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForFile(path: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`file did not appear: ${path}`);
}

async function eventually(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
