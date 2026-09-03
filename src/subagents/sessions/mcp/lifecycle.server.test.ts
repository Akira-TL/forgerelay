import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { openDatabase } from "../../../runtime/state/db/client.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { ProcessManager } from "../../../mcp/process/process-sessions.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { createMcpServer } from "../../../server.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import type { SubagentProviderRunner } from "../execution.js";

const previousCodexCommand = process.env.CODEX_COMMAND;
process.env.CODEX_COMMAND = process.execPath;
after(() => {
  if (previousCodexCommand === undefined) delete process.env.CODEX_COMMAND;
  else process.env.CODEX_COMMAND = previousCodexCommand;
});

const firstResult = "FIRST_RESULT_BODY";
const afterCancelResult = "AFTER_CANCEL_RESULT_BODY";

test("subagent.session stop cancels the active Run and delete removes only ForgeRelay coordination", async (t) => {
  let cancellationObserved = false;
  let blockingRunStarted = false;
  const providerSessionIds: Array<string | undefined> = [];
  const runner: SubagentProviderRunner = async (_provider, input) => {
    providerSessionIds.push(input.providerSessionId);
    if (input.prompt === "block until stop") {
      blockingRunStarted = true;
      return new Promise((_resolve, reject) => {
        const rejectCancelled = () => {
          cancellationObserved = true;
          const error = new Error("provider observed abort");
          error.name = "AbortError";
          reject(error);
        };
        if (input.signal?.aborted) rejectCancelled();
        else input.signal?.addEventListener("abort", rejectCancelled, { once: true });
      });
    }
    return {
      provider: "codex",
      providerSessionId: "thread_stop_test",
      finalResponse: input.prompt === "after cancel" ? afterCancelResult : firstResult,
    };
  };
  const context = await fixture(t, runner);
  const opened = await callOpen(context.client, context.project, "subagent-stop-chat");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const started = await callSession(context.client, workspaceId, {
    operation: "start",
    target: "reviewer",
    prompt: "establish continuation",
  });
  const sessionId = String(sessionResult(started).session.id);
  await waitForSessionIdle(context.client, workspaceId, sessionId);

  const resumed = await callSession(context.client, workspaceId, {
    operation: "resume",
    sessionId,
    prompt: "block until stop",
  });
  const activeRunId = String(sessionResult(resumed).run.id);
  await eventually(() => blockingRunStarted);

  const deleteBusy = await callSession(context.client, workspaceId, {
    operation: "delete",
    sessionId,
  });
  assert.equal(deleteBusy.isError, true);
  assert.equal(errorCode(deleteBusy), "subagent.busy");

  const stopped = await callSession(context.client, workspaceId, {
    operation: "stop",
    sessionId,
  });
  assert.equal(stopped.isError, undefined, allResponseText(stopped));
  assert.equal(cancellationObserved, true, "stop must wait until the provider observes cancellation");
  const stoppedValue = sessionResult(stopped);
  assert.equal(stoppedValue.session.status, "idle");
  assert.equal(stoppedValue.run.id, activeRunId);
  assert.equal(stoppedValue.run.status, "cancelled");
  assert.equal(stoppedValue.session.latestRun.status, "cancelled");

  const stoppedAgain = await callSession(context.client, workspaceId, {
    operation: "stop",
    sessionId,
  });
  assert.equal(stoppedAgain.isError, undefined, allResponseText(stoppedAgain));
  assert.equal(sessionResult(stoppedAgain).session.status, "idle");
  assert.equal(sessionResult(stoppedAgain).run, undefined);

  const afterCancel = await callSession(context.client, workspaceId, {
    operation: "resume",
    sessionId,
    prompt: "after cancel",
  });
  assert.equal(afterCancel.isError, undefined, allResponseText(afterCancel));
  assert.equal(providerSessionIds.at(-1), "thread_stop_test");

  const mailboxPath = join(context.stateDir, "subagent-delivery", `${sessionId}.json`);
  await waitForFile(mailboxPath);
  const providerHistoryMarker = join(context.project, ".provider-native-history");
  await writeFile(providerHistoryMarker, "provider-owned history stays\n");

  const deleted = await callSession(context.client, workspaceId, {
    operation: "delete",
    sessionId,
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(sessionResult(deleted).deletedSessionId, sessionId);
  await assert.rejects(stat(mailboxPath), /ENOENT/);
  assert.equal(await readFile(providerHistoryMarker, "utf8"), "provider-owned history stays\n");

  const missing = await callSession(context.client, workspaceId, {
    operation: "status",
    sessionId,
  });
  assert.equal(missing.isError, true);
  assert.equal(errorCode(missing), "subagent.session_not_found");

  const hookLog = await readFile(join(context.project, "hook-log.jsonl"), "utf8");
  assert.doesNotMatch(hookLog, /establish continuation|block until stop|after cancel/);
  assert.doesNotMatch(hookLog, new RegExp(`${firstResult}|${afterCancelResult}`));
  const hooks = hookLog.trim().split("\n").map((line) => JSON.parse(line) as {
    event: string;
    payload: Record<string, unknown>;
  });
  assert.equal(hooks.filter((entry) => entry.event === "SubagentStart").length, 3);
  assert.equal(hooks.filter((entry) => entry.event === "SubagentStop").length, 3);
  const cancelledStop = hooks.find((entry) =>
    entry.event === "SubagentStop" && entry.payload.status === "cancelled"
  );
  assert.ok(cancelledStop);
  assert.equal(cancelledStop.payload.sessionId, sessionId);
  assert.equal(cancelledStop.payload.runId, activeRunId);
  assert.equal("providerSessionId" in cancelledStop.payload, false);

  const sqlite = openDatabase(context.stateDir);
  try {
    const activityJson = JSON.stringify(sqlite.sqlite.prepare(
      "select event_type, tool, request_json, result_json, error from activity_audit_events where tool = 'subagent_result' or activity_id in (select activity_id from activity_audit_events where tool = 'subagent_result')",
    ).all());
    assert.match(activityJson, /cancelled/);
    assert.doesNotMatch(activityJson, /establish continuation|block until stop|after cancel/);
    assert.doesNotMatch(activityJson, new RegExp(`${firstResult}|${afterCancelResult}`));
  } finally {
    sqlite.close();
  }
});

interface Fixture {
  client: Client;
  project: string;
  stateDir: string;
}

async function fixture(t: TestContext, runner: SubagentProviderRunner): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-lifecycle-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await mkdir(join(project, ".forgerelay", "agents"), { recursive: true });
  await mkdir(join(project, ".forgerelay", "hooks"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Stable reviewer profile.",
  ].join("\n"));
  await writeFile(join(project, ".forgerelay", "hooks", "capture.mjs"), [
    'import { appendFileSync } from "node:fs";',
    "appendFileSync('hook-log.jsonl', JSON.stringify({",
    "  event: process.env.FORGERELAY_HOOK_EVENT,",
    "  payload: JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? '{}'),",
    "}) + '\\n');",
  ].join("\n"));
  await writeFile(join(project, ".forgerelay", "hooks.json"), JSON.stringify({
    SubagentStart: [{ command: "node .forgerelay/hooks/capture.mjs" }],
    SubagentStop: [{ command: "node .forgerelay/hooks/capture.mjs" }],
  }));

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
  const connected = await connect(config, stateDir, runner);
  t.after(async () => {
    await connected.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client: connected.client, project, stateDir };
}

async function connect(config: ServerConfig, stateDir: string, runner: SubagentProviderRunner) {
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
    { subagentProviderRunner: runner },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-subagent-lifecycle-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  let closed = false;
  return {
    client,
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

function errorCode(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (structuredContent(result).error as Record<string, unknown>)?.code;
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

async function waitForSessionIdle(client: Client, workspaceId: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await callSession(client, workspaceId, { operation: "status", sessionId });
    if ((sessionResult(result).session as { status?: string }).status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Subagent Session did not become idle");
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
