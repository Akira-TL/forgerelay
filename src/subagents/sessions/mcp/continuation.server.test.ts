import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { ProcessManager } from "../../../process-sessions.js";
import { createReviewCheckpointManager } from "../../../review-checkpoints.js";
import { createMcpServer } from "../../../server.js";
import { SqliteWorkspaceStore } from "../../../workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import type { SubagentProvider } from "../../profiles.js";
import { getSubagentProviderAvailabilitySnapshot } from "../../providers/availability.js";
import type { SubagentRunInput, SubagentRunResult } from "../../providers/contract.js";
import { SubagentSessionStore } from "../store.js";

interface ProviderCall {
  provider: SubagentProvider;
  input: SubagentRunInput;
}

test("subagent.session resume is truthful, serial, workspace-scoped, and configuration-stable", async (t) => {
  let releaseBusy!: () => void;
  const busyGate = new Promise<void>((resolve) => {
    releaseBusy = resolve;
  });
  const calls: ProviderCall[] = [];
  const context = await fixture(t, async (provider, input) => {
    calls.push({ provider, input: { ...input } });
    if (input.prompt.includes("HOLD_PROVIDER")) await busyGate;
    return {
      provider,
      providerSessionId: input.providerSessionId ?? "provider-thread-original",
      finalResponse: `done:${input.prompt}`,
    };
  });

  const opened = await callOpen(context.client, context.project, "continuation-owner");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const providers = structuredContent(opened).agentProviders as Array<Record<string, unknown>>;
  assert.equal(providers.find((provider) => provider.name === "codex")?.continuationSupported, true);
  assert.equal(providers.find((provider) => provider.name === "cursor")?.continuationSupported, false);
  assert.equal(providers.find((provider) => provider.name === "copilot")?.continuationSupported, false);

  const started = await runSubagent(context.client, workspaceId, {
    operation: "start",
    target: "reviewer",
    prompt: "initial task",
  });
  assert.equal(started.isError, undefined, allResponseText(started));
  const sessionId = String((structuredContent(started).result as {
    session: { id: string };
  }).session.id);
  await waitForSessionIdle(context.stateDir, sessionId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.provider, "codex");
  assert.match(calls[0]?.input.prompt ?? "", /^PROFILE V1\n\nTask:\ninitial task$/);
  assert.equal(calls[0]?.input.model, "model-v1");
  assert.equal(calls[0]?.input.thinking, "high");

  await writeReviewerProfile(context.project, {
    provider: "claude",
    model: "model-v2",
    thinking: "low",
    body: "MUTATED PROFILE MUST NOT BE REINJECTED",
  });

  const resumed = await runSubagent(context.client, workspaceId, {
    operation: "resume",
    sessionId,
    prompt: "follow-up only",
  });
  assert.equal(resumed.isError, undefined, allResponseText(resumed));
  await eventually(() => calls.length === 2);
  assert.equal(calls[1]?.provider, "codex");
  assert.equal(calls[1]?.input.providerSessionId, "provider-thread-original");
  assert.equal(calls[1]?.input.prompt, "follow-up only");
  assert.equal(calls[1]?.input.model, "model-v1");
  assert.equal(calls[1]?.input.thinking, "high");

  const overrideRejected = await runSubagent(context.client, workspaceId, {
    operation: "resume",
    sessionId,
    prompt: "must reject override",
    model: "forbidden-model",
  });
  assert.equal(overrideRejected.isError, true);
  assert.equal(errorCode(overrideRejected), "invalid_arguments");

  const busyStart = await runSubagent(context.client, workspaceId, {
    operation: "start",
    target: "codex",
    prompt: "HOLD_PROVIDER",
  });
  assert.equal(busyStart.isError, undefined, allResponseText(busyStart));
  const busySessionId = String((structuredContent(busyStart).result as {
    session: { id: string };
  }).session.id);
  await eventually(() => calls.length === 3);
  const busyResume = await runSubagent(context.client, workspaceId, {
    operation: "resume",
    sessionId: busySessionId,
    prompt: "must not queue",
  });
  assert.equal(busyResume.isError, true);
  assert.equal(errorCode(busyResume), "subagent.busy");
  assert.equal(calls.length, 3);
  releaseBusy();

  const otherOpened = await callOpen(context.client, context.otherProject, "continuation-other");
  const otherWorkspaceId = String(structuredContent(otherOpened).workspaceId);
  const crossStatus = await runSubagent(context.client, otherWorkspaceId, {
    operation: "status",
    sessionId,
  });
  assert.equal(crossStatus.isError, true);
  assert.equal(errorCode(crossStatus), "subagent.session_not_found");
  const crossResume = await runSubagent(context.client, otherWorkspaceId, {
    operation: "resume",
    sessionId,
    prompt: "cross-workspace attempt",
  });
  assert.equal(crossResume.isError, true);
  assert.equal(errorCode(crossResume), "subagent.session_not_found");

  const store = new SubagentSessionStore(context.stateDir);
  const unsupported = store.create({
    workspaceId,
    workspaceRoot: context.project,
    profileName: "cursor",
    provider: "cursor",
  });
  store.update(unsupported.id, { providerSessionId: "cursor-native-session" });
  store.close();
  const unsupportedResume = await runSubagent(context.client, workspaceId, {
    operation: "resume",
    sessionId: unsupported.id,
    prompt: "must not fake ACP continuation",
  });
  assert.equal(unsupportedResume.isError, true);
  assert.equal(errorCode(unsupportedResume), "subagent.continuation_unsupported");
  assert.equal(calls.length, 3);
});

interface Fixture {
  client: Client;
  project: string;
  otherProject: string;
  stateDir: string;
}

async function fixture(
  t: TestContext,
  providerRunner: (provider: SubagentProvider, input: SubagentRunInput) => Promise<SubagentRunResult>,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-continuation-test-"));
  const project = join(root, "project");
  const otherProject = join(root, "other-project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");
  await Promise.all([
    mkdir(join(project, ".forgerelay", "agents"), { recursive: true }),
    mkdir(join(otherProject, ".forgerelay", "agents"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(agentDir, "AGENTS.md"), "global instructions\n"),
    writeFile(join(project, "AGENTS.md"), "project instructions\n"),
    writeFile(join(otherProject, "AGENTS.md"), "other instructions\n"),
    writeReviewerProfile(project, {
      provider: "codex",
      model: "model-v1",
      thinking: "high",
      body: "PROFILE V1",
    }),
  ]);
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
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const auditStore = new ActivityAuditStore(stateDir);
  const bashOutputStore = new BashOutputStore(stateDir);
  const hostTurns = new HostTurnStore(stateDir);
  const activityQueries = new ActivityQueryService(hostTurns, auditStore, bashOutputStore);
  const processes = new ProcessManager({ outputAudit: bashOutputStore });
  const lifecycle = new ActivityLifecycle(auditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      activityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
  const codeIntelligence = new CodeIntelligenceManager(config);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processes,
    getSubagentProviderAvailabilitySnapshot(),
    [],
    codeIntelligence,
    lifecycle,
    bashOutputStore,
    activityQueries,
    { subagentProviderRunner: providerRunner },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "forgerelay-continuation-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await codeIntelligence.shutdown();
    processes.shutdown();
    hostTurns.close();
    bashOutputStore.close();
    auditStore.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, project, otherProject, stateDir };
}

async function writeReviewerProfile(
  project: string,
  profile: { provider: string; model: string; thinking: string; body: string },
): Promise<void> {
  await writeFile(join(project, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    `provider: ${profile.provider}`,
    `model: ${profile.model}`,
    `thinking: ${profile.thinking}`,
    "---",
    profile.body,
  ].join("\n"));
}

async function callOpen(client: Client, path: string, scope: string) {
  return client.callTool({
    name: "open_workspace",
    arguments: { path },
    _meta: { "openai/session": scope },
  } as Parameters<Client["callTool"]>[0]);
}

async function runSubagent(client: Client, workspaceId: string, argumentsValue: Record<string, unknown>) {
  return client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "subagent.session",
      action: "run",
      arguments: argumentsValue,
    },
  });
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function allResponseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" && entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}

function errorCode(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (structuredContent(result).error as { code?: unknown } | undefined)?.code;
}

async function waitForSessionIdle(stateDir: string, sessionId: string): Promise<void> {
  await eventually(() => {
    const store = new SubagentSessionStore(stateDir);
    try {
      return store.get(sessionId)?.status === "idle";
    } finally {
      store.close();
    }
  });
}

async function eventually(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
