import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "./activity/audit-store.js";
import { BashOutputStore } from "./activity/bash-output-store.js";
import { ActivityLifecycle } from "./activity/lifecycle.js";
import { buildCapabilityFingerprint } from "./capabilities.js";
import { CodeIntelligenceManager } from "./lsp/runtime/manager.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { parseHookConfig, type HookConfigInput } from "./hooks.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const canonicalToolNames = [
  "open_workspace",
  "capability",
  "close_workspace",
  "read",
  "write",
  "edit",
  "rename",
  "delete",
  "bash",
] as const;

test("MCP instructions separate capability contract from configurable workflow policy", async (t) => {
  const defaultContext = await fixture(t);
  const defaultInstructions = defaultContext.client.getInstructions() ?? "";
  const defaultTools = await defaultContext.client.listTools();
  assert.equal(defaultContext.client.getServerVersion()?.version, packageJson.version);
  assert.deepEqual(defaultTools.tools.map((tool) => tool.name), canonicalToolNames);
  const shellTool = defaultTools.tools.find((tool) => tool.name === "bash");
  const readTool = defaultTools.tools.find((tool) => tool.name === "read");
  const renameTool = defaultTools.tools.find((tool) => tool.name === "rename");
  const deleteTool = defaultTools.tools.find((tool) => tool.name === "delete");
  const openWorkspaceTool = defaultTools.tools.find((tool) => tool.name === "open_workspace");
  const closeWorkspaceTool = defaultTools.tools.find((tool) => tool.name === "close_workspace");
  const shellToolMeta = shellTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
    "openai/outputTemplate"?: string;
  } | undefined;
  const shellInputProperties = (shellTool?.inputSchema as {
    properties?: Record<string, { description?: string }>;
  } | undefined)?.properties;

  assert.match(defaultInstructions, /Default to the user's existing checkout/);
  assert.match(defaultInstructions, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(defaultInstructions, /close_workspace/);
  assert.doesNotMatch(defaultInstructions, /close_worktree/);
  assert.doesNotMatch(defaultInstructions, /write_stdin/);
  assert.match(defaultInstructions, /Shell commands may modify ordinary project files/);
  assert.match(defaultInstructions, /\/etc\/sudoers/);
  assert.match(defaultInstructions, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(defaultInstructions, /Do not create or modify files with bash/);
  assert.equal(openWorkspaceTool?.annotations?.readOnlyHint, false);
  assert.equal(openWorkspaceTool?.annotations?.destructiveHint, false);
  assert.match(shellTool?.description ?? "", /local user's authority/);
  assert.doesNotMatch(shellTool?.description ?? "", /may modify ordinary project files/);
  assert.doesNotMatch(shellTool?.description ?? "", /\/etc\/sudoers/);
  assert.doesNotMatch(shellTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(shellTool?.description ?? "", /external device or hardware mutations/);
  assert.match(shellTool?.description ?? "", /action=process/);
  assert.doesNotMatch(shellTool?.description ?? "", /write_stdin/);
  assert.doesNotMatch(shellTool?.description ?? "", /Do not use bash to create, move, rename, or delete project files/);
  assert.doesNotMatch(shellTool?.description ?? "", /Use only for/);
  assert.match(shellInputProperties?.command?.description ?? "", /Required for action=run/);
  assert.match(shellInputProperties?.processId?.description ?? "", /action=process/);
  assert.match(shellInputProperties?.input?.description ?? "", /action=process/);
  assert.match(shellInputProperties?.interrupt?.description ?? "", /SIGINT/);
  assert.equal(shellInputProperties?.timeout, undefined);
  assert.match(shellInputProperties?.yieldTimeMs?.description ?? "", /feedback window/i);
  assert.match(shellInputProperties?.timeoutMs?.description ?? "", /total execution timeout/i);
  assert.match(
    shellToolMeta?.ui?.resourceUri ?? "",
    /^ui:\/\/forgerelay\/workspace-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/,
  );
  assert.deepEqual(shellToolMeta?.ui?.visibility, ["model", "app"]);
  assert.equal(shellToolMeta?.["openai/outputTemplate"], shellToolMeta?.ui?.resourceUri);
  assert.ok(renameTool);
  assert.ok(deleteTool);
  assert.equal(defaultTools.tools.some((tool) => tool.name === "write_stdin"), false);
  assert.equal(defaultTools.tools.some((tool) => tool.name === "close_worktree"), false);
  assert.ok(closeWorkspaceTool);
  assert.match(readTool?.description ?? "", /capability guides/);
  assert.ok((openWorkspaceTool?.description?.length ?? Infinity) < 450);
  assert.ok((closeWorkspaceTool?.description?.length ?? Infinity) < 500);
  assert.match(closeWorkspaceTool?.description ?? "", /Managed-worktree-backed/);
  assert.match(closeWorkspaceTool?.description ?? "", /commitMessage/);

  const overrideContext = await fixture(t, {
    env: {
      DEVSPACE_WORKFLOW_INSTRUCTIONS: "Follow repository-defined development and Git workflows.",
      DEVSPACE_APPEND_INSTRUCTIONS: "Preserve the capability contract.",
    },
  });
  const overrideInstructions = overrideContext.client.getInstructions() ?? "";

  assert.match(overrideInstructions, /Default to the user's existing checkout/);
  assert.match(overrideInstructions, /Only open mode="worktree" when the user explicitly asks/);
  assert.doesNotMatch(overrideInstructions, /close_worktree/);
  assert.match(overrideInstructions, /close_workspace/);
  assert.match(overrideInstructions, /Follow instructions returned by open_workspace/);
  assert.match(overrideInstructions, /Follow repository-defined development and Git workflows\./);
  assert.match(overrideInstructions, /Preserve the capability contract\./);
  assert.match(overrideInstructions, /Shell commands may modify ordinary project files/);
  assert.match(overrideInstructions, /\/etc\/sudoers/);
  assert.doesNotMatch(overrideInstructions, /Do not create or modify files with bash/);

  const minimalContext = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "minimal" } });
  const minimalTools = await minimalContext.client.listTools();
  assert.deepEqual(minimalTools.tools.map((tool) => tool.name), canonicalToolNames);

  const codexContext = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });
  const codexTools = await codexContext.client.listTools();
  const execCommandTool = codexTools.tools.find((tool) => tool.name === "exec_command");
  assert.match(execCommandTool?.description ?? "", /may modify ordinary project files/);
  assert.match(execCommandTool?.description ?? "", /\/etc\/sudoers/);
  assert.match(execCommandTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
});

test("workspace app resources expose a deployment domain alongside CSP metadata", async (t) => {
  const context = await fixture(t, {
    env: { DEVSPACE_PUBLIC_BASE_URL: "https://forge.example.com/base/path" },
  });

  const resources = await context.client.listResources();
  const current = resources.resources.find((resource) =>
    /^ui:\/\/forgerelay\/workspace-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/.test(resource.uri)
  );
  assert.ok(current);
  const resourceMeta = current._meta as {
    ui?: {
      domain?: string;
      csp?: { resourceDomains?: string[]; connectDomains?: string[] };
    };
  } | undefined;
  assert.equal(resourceMeta?.ui?.domain, "https://forge.example.com");
  assert.deepEqual(resourceMeta?.ui?.csp?.resourceDomains, ["https://forge.example.com/base/path"]);
  assert.deepEqual(resourceMeta?.ui?.csp?.connectDomains, ["https://forge.example.com/base/path"]);

});

test("capability gateway supports catalog, describe, guide read, direct run, and stable errors", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "check-fixture.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "never" },
      command: "node -e \"process.exit(0)\"",
    }) + "\n",
  );

  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "capability"));
  assert.equal(tools.tools.some((tool) => tool.name === "write_stdin"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "close_worktree"), false);

  const opened = await callOpen(context.client, context.project, "capability-chat");
  const openedStructured = structuredContent(opened);
  const catalog = openedStructured.capabilityCatalog as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(catalog));
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], {
    name: "hooks.check",
    description: "Validate the active ForgeRelay Hook configuration for this workspace.",
    available: true,
    guide: {
      name: "lifecycle-hooks",
      path: catalog[0]?.guide && (catalog[0].guide as Record<string, unknown>).path,
      readBeforeFirstUse: true,
    },
  });
  assert.deepEqual(catalog[1], {
    name: "code.intelligence",
    description: "Read semantic code information through an available Language server without changing the Workspace.",
    available: true,
    guide: {
      name: "code-intelligence",
      path: catalog[1]?.guide && (catalog[1].guide as Record<string, unknown>).path,
      readBeforeFirstUse: true,
    },
  });
  const workspaceId = openedStructured.workspaceId as string;

  const directRun = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "hooks.check", action: "run", arguments: {} },
  });
  assert.equal(directRun.isError, undefined);
  assert.deepEqual(structuredContent(directRun), {
    name: "hooks.check",
    action: "run",
    result: { ok: true, globalHooks: 0, projectHooks: 1 },
  });

  const described = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "hooks.check", action: "describe" },
  });
  assert.equal(described.isError, undefined);
  const capability = structuredContent(described).capability as Record<string, unknown>;
  const guide = capability.guide as Record<string, unknown>;
  assert.equal(capability.name, "hooks.check");
  assert.equal(capability.available, true);
  assert.equal(guide.name, "lifecycle-hooks");
  assert.equal(guide.readBeforeFirstUse, true);
  assert.equal((capability.inputSchema as Record<string, unknown>).type, "object");

  const guideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: guide.path },
  });
  assert.equal(guideRead.isError, undefined);
  assert.match(responseText(guideRead), /BeforeTool/);

  const invalid = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "hooks.check",
      action: "run",
      arguments: { arbitrary: "value" },
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal((structuredContent(invalid).error as Record<string, unknown>).code, "invalid_arguments");

  const unknown = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "shell.anything", action: "run", arguments: {} },
  });
  assert.equal(unknown.isError, true);
  assert.equal((structuredContent(unknown).error as Record<string, unknown>).code, "unknown_capability");
});

test("review.changes capability owns checkpoints, Hook reports, and review-card metadata", async (t) => {
  const context = await fixture(t, {
    git: true,
    env: { DEVSPACE_WIDGETS: "changes" },
    hooks: {
      BeforeTool: [{
        matcher: { tool: "capability" },
        handlers: [{ name: "Capability preflight", command: "node -e \"process.exit(0)\"" }],
      }],
    },
  });
  const opened = await callOpen(context.client, context.project, "review-capability-chat");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name: string }>;
  assert.deepEqual(catalog.map((entry) => entry.name), ["hooks.check", "review.changes", "code.intelligence"]);

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "reviewed.txt", content: "review capability\n" },
  });
  assert.equal(written.isError, undefined);

  const reviewed = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "review.changes", action: "run", arguments: {} },
  });
  assert.equal(reviewed.isError, undefined);
  const reviewResult = structuredContent(reviewed).result as {
    result?: string;
    summary?: { files?: number };
  };
  assert.match(reviewResult.result ?? "", /Changed 1 file/);
  assert.equal(reviewResult.summary?.files, 1);
  assert.match(allResponseText(reviewed), /Capability preflight \(BeforeTool, global\) passed/);
  const reviewMeta = (reviewed as { _meta?: Record<string, unknown> })._meta as {
    tool?: string;
    card?: {
      capabilityName?: string;
      payload?: { patch?: string };
      summary?: { files?: number };
    };
  } | undefined;
  assert.equal(reviewMeta?.tool, "capability");
  assert.equal(reviewMeta?.card?.capabilityName, "review.changes");
  assert.equal(reviewMeta?.card?.summary?.files, 1);
  assert.match(reviewMeta?.card?.payload?.patch ?? "", /reviewed\.txt/);
  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "show_changes"), false);
});

test("artifact.download capability preserves native-file transport without a dedicated tool alias", async (t) => {
  const adapter: IncomingArtifactAdapter = {
    id: "server-test-native",
    canHandle: () => true,
    async open() {
      return {
        name: "artifact.txt",
        size: 5,
        stream: Readable.from([Buffer.from("hello")]),
      };
    },
  };
  const context = await fixture(t, {
    env: { DEVSPACE_ARTIFACTS: "1" },
    incomingArtifactAdapters: [adapter],
    hooks: {
      AfterFileChange: [{
        matcher: { tool: "capability", pathRegex: "^downloads/" },
        handlers: [{ name: "Artifact changed", command: "node -e \"process.exit(0)\"" }],
      }],
    },
  });
  const tools = await context.client.listTools();
  const gateway = tools.tools.find((tool) => tool.name === "capability");
  assert.deepEqual((gateway?._meta as Record<string, unknown> | undefined)?.["openai/fileParams"], ["file"]);

  const opened = await callOpen(context.client, context.project, "artifact-capability-chat");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name: string }>;
  const artifactAvailable = process.platform === "linux";
  assert.equal(catalog.some((entry) => entry.name === "artifact.download"), artifactAvailable);
  assert.equal(tools.tools.some((tool) => tool.name === "download_artifact"), false);
  if (!artifactAvailable) return;

  const described = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "artifact.download", action: "describe" },
  });
  const capability = structuredContent(described).capability as {
    transport?: { nativeFileArgument?: string; gatewayParameter?: string };
  };
  assert.deepEqual(capability.transport, {
    nativeFileArgument: "file",
    gatewayParameter: "file",
  });

  const file = {
    download_url: "https://files.oaiusercontent.com/file_server_test/download",
    file_id: "file_server_test",
    file_name: "artifact.txt",
  };
  const downloaded = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "artifact.download",
      action: "run",
      arguments: { path: "downloads/artifact.txt" },
      file,
    },
  });
  assert.equal(downloaded.isError, undefined);
  assert.deepEqual(structuredContent(downloaded).result, { path: "downloads/artifact.txt" });
  assert.match(allResponseText(downloaded), /Artifact changed \(AfterFileChange, global\) passed/);
  assert.equal(await readFile(join(context.project, "downloads", "artifact.txt"), "utf8"), "hello");

  const conflict = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "artifact.download",
      action: "run",
      arguments: { path: "downloads/artifact.txt" },
      file,
    },
  });
  assert.equal(conflict.isError, true);
  assert.equal(
    (structuredContent(conflict).error as { code?: string }).code,
    "artifact.artifact_destination_exists",
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.deepEqual(firstStructured.capabilityFingerprint, {
    version: packageJson.version,
    toolMode: "full",
    capabilities: [
      "workspace.close",
      "worktree.managed",
      "filesystem.rename-move",
      "filesystem.delete",
      "process.lifecycle",
      "hooks.lifecycle",
      "capability-guides.read",
      "code.intelligence",
      "ui.mcp-app",
    ],
  });
  assert.deepEqual(structuredContent(repeated).capabilityFingerprint, firstStructured.capabilityFingerprint);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same directory previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /capability guides/);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace context policy suppresses, automatically delivers, and forces bootstrap context", async (t) => {
  const context = await fixture(t);
  const skipped = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, context: "none" },
    _meta: { "openai/session": "chat-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const skippedStructured = structuredContent(skipped);

  assert.equal(typeof skippedStructured.contextFingerprint, "string");
  assert.equal(skippedStructured.agentsFiles, undefined);
  assert.equal(skippedStructured.skills, undefined);

  const automatic = await callOpen(context.client, context.project, "chat-context-policy");
  const automaticStructured = structuredContent(automatic);
  assert.equal(automaticStructured.workspaceId, skippedStructured.workspaceId);
  assert.equal(automaticStructured.contextFingerprint, skippedStructured.contextFingerprint);
  assert.ok(Array.isArray(automaticStructured.agentsFiles));
  assert.ok(Array.isArray(automaticStructured.skills));

  const repeated = await callOpen(context.client, context.project, "chat-context-policy");
  assert.equal(structuredContent(repeated).agentsFiles, undefined);

  const forced = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: automaticStructured.workspaceId, context: "full" },
    _meta: { "openai/session": "chat-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  assert.ok(Array.isArray(structuredContent(forced).agentsFiles));
  assert.match(allResponseText(forced), /context="auto" avoids repeating unchanged bootstrap context/);
});

test("open_workspace list action exposes logical workspace inventory through the MCP surface", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-list-1");
  const second = await callOpen(context.client, context.project, "chat-list-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", root: context.project },
    _meta: { "openai/session": "chat-list-1" },
  } as Parameters<Client["callTool"]>[0]);
  const structured = structuredContent(listed);
  const inventory = structured.workspaces as Array<Record<string, unknown>>;

  assert.equal(structured.action, "list");
  assert.equal(inventory.length, 2);
  assert.deepEqual(new Set(inventory.map((entry) => entry.workspaceId)), new Set([firstId, secondId]));
  assert.equal(inventory.find((entry) => entry.workspaceId === firstId)?.current, true);
  assert.equal(inventory.find((entry) => entry.workspaceId === secondId)?.current, false);
  assert.equal(inventory.every((entry) => entry.mode === "checkout"), true);
  assert.equal(inventory.every((entry) => entry.status === "active"), true);
  assert.equal(inventory.every((entry) => entry.state === "active"), true);
  assert.equal(inventory.every((entry) => entry.rootValid === true), true);
  assert.equal(inventory.every((entry) => String(entry.label).startsWith("project/ws_")), true);
  assert.equal((structured.summary as Record<string, unknown>).matching, 2);
  assert.equal((structured.page as Record<string, unknown>).hasMore, false);
  assert.match(allResponseText(listed), /resume.*workspaceId/i);
  assert.match(allResponseText(listed), /close_workspace/);

  const outside = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", root: "/etc" },
    _meta: { "openai/session": "chat-list-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots/i);
});

test("open_workspace list derives stale and invalid states without refreshing last-used time", async (t) => {
  const context = await fixture(t);
  const staleOpen = await callOpen(context.client, context.project, "chat-stale");
  const staleId = String(structuredContent(staleOpen).workspaceId);
  const missingRoot = join(dirname(context.project), "missing-project");
  await mkdir(missingRoot);
  await writeFile(join(missingRoot, "AGENTS.md"), "temporary instructions\n");
  const missingOpen = await callOpen(context.client, missingRoot, "chat-missing");
  const missingId = String(structuredContent(missingOpen).workspaceId);
  await rm(missingRoot, { recursive: true, force: true });

  const staleAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString();
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(staleAt, staleId);
  } finally {
    database.close();
  }

  const staleList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", staleOnly: true },
    _meta: { "openai/session": "chat-inventory" },
  } as Parameters<Client["callTool"]>[0]);
  const staleEntries = structuredContent(staleList).workspaces as Array<Record<string, unknown>>;
  assert.equal(staleEntries.some((entry) => entry.workspaceId === staleId), true);
  assert.equal(staleEntries.every((entry) => entry.state === "stale"), true);

  const invalidList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", state: "invalid" },
    _meta: { "openai/session": "chat-inventory" },
  } as Parameters<Client["callTool"]>[0]);
  const invalidEntries = structuredContent(invalidList).workspaces as Array<Record<string, unknown>>;
  const invalid = invalidEntries.find((entry) => entry.workspaceId === missingId);
  assert.ok(invalid);
  assert.equal(invalid.status, "active");
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.rootValid, false);

  const verification = openDatabase(context.stateDir);
  try {
    const row = verification.sqlite
      .prepare("select last_used_at from workspace_sessions where id = ?")
      .get(staleId) as { last_used_at: string };
    assert.equal(row.last_used_at, staleAt);
  } finally {
    verification.close();
  }
});

test("open_workspace list exposes managed worktrees and paginates inventory", async (t) => {
  const context = await fixture(t, { git: true });
  await callOpen(context.client, context.project, "chat-page");
  const worktreeOpen = await callOpen(
    context.client,
    context.project,
    "chat-worktree-list",
    "worktree",
  );
  const worktreeId = String(structuredContent(worktreeOpen).workspaceId);

  const worktreeList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", mode: "worktree" },
    _meta: { "openai/session": "chat-worktree-list" },
  } as Parameters<Client["callTool"]>[0]);
  const worktrees = structuredContent(worktreeList).workspaces as Array<Record<string, unknown>>;
  const managed = worktrees.find((entry) => entry.workspaceId === worktreeId);
  assert.ok(managed);
  assert.equal(managed.managed, true);
  assert.equal(managed.mode, "worktree");
  assert.equal(managed.sourceRoot, context.project);
  assert.equal(managed.rootValid, true);
  assert.equal(typeof managed.branch, "string");

  const firstPage = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", limit: 1 },
    _meta: { "openai/session": "chat-page" },
  } as Parameters<Client["callTool"]>[0]);
  const firstStructured = structuredContent(firstPage);
  assert.equal((firstStructured.workspaces as unknown[]).length, 1);
  assert.equal((firstStructured.page as Record<string, unknown>).hasMore, true);

  const secondPage = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", offset: 1, limit: 1 },
    _meta: { "openai/session": "chat-page" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal((structuredContent(secondPage).workspaces as unknown[]).length, 1);
});

test("open_workspace list distinguishes closed and externally missing managed worktrees", async (t) => {
  const context = await fixture(t, { git: true });
  const closable = await callOpen(
    context.client,
    context.project,
    "chat-worktree-closed",
    "worktree",
  );
  const closableStructured = structuredContent(closable);
  const closableId = String(closableStructured.workspaceId);
  const missing = await callOpen(
    context.client,
    context.project,
    "chat-worktree-invalid",
    "worktree",
    true,
  );
  const missingStructured = structuredContent(missing);
  const missingId = String(missingStructured.workspaceId);
  const missingRoot = String(missingStructured.root);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId: closableId,
      commitMessage: "TEST: (workspace) close managed inventory fixture",
    },
  });
  assert.equal(closed.isError, undefined);
  await rm(missingRoot, { recursive: true, force: true });

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", mode: "worktree" },
    _meta: { "openai/session": "chat-worktree-invalid" },
  } as Parameters<Client["callTool"]>[0]);
  const worktrees = structuredContent(listed).workspaces as Array<Record<string, unknown>>;
  const closedEntry = worktrees.find((entry) => entry.workspaceId === closableId);
  const invalidEntry = worktrees.find((entry) => entry.workspaceId === missingId);

  assert.ok(closedEntry);
  assert.equal(closedEntry.status, "closed");
  assert.equal(closedEntry.state, "closed");
  assert.equal(closedEntry.rootValid, false);
  assert.ok(invalidEntry);
  assert.equal(invalidEntry.status, "active");
  assert.equal(invalidEntry.state, "invalid");
  assert.equal(invalidEntry.rootValid, false);
});

test("capability fingerprint reports optional feature availability without copying tools/list", async (t) => {
  const context = await fixture(t, {
    env: {
      DEVSPACE_ARTIFACTS: "1",
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_WIDGETS: "changes",
    },
  });

  assert.deepEqual(
    buildCapabilityFingerprint(context.config, packageJson.version, { artifactDownloadSupported: true }),
    {
      version: packageJson.version,
      toolMode: "full",
      capabilities: [
        "workspace.close",
        "worktree.managed",
        "filesystem.rename-move",
        "filesystem.delete",
        "process.lifecycle",
        "hooks.lifecycle",
        "capability-guides.read",
        "code.intelligence",
        "subagent.profiles",
        "artifact.native-download",
        "ui.mcp-app",
        "review.changes",
      ],
    },
  );
  assert.equal(
    buildCapabilityFingerprint(context.config, packageJson.version, { artifactDownloadSupported: false })
      .capabilities.includes("artifact.native-download"),
    false,
  );

  const optionalTools = await context.client.listTools();
  assert.deepEqual(optionalTools.tools.map((tool) => tool.name), canonicalToolNames);

  const opened = await callOpen(context.client, context.project, "chat-optional-guides");
  const openedStructured = structuredContent(opened);
  const guides = openedStructured.capabilityGuides as Array<Record<string, unknown>>;
  assert.deepEqual(guides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "subagents",
    "artifacts-review",
    "host-integration",
    "shell-processes",
    "code-intelligence",
  ]);

  for (const [name, firstPattern, secondPattern] of [
    ["subagents", /forgerelay agents run/, /first-class MCP subagent/],
    ["artifacts-review", /artifact\.download/, /review\.changes/],
    ["code-intelligence", /definition/, /Language server/],
  ] as const) {
    const guide = guides.find((candidate) => candidate.name === name);
    assert.ok(guide);
    const readGuide = await context.client.callTool({
      name: "read",
      arguments: { workspaceId: openedStructured.workspaceId, path: guide.path },
    });
    assert.equal(readGuide.isError, undefined);
    assert.match(allResponseText(readGuide), firstPattern);
    assert.match(allResponseText(readGuide), secondPattern);
  }
});

test("open_workspace advertises capability guides that read can load on demand", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-guides");
  const firstStructured = structuredContent(first);
  const guides = firstStructured.capabilityGuides as Array<Record<string, unknown>>;

  assert.deepEqual(guides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "host-integration",
    "shell-processes",
    "code-intelligence",
  ]);
  assert.match(String(guides[0]?.description), /Hook/);
  assert.match(String(guides[0]?.whenToRead), /Hook/);
  assert.match(String(guides[0]?.path), /capabilities\/lifecycle-hooks\/GUIDE\.md$/);
  assert.match(String(guides[1]?.path), /capabilities\/managed-worktrees\/GUIDE\.md$/);
  assert.match(String(guides[2]?.path), /capabilities\/host-integration\/GUIDE\.md$/);
  assert.match(String(guides[3]?.path), /capabilities\/shell-processes\/GUIDE\.md$/);
  assert.match(String(guides[4]?.path), /capabilities\/code-intelligence\/GUIDE\.md$/);

  const guideExpectations = [
    [0, /BeforeTool/, /BeforeWorktreeClose/],
    [2, /oauth-protected-resource/, /Failed to fetch template/],
    [3, /action="process"/, /tty: true/],
    [4, /definition/, /Language server/],
  ] as const;
  for (const [index, firstPattern, secondPattern] of guideExpectations) {
    const readGuide = await context.client.callTool({
      name: "read",
      arguments: {
        workspaceId: firstStructured.workspaceId,
        path: guides[index]?.path,
      },
    });
    assert.equal(readGuide.isError, undefined);
    assert.match(allResponseText(readGuide), firstPattern);
    assert.match(allResponseText(readGuide), secondPattern);
  }

  const repeated = await callOpen(context.client, context.project, "chat-guides");
  assert.equal(structuredContent(repeated).capabilityGuides, undefined);
});

test("different MCP conversations get different stable workspace ids and can explicitly resume one", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.notEqual(secondId, firstId);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(resumed).workspaceId, firstId);

  const repeated = await callOpen(context.client, context.project, "chat-2");
  assert.equal(structuredContent(repeated).workspaceId, firstId);
});

test("open_workspace reports all logical workspaces idle for more than two days", async (t) => {
  const context = await fixture(t);
  const old = await callOpen(context.client, context.project, "chat-old");
  const oldId = String(structuredContent(old).workspaceId);
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(), oldId);
  } finally {
    database.close();
  }

  const current = await callOpen(context.client, context.project, "chat-current");
  const stale = structuredContent(current).staleWorkspaces as Array<Record<string, unknown>>;
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.workspaceId, oldId);
  assert.match(allResponseText(current), /Idle logical workspaces.*>2 days/);
  assert.match(allResponseText(current), new RegExp(oldId));
  assert.match(allResponseText(current), /do not clean them up automatically/i);
});

test("close_workspace releases one logical checkout handle without touching another", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: firstId },
  });
  assert.equal(closed.isError, undefined);
  assert.match(allResponseText(closed), /Physical project files were not removed/);

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: firstId, path: "AGENTS.md" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const liveRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: secondId, path: "AGENTS.md" },
  });
  assert.equal(liveRead.isError, undefined);
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("worktree mode reuses by default and only creates another worktree explicitly", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const repeatedWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const freshWorktree = await callOpen(context.client, context.project, "chat-1", "worktree", true);
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(firstWorktree).workspaceId, structuredContent(repeatedWorktree).workspaceId);
  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(freshWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);

  const firstStructured = structuredContent(firstWorktree);
  assert.equal(firstStructured.mode, "worktree");
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.match(responseText(firstWorktree), /Opened isolated worktree workspace/);

  const repeatedStructured = structuredContent(repeatedWorktree);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.match(responseText(repeatedWorktree), /Workspace already open as/);

  const freshStructured = structuredContent(freshWorktree);
  assert.ok(Array.isArray(freshStructured.agentsFiles));
  assert.ok(Array.isArray(freshStructured.worktrees));
  assert.equal((freshStructured.worktrees as unknown[]).length, 2);

  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same directory previously opened/);
});

test("top-level work tools share the persistent Activity lifecycle while Bash process control does not create a duplicate Activity", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-activity-lifecycle");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const callWork = (name: string, args: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: args,
    _meta: { "openai/session": "chat-activity-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);

  const read = await callWork("read", { workspaceId, path: "AGENTS.md" });
  assert.equal(read.isError, undefined);
  const written = await callWork("write", { workspaceId, path: "activity.txt", content: "before\n" });
  assert.equal(written.isError, undefined);
  const edited = await callWork("edit", {
    workspaceId,
    path: "activity.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });
  assert.equal(edited.isError, undefined);
  const renamed = await callWork("rename", { workspaceId, path: "activity.txt", newPath: "activity-renamed.txt" });
  assert.equal(renamed.isError, undefined);
  const deleted = await callWork("delete", { workspaceId, path: "activity-renamed.txt" });
  assert.equal(deleted.isError, undefined);
  const capability = await callWork("capability", {
    workspaceId,
    name: "hooks.check",
    action: "describe",
  });
  assert.equal(capability.isError, undefined);

  const started = await callWork("bash", {
    workspaceId,
    action: "run",
    command: "node -e \"setTimeout(() => {}, 150)\"",
    yieldTimeMs: 0,
  });
  assert.equal(started.isError, undefined);
  const processId = structuredContent(started).processId;
  assert.equal(typeof processId, "number");
  assert.equal(structuredContent(started).running, true);

  const polled = await callWork("bash", {
    workspaceId,
    action: "process",
    processId,
    yieldTimeMs: 1_000,
  });
  assert.equal(polled.isError, undefined);

  const finalRead = await callWork("read", { workspaceId, path: "AGENTS.md" });
  assert.equal(finalRead.isError, undefined);

  const expected = [
    ["act_test_1", "read", "done"],
    ["act_test_2", "write", "done"],
    ["act_test_3", "edit", "done"],
    ["act_test_4", "rename", "done"],
    ["act_test_5", "delete", "done"],
    ["act_test_6", "capability", "done"],
    ["act_test_7", "bash", "returned"],
    ["act_test_8", "bash_result", "done"],
    ["act_test_9", "read", "done"],
  ] as const;
  for (const [activityId, tool, state] of expected) {
    const activity = context.auditStore.getActivity(activityId);
    assert.equal(activity?.tool, tool, activityId);
    assert.equal(activity?.state, state, activityId);
    assert.equal(activity?.workspace.id, workspaceId, activityId);
    assert.equal(activity?.conversationScopeId, "chat-activity-lifecycle", activityId);
  }
  assert.deepEqual(context.auditStore.getActivity("act_test_2")?.request, {
    workspaceId,
    path: "activity.txt",
    content: "before\n",
  });
  assert.equal(context.auditStore.getActivity("act_test_10"), undefined);
});

test("write can create a file in the OS temp directory without opening it as a workspace", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-write");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: tempFile, content: "hello from temp\n" },
  });

  assert.equal(written.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "hello from temp\n");
});

test("read can inspect a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-read");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "read from temp\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: tempFile },
  });

  assert.equal(read.isError, undefined);
  assert.match(allResponseText(read), /read from temp/);
});

test("edit can modify a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-edit");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "before temp edit\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: tempFile,
      edits: [{ oldText: "before temp edit", newText: "after temp edit" }],
    },
  });

  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "after temp edit\n");
});

test("rename and delete are core tools in regular and codex modes", async (t) => {
  const regular = await fixture(t);
  const codex = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });

  for (const context of [regular, codex]) {
    const tools = await context.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("rename"));
    assert.ok(names.includes("delete"));
  }
});

test("rename and delete mutate workspace paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "before.txt"), "workspace mutation\n");

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "before.txt", newPath: "after.txt" },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(join(context.project, "after.txt"), "utf8"), "workspace mutation\n");
  await assert.rejects(readFile(join(context.project, "before.txt"), "utf8"), /ENOENT/);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "after.txt" },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(join(context.project, "after.txt"), "utf8"), /ENOENT/);
});

test("rename and delete mutate OS temp paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const before = join(tempRoot, "before.txt");
  const after = join(tempRoot, "after.txt");
  await writeFile(before, "temp mutation\n");
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: before, newPath: after },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(after, "utf8"), "temp mutation\n");

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: after },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(after, "utf8"), /ENOENT/);
});

test("delete refuses the workspace root itself", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-delete-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: ".", recursive: true },
  });

  assert.equal(deleted.isError, true);
  assert.match(allResponseText(deleted), /allowed root itself/i);
  assert.equal(await readFile(join(context.project, "AGENTS.md"), "utf8") !== "", true);
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "delete");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "failed");
});

test("codex apply_patch can create a file in the OS temp directory", async (t) => {
  const context = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "chat-temp-apply-patch");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "patched-temp.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: `*** Begin Patch\n*** Add File: ${tempFile}\n+patched temp\n*** End Patch`,
    },
  });

  assert.equal(patched.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "patched temp\n");
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "apply_patch");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "done");
});

test("codex exec_command is a top-level Activity while write_stdin remains process control", async (t) => {
  const context = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "chat-codex-activity");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const started = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: "node -e \"console.log('codex-durable-output'); setTimeout(() => {}, 150)\"",
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(started.isError, undefined);
  assert.equal(structuredContent(started).running, true);
  const processId = structuredContent(started).processId;
  const outputId = structuredContent(started).outputId;
  assert.equal(typeof processId, "number");
  assert.equal(typeof outputId, "string");
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "exec_command");
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");

  const polled = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(polled.isError, undefined);

  const fullOutput = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, outputId },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(fullOutput.isError, undefined);
  assert.match(allResponseText(fullOutput), /codex-durable-output/);
  assert.equal(structuredContent(fullOutput).outputId, outputId);

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-codex-activity" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(read.isError, undefined);
  assert.equal(context.auditStore.getActivity("act_test_2")?.tool, "bash_result");
  assert.equal(context.auditStore.getActivity("act_test_3")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_4"), undefined);
});

test("temp file access rejects symlinks that escape the OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable outside-temp target on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-symlink");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const escapedPath = join(tempRoot, "escaped-hosts");
  await symlink("/etc/hosts", escapedPath);
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const escaped = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: escapedPath },
  });

  assert.equal(escaped.isError, true);
  assert.match(allResponseText(escaped), /outside allowed roots/i);
});

test("file tools still reject arbitrary paths outside the workspace and OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable non-temp path on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-outside-file-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const outside = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "/etc/hosts" },
  });

  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots/i);
});

test("open_workspace does not treat the OS temp directory as an implicit workspace root", async (t) => {
  const context = await fixture(t);

  const opened = await callOpen(context.client, tmpdir(), "chat-temp-workspace");

  assert.equal(opened.isError, true);
  assert.match(allResponseText(opened), /outside allowed roots/i);
});

test("tool hooks observe success, failure, and file changes through the MCP surface", async (t) => {
  const recordCommand = `node -e "require('node:fs').appendFileSync('tool-hooks.log', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`;
  const handler = { command: recordCommand, timeoutSeconds: 30 };
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [handler],
      AfterTool: [handler],
      AfterToolFailure: [handler],
      AfterFileChange: [handler],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hooks");
  const workspaceId = String(structuredContent(opened).workspaceId);

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "hooked.txt", content: "hello\n" },
  });
  await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "hooked.txt", newPath: "renamed.txt" },
  });
  await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "renamed.txt" },
  });
  const failedEdit = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "hooked.txt",
      edits: [{ oldText: "missing", newText: "replacement" }],
    },
  });

  assert.equal(failedEdit.isError, true);
  assert.equal(
    (await readFile(join(context.project, "tool-hooks.log"), "utf8")).replace(/\r\n/g, "\n"),
    [
      "BeforeTool:write",
      "AfterTool:write",
      "AfterFileChange:write",
      "BeforeTool:rename",
      "AfterTool:rename",
      "AfterFileChange:rename",
      "BeforeTool:delete",
      "AfterTool:delete",
      "AfterFileChange:delete",
      "BeforeTool:edit",
      "AfterToolFailure:edit",
      "",
    ].join("\n"),
  );
});

test("WorkspaceOpen hook reports are visible on the open_workspace result", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks.json"),
    JSON.stringify({
      WorkspaceOpen: [
        {
          name: "Project workspace bootstrap",
          command: "node -e \"process.exit(0)\"",
        },
      ],
    }),
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-open-report");
  assert.match(
    allResponseText(opened),
    /Project workspace bootstrap \(WorkspaceOpen, project\) passed/,
  );
});

test("read lazily surfaces deep workspace instructions after bounded open discovery", async (t) => {
  const context = await fixture(t);
  const deepDir = join(context.project, "level-1", "level-2", "level-3");
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, "AGENTS.md"), "deep instructions\n");
  await writeFile(join(deepDir, "target.txt"), "target content\n");

  const opened = await callOpen(context.client, context.project, "chat-lazy-instructions");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const availableAgentsFiles = structuredContent(opened).availableAgentsFiles as Array<{ path?: string }> | undefined;
  assert.equal(
    availableAgentsFiles?.some((file) => file.path === "level-1/level-2/level-3/AGENTS.md") ?? false,
    false,
  );

  const firstRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "level-1/level-2/level-3/target.txt" },
  });
  assert.equal(firstRead.isError, undefined, allResponseText(firstRead));
  assert.match(allResponseText(firstRead), /Workspace instructions discovered for this path/);
  assert.match(allResponseText(firstRead), /deep instructions/);
  assert.deepEqual(structuredContent(firstRead).agentsFiles, [{
    path: "level-1/level-2/level-3/AGENTS.md",
    content: "deep instructions\n",
  }]);

  const secondRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "level-1/level-2/level-3/target.txt" },
  });
  assert.equal(structuredContent(secondRead).agentsFiles, undefined);
  assert.doesNotMatch(allResponseText(secondRead), /Workspace instructions discovered for this path/);
});

test("side-effect tools stop before mutation when lazy instructions are discovered", async (t) => {
  const context = await fixture(t);
  const deepDir = join(context.project, "write-level-1", "write-level-2", "write-level-3");
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, "AGENTS.md"), "write deep instructions\n");
  const target = join(deepDir, "created.txt");

  const opened = await callOpen(context.client, context.project, "chat-lazy-write-instructions");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const firstWrite = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "write-level-1/write-level-2/write-level-3/created.txt",
      content: "created after instructions\n",
    },
  });
  assert.equal(firstWrite.isError, true);
  assert.match(allResponseText(firstWrite), /write deep instructions/);
  assert.match(allResponseText(firstWrite), /No mutation or command was executed/);
  await assert.rejects(() => readFile(target, "utf8"), /ENOENT/);

  const secondWrite = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "write-level-1/write-level-2/write-level-3/created.txt",
      content: "created after instructions\n",
    },
  });
  assert.equal(secondWrite.isError, undefined, allResponseText(secondWrite));
  assert.equal(await readFile(target, "utf8"), "created after instructions\n");
});

test("bash returns only the last 10 output lines and retrieves complete durable output by outputId", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-output");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const expectedLines = Array.from({ length: 15 }, (_, index) => `audit-line-${String(index + 1).padStart(2, "0")}`);
  const expected = `${expectedLines.join("\n")}\n`;
  const encoded = Buffer.from(expected, "utf8").toString("base64");

  const run = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: `node -e "process.stdout.write(Buffer.from('${encoded}', 'base64'))"`,
      yieldTimeMs: 10_000,
    },
    _meta: { "openai/session": "chat-bash-output" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(run.isError, undefined);
  const runText = allResponseText(run);
  assert.doesNotMatch(runText, /audit-line-01/);
  assert.doesNotMatch(runText, /audit-line-05/);
  assert.match(runText, /audit-line-06/);
  assert.match(runText, /audit-line-15/);
  assert.match(runText, /Full output ID: out_/);
  const outputId = structuredContent(run).outputId;
  assert.equal(typeof outputId, "string");
  assert.equal(structuredContent(run).outputTruncated, true);

  const full = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "output", outputId },
    _meta: { "openai/session": "chat-bash-output" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(full.isError, undefined);
  const fullText = allResponseText(full);
  assert.match(fullText, /audit-line-01/);
  assert.match(fullText, /audit-line-15/);
  assert.equal(structuredContent(full).outputId, outputId);
  assert.equal(structuredContent(full).outputTruncated, false);
});

test("bash separates feedback yield from the total execution timeout", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-shell-yield-timeout");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const startedAt = performance.now();
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "console.log('started'); setInterval(() => {}, 1_000)"`,
      yieldTimeMs: 0,
      timeoutMs: 100,
    },
  });

  assert.equal(shell.isError, undefined, allResponseText(shell));
  assert.equal(structuredContent(shell).running, true);
  assert.equal(typeof structuredContent(shell).processId, "number");
  assert.ok(performance.now() - startedAt < 500, "yieldTimeMs=0 should return a processId promptly");
  const processId = Number(structuredContent(shell).processId);

  await new Promise((resolve) => setTimeout(resolve, 180));
  const completed = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 1_000 },
  });
  assert.equal(structuredContent(completed).running, false);
  assert.equal(structuredContent(completed).timedOut, true);
  assert.match(allResponseText(completed), /timed out/i);
});

test("Host cancellation during a blocking BeforeTool Hook prevents the original bash command", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-hook-cancel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "blocking-hook.mjs");
  const operationScript = join(context.project, "cancelled-operation.mjs");
  const operationMarker = join(context.project, "cancelled-operation-ran.txt");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    operationScript,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(operationMarker)}, "ran");\n`,
  );
  await writeFile(
    join(hookDir, "blocking-cancel.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "cancelled-operation\\.mjs" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "bash",
      arguments: {
        workspaceId,
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(operationScript)}`,
        yieldTimeMs: 0,
      },
    },
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(() => readFile(operationMarker, "utf8"), /ENOENT/);
});

test("Host cancellation before processId delivery discards a process created before an AfterTool Hook", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-shell-after-hook-cancel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "after-tool-delay.mjs");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    join(hookDir, "after-tool-delay.json"),
    JSON.stringify({
      event: "AfterTool",
      matcher: { tool: "bash" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "bash",
      arguments: {
        workspaceId,
        command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1_000)"`,
        yieldTimeMs: 0,
      },
    },
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(context.processSessions.stats(), { total: 0, running: 0, completed: 0 });
  const activity = context.auditStore.getActivity("act_test_1");
  assert.equal(activity?.tool, "bash");
  assert.equal(activity?.state, "failed");
  assert.notEqual(activity?.state, "returned");
});

test("final Bash process poll creates one Bash result Activity without mutating the returned run", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-result-poll");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('polled-result'), 120)"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(shell).running, true);
  const processId = Number(structuredContent(shell).processId);
  const outputId = String(structuredContent(shell).outputId);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");

  const stillRunning = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 0 },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(stillRunning).running, true);
  assert.equal(context.auditStore.getActivity("act_test_2"), undefined);

  const completed = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-bash-result-poll" },
  });
  assert.equal(structuredContent(completed).running, false);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  const resultActivity = context.auditStore.getActivity("act_test_2");
  assert.equal(resultActivity?.tool, "bash_result");
  assert.equal(resultActivity?.state, "done");
  assert.equal(resultActivity?.conversationScopeId, "chat-bash-result-poll");
  assert.deepEqual(resultActivity?.result, {
    processId,
    outputId,
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(context.bashOutputStore.claimCompletion(outputId), undefined);
});

test("attached background completion creates one Bash result Activity on a later workspace tool", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-bash-result-attached");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('attached-result'), 50)"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-bash-result-attached" },
  });
  assert.equal(structuredContent(shell).running, true);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  await new Promise((resolve) => setTimeout(resolve, 130));

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.equal(context.auditStore.getActivity("act_test_1")?.state, "returned");
  assert.equal(context.auditStore.getActivity("act_test_2")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_3")?.tool, "bash_result");
  assert.equal(context.auditStore.getActivity("act_test_3")?.state, "done");

  const again = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(allResponseText(again), /Background process/);
  assert.equal(context.auditStore.getActivity("act_test_4")?.tool, "read");
  assert.equal(context.auditStore.getActivity("act_test_5"), undefined);
});

test("bash returns a processId instead of killing a command after the foreground wait", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-background");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('background-done'), 100)"`,
    },
  });

  assert.equal(shell.isError, undefined, allResponseText(shell));
  assert.equal(structuredContent(shell).running, true);
  assert.equal(typeof structuredContent(shell).processId, "number");
  assert.equal(structuredContent(shell).sessionId, structuredContent(shell).processId);
  assert.match(allResponseText(shell), /Process running with process ID/);

  const read = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "AGENTS.md" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(read), /background-done/);

  const readAgain = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.doesNotMatch(allResponseText(readAgain), /Background process/);
});

test("completed background results remain deliverable after the full-output retention window", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 1,
    completedProcessTtlMs: 50,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-retained-completion");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('retained-completion'), 20)"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(structuredContent(shell).running, true);

  await new Promise((resolve) => setTimeout(resolve, 140));
  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(read), /retained-completion/);
});

test("a failed workspace tool call still carries a completed background process notice", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-error-notice");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('notice-on-error'), 300)"`,
    },
  });
  assert.equal(structuredContent(shell).running, true);

  const failedRead = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "missing-background-notice.txt" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.equal(failedRead.isError, true);
  assert.match(allResponseText(failedRead), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(failedRead), /notice-on-error/);
});

test("close_workspace delivers a completed background result instead of blocking on it", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 1 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-close-completed");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('close-completed'), 20)"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(structuredContent(shell).running, true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.match(allResponseText(closed), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(closed), /close-completed/);
});

test("close_workspace refuses a logical workspace with a running process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-close-guard");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('close-guard-done'), 80)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const blockedClose = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(blockedClose.isError, true);
  assert.match(allResponseText(blockedClose), /still owns a running process/);

  await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined);
});

test("bash action=process can explicitly keep waiting for a running process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-poll");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('polled-done'), 500)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const secondWorkspace = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, newWorkspace: true },
  });
  const secondWorkspaceId = String(structuredContent(secondWorkspace).workspaceId);
  assert.notEqual(secondWorkspaceId, workspaceId);
  const crossWorkspace = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: secondWorkspaceId,
      action: "process",
      processId,
      yieldTimeMs: 0,
    },
  });
  assert.equal(crossWorkspace.isError, true);
  assert.match(allResponseText(crossWorkspace), /does not belong to workspace/);

  const polled = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  assert.equal(structuredContent(polled).running, false);
  assert.equal(structuredContent(polled).exitCode, 0);
  assert.match(allResponseText(polled), /polled-done/);

  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "write_stdin"), false);
});

test("invalid project hooks stay visible and can be repaired through ForgeRelay", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "repaired-project-hook.json"),
    "{ invalid json\n",
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-repair");
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.match(allResponseText(opened), /Project hooks config.*failed/);

  const repairedConfig = JSON.stringify({
    event: "BeforeTool",
    matcher: { tool: "bash", commandRegex: "^printf repaired$" },
    command: "node -e \"process.exit(0)\"",
  });
  const repaired = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: ".forgerelay/hooks/repaired-project-hook.json",
      content: `${repairedConfig}\n`,
    },
  });
  assert.equal(repaired.isError, undefined);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, command: "printf repaired" },
  });
  assert.match(
    allResponseText(shell),
    /repaired-project-hook \(BeforeTool, project\) passed/,
  );
});

test("global and project hook rules compose for the same tool call", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [
        {
          matcher: { tool: "bash", commandRegex: "^printf scoped-hooks$" },
          handlers: [
            {
              name: "Global bash check",
              command: "node -e \"process.exit(0)\"",
            },
          ],
        },
      ],
    },
  });
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "project-bash-check.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "^printf scoped-hooks$" },
      command: "node -e \"process.exit(0)\"",
    }),
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-scopes");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, command: "printf scoped-hooks" },
  });
  const visible = allResponseText(shell);

  assert.match(visible, /Global bash check \(BeforeTool, global\) passed/);
  assert.match(visible, /project-bash-check \(BeforeTool, project\) passed/);
});

test("reported hooks are visible to the MCP agent while report false stays silent", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [
        {
          matcher: { tool: "write" },
          handlers: [
            {
              name: "Write preflight",
              command: "node -e \"process.exit(0)\"",
            },
          ],
        },
      ],
      AfterTool: [
        {
          matcher: { tool: "write" },
          handlers: [
            {
              name: "Silent write observer",
              command: "node -e \"process.exit(0)\"",
              report: false,
            },
          ],
        },
      ],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hook-report");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "reported.txt", content: "hello\n" },
  });
  const visible = allResponseText(written);
  const structuredVisible = String(structuredContent(written).result);

  assert.match(visible, /Hook results:/);
  assert.match(visible, /Write preflight.*passed/);
  assert.doesNotMatch(visible, /Silent write observer/);
  assert.match(structuredVisible, /Hook results:/);
  assert.match(structuredVisible, /Write preflight.*passed/);
  assert.doesNotMatch(structuredVisible, /Silent write observer/);
});

test("BeforeTool hook failure prevents the tool operation", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        name: "Silent blocking policy",
        command: `node -e "if (process.env.FORGERELAY_TOOL_NAME === 'write') process.exit(13)"`,
        timeoutSeconds: 30,
        report: false,
      }],
      AfterToolFailure: [{
        command: `node -e "require('node:fs').appendFileSync('blocked-hook.log', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`,
        timeoutSeconds: 30,
      }],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hook-block");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const blocked = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "blocked.txt", content: "must not exist\n" },
  });
  assert.equal(blocked.isError, true);
  assert.match(allResponseText(blocked), /Silent blocking policy.*failed/);
  assert.match(allResponseText(blocked), /exited with code 13/);
  await assert.rejects(() => readFile(join(context.project, "blocked.txt"), "utf8"), /ENOENT/);
  assert.equal(
    (await readFile(join(context.project, "blocked-hook.log"), "utf8")).replace(/\r\n/g, "\n"),
    "AfterToolFailure:write\n",
  );
  const activity = context.auditStore.getActivity("act_test_1");
  assert.equal(activity?.tool, "write");
  assert.equal(activity?.state, "blocked");
  assert.equal(activity?.workspace.id, workspaceId);
  assert.match(activity?.error ?? "", /Silent blocking policy.*failed/);
});

test("close_workspace finalizes a managed-worktree-backed workspace and supports commit-message retry", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-1", "worktree");
  const workspaceId = structuredContent(opened).workspaceId;
  assert.equal(typeof workspaceId, "string");
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  assert.equal(worktree.detached, false);
  assert.match(String(worktree.branch), /^forgerelay\//);
  assert.equal(typeof worktree.targetBranch, "string");

  await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "feature.txt",
      content: "finished\n",
    },
  });
  const missingMessage = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(missingMessage.isError, true);
  assert.match(allResponseText(missingMessage), /requires commitMessage/);
  assert.equal(await readFile(join(String(worktree.path), "feature.txt"), "utf8"), "finished\n");

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      commitMessage: "feat: finish isolated work",
    },
  });
  const structured = structuredContent(closed);

  assert.equal(structured.workspaceId, workspaceId);
  assert.equal(structured.mode, "worktree");
  assert.equal(structured.committed, true);
  assert.equal(structured.branch, worktree.branch);
  assert.equal(structured.targetBranch, worktree.targetBranch);
  assert.equal(
    (await readFile(join(context.project, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "finished\n",
  );
  assert.match(responseText(closed), /fast-forward/);
  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "close_worktree"), false);
});

test("worktree lifecycle hook reports are visible on close_workspace", async (t) => {
  const context = await fixture(t, { git: true });
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-verification.json"),
    JSON.stringify({
      event: "BeforeWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-integrated.json"),
    JSON.stringify({
      event: "AfterWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await git(context.project, ["add", ".forgerelay/hooks"]);
  await git(context.project, ["commit", "-m", "Add project hooks"]);

  const opened = await callOpen(context.client, context.project, "chat-hook-close-report", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "feature.txt", content: "hook report\n" },
  });
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close with hook reports" },
  });
  const visible = allResponseText(closed);

  assert.match(visible, /worktree-verification \(BeforeWorktreeClose, project\) passed/);
  assert.match(visible, /worktree-integrated \(AfterWorktreeClose, project\) passed/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same directory previously opened/);
});

test("a host without conversation metadata reuses the directory workspace and still receives full context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.match(responseText(second), /complete project context is included/i);
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout context and durable Bash output survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;
  const bash = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: firstWorkspaceId,
      action: "run",
      command: "node -e \"console.log('restart-durable-output')\"",
      yieldTimeMs: 10_000,
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  const outputId = structuredContent(bash).outputId;
  assert.equal(typeof outputId, "string");

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredAuditStore = new ActivityAuditStore(context.stateDir);
  const restoredBashOutputStore = new BashOutputStore(context.stateDir);
  const restoredActivityLifecycle = new ActivityLifecycle(restoredAuditStore);
  const restoredCodeIntelligence = new CodeIntelligenceManager(context.config);
  const restoredProcessSessions = new ProcessManager({ outputAudit: restoredBashOutputStore });
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    restoredProcessSessions,
    [],
    [],
    restoredCodeIntelligence,
    restoredActivityLifecycle,
    restoredBashOutputStore,
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    await restoredCodeIntelligence.shutdown();
    restoredProcessSessions.shutdown();
    restoredBashOutputStore.close();
    restoredAuditStore.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same directory previously opened/);

    const restoredOutput = await restoredClient.callTool({
      name: "bash",
      arguments: { workspaceId: firstWorkspaceId, action: "output", outputId },
      _meta: { "openai/session": "chat-1" },
    } as Parameters<Client["callTool"]>[0]);
    assert.equal(restoredOutput.isError, undefined);
    assert.match(allResponseText(restoredOutput), /restart-durable-output/);
    assert.equal(structuredContent(restoredOutput).outputId, outputId);
  } finally {
    await closeRestored();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  processSessions: ProcessManager;
  auditStore: ActivityAuditStore;
  bashOutputStore: BashOutputStore;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    env?: NodeJS.ProcessEnv;
    hooks?: HookConfigInput;
    processSessions?: ProcessManager;
    incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
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

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
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
  const processSessions = options.processSessions ?? new ProcessManager({ outputAudit: bashOutputStore });
  let activitySequence = 0;
  let turnSequence = 0;
  const activityLifecycle = new ActivityLifecycle(auditStore, {
    activityId: () => `act_test_${++activitySequence}`,
    turnId: () => `turn_test_${++turnSequence}`,
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
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
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
    bashOutputStore.close();
    auditStore.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, processSessions, auditStore, bashOutputStore, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
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

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
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

async function waitForToolText(
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

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
