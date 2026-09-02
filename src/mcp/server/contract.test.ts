import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../activity/audit-store.js";
import { BashOutputStore } from "../../activity/bash-output-store.js";
import { HostTurnStore } from "../../activity/host-turn-store.js";
import { ActivityLifecycle } from "../../activity/lifecycle.js";
import { ActivityQueryService } from "../../activity/query-service.js";
import { buildCapabilityFingerprint } from "../../capabilities.js";
import { loadConfig } from "../../config.js";
import { CodeIntelligenceManager } from "../../lsp/runtime/manager.js";
import { openDatabase } from "../../db/client.js";
import type { IncomingArtifactAdapter } from "../../incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../review-checkpoints.js";
import { ProcessManager } from "../../process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../remote-auth.js";
import { createMcpServer, createServer } from "../../server.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  responseCard,
  responseText,
  structuredContent,
  waitForCompletedProcess,
  waitForToolText,
} from "../../test-support/server-fixture.js";
import { SqliteWorkspaceStore } from "../../workspace-store.js";
import { WorkspaceRegistry } from "../../workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const canonicalToolNames = [
  "open_workspace",
  "activity_panel",
  "activity_snapshot",
  "activity_index",
  "activity_detail",
  "activity_output",
  "workspace_instruction",
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
  const activityPanelTool = defaultTools.tools.find((tool) => tool.name === "activity_panel");
  const activityDataTools = ["activity_snapshot", "activity_index", "activity_detail", "activity_output"].map((name) =>
    defaultTools.tools.find((tool) => tool.name === name)
  );
  const readTool = defaultTools.tools.find((tool) => tool.name === "read");
  const renameTool = defaultTools.tools.find((tool) => tool.name === "rename");
  const deleteTool = defaultTools.tools.find((tool) => tool.name === "delete");
  const openWorkspaceTool = defaultTools.tools.find((tool) => tool.name === "open_workspace");
  const closeWorkspaceTool = defaultTools.tools.find((tool) => tool.name === "close_workspace");
  const shellToolMeta = shellTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
  } | undefined;
  const openWorkspaceMeta = openWorkspaceTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
  } | undefined;
  const closeWorkspaceMeta = closeWorkspaceTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
  } | undefined;
  const activityPanelMeta = activityPanelTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
  } | undefined;
  const activityPanelInput = activityPanelTool?.inputSchema as {
    required?: string[];
    properties?: Record<string, { description?: string }>;
  } | undefined;
  const activitySnapshotOutput = activityDataTools[0]?.outputSchema as {
    properties?: Record<string, unknown>;
  } | undefined;
  const activityIndexOutput = activityDataTools[1]?.outputSchema as {
    properties?: {
      activities?: {
        items?: {
          properties?: Record<string, unknown>;
        };
      };
    };
  } | undefined;
  const closeWorkspaceInputProperties = (closeWorkspaceTool?.inputSchema as {
    properties?: Record<string, { description?: string; enum?: string[] }>;
  } | undefined)?.properties;
  const readInputProperties = (readTool?.inputSchema as {
    properties?: Record<string, { description?: string }>;
  } | undefined)?.properties;
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
  assert.match(defaultInstructions, /For long bash commands or wait-only calls/);
  assert.match(defaultInstructions, /do not poll every few seconds/);
  assert.match(defaultInstructions, /Completion returns immediately if sooner/);
  assert.equal(openWorkspaceTool?.annotations?.readOnlyHint, false);
  assert.equal(openWorkspaceTool?.annotations?.destructiveHint, false);
  assert.match(shellTool?.description ?? "", /local user's authority/);
  assert.doesNotMatch(shellTool?.description ?? "", /may modify ordinary project files/);
  assert.doesNotMatch(shellTool?.description ?? "", /\/etc\/sudoers/);
  assert.doesNotMatch(shellTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(shellTool?.description ?? "", /external device or hardware mutations/);
  assert.match(shellTool?.description ?? "", /action=process/);
  assert.match(shellTool?.description ?? "", /long-running commands/);
  assert.match(shellTool?.description ?? "", /60000ms when supported/);
  assert.match(shellTool?.description ?? "", /process finishes sooner, the call returns immediately/);
  assert.doesNotMatch(shellTool?.description ?? "", /write_stdin/);
  assert.doesNotMatch(shellTool?.description ?? "", /Do not use bash to create, move, rename, or delete project files/);
  assert.doesNotMatch(shellTool?.description ?? "", /Use only for/);
  assert.match(shellInputProperties?.command?.description ?? "", /Required for action=run/);
  assert.match(shellInputProperties?.processId?.description ?? "", /action=process/);
  assert.match(shellInputProperties?.input?.description ?? "", /action=process/);
  assert.match(shellInputProperties?.interrupt?.description ?? "", /SIGINT/);
  assert.equal(shellInputProperties?.timeout, undefined);
  assert.match(shellInputProperties?.yieldTimeMs?.description ?? "", /feedback wait/i);
  assert.match(shellInputProperties?.yieldTimeMs?.description ?? "", /returns immediately/);
  assert.match(shellInputProperties?.yieldTimeMs?.description ?? "", /60000ms when supported/);
  assert.match(shellInputProperties?.timeoutMs?.description ?? "", /total execution timeout/i);
  assert.equal(shellToolMeta?.ui?.resourceUri, undefined);
  assert.equal(openWorkspaceMeta?.ui?.resourceUri, undefined);
  assert.equal(closeWorkspaceMeta?.ui?.resourceUri, undefined);
  assert.equal(defaultTools.tools.some((tool) => tool.name === "workspace_lifecycle_panel"), false);
  assert.match(
    activityPanelMeta?.ui?.resourceUri ?? "",
    /^ui:\/\/forgerelay\/activity-panel-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/,
  );
  assert.deepEqual(activityPanelMeta?.ui?.visibility, ["model", "app"]);
  assert.deepEqual(activityPanelInput?.required, ["workspaceId"]);
  assert.match(activityPanelInput?.properties?.workspaceId?.description ?? "", /returned by open_workspace/);
  assert.match(activityPanelTool?.description ?? "", /If this Host Turn calls open_workspace, open_workspace must run first/);
  assert.match(activityPanelTool?.description ?? "", /single ForgeRelay UI render tool/);
  assert.equal(activitySnapshotOutput?.properties?.activities, undefined);
  assert.ok(activityIndexOutput?.properties?.activities?.items?.properties?.parentActivityId);
  assert.ok(activityIndexOutput?.properties?.activities?.items?.properties?.children);
  for (const tool of activityDataTools) {
    assert.ok(tool);
    assert.deepEqual((tool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility, ["app"]);
  }
  assert.ok(renameTool);
  assert.ok(deleteTool);
  assert.equal(defaultTools.tools.some((tool) => tool.name === "write_stdin"), false);
  assert.equal(defaultTools.tools.some((tool) => tool.name === "close_worktree"), false);
  assert.ok(closeWorkspaceTool);
  assert.match(readTool?.description ?? "", /capability guides/);
  assert.match(readInputProperties?.member?.description ?? "", /Composite member-scoped file reads/);
  assert.match(readInputProperties?.member?.description ?? "", /Composite-owned capability guide/);
  assert.ok((openWorkspaceTool?.description?.length ?? Infinity) < 450);
  assert.ok((closeWorkspaceTool?.description?.length ?? Infinity) < 500);
  assert.match(closeWorkspaceTool?.description ?? "", /Managed-worktree-backed/);
  assert.match(closeWorkspaceTool?.description ?? "", /commitMessage/);
  assert.deepEqual(closeWorkspaceInputProperties?.action?.enum, ["close", "delete"]);
  assert.match(closeWorkspaceInputProperties?.action?.description ?? "", /preserves checkout identity/i);
  assert.match(closeWorkspaceInputProperties?.action?.description ?? "", /project files/i);

  const overrideContext = await fixture(t, {
    env: {
      FORGERELAY_WORKFLOW_INSTRUCTIONS: "Follow repository-defined development and Git workflows.",
      FORGERELAY_APPEND_INSTRUCTIONS: "Preserve the capability contract.",
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

  const minimalContext = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "minimal" } });
  const minimalTools = await minimalContext.client.listTools();
  assert.deepEqual(minimalTools.tools.map((tool) => tool.name), canonicalToolNames);

  const codexContext = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const codexTools = await codexContext.client.listTools();
  const execCommandTool = codexTools.tools.find((tool) => tool.name === "exec_command");
  assert.match(execCommandTool?.description ?? "", /may modify ordinary project files/);
  assert.match(execCommandTool?.description ?? "", /\/etc\/sudoers/);
  assert.match(execCommandTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
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
  assert.equal(catalog.length, 4);
  assert.deepEqual(catalog[0], {
    name: "hooks.check",
    description: "Validate the active ForgeRelay Hook configuration for this workspace.",
    available: true,
    batchPolicy: "parallel",
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
    batchPolicy: "parallel",
    guide: {
      name: "code-intelligence",
      path: catalog[1]?.guide && (catalog[1].guide as Record<string, unknown>).path,
      readBeforeFirstUse: true,
    },
  });
  assert.deepEqual(catalog[2], {
    name: "workspace.tasks",
    description: "Maintain persistent Task Lists owned by the current Workspace.",
    available: true,
    batchPolicy: "serial",
    guide: {
      name: "workspace-tasks",
      path: catalog[2]?.guide && (catalog[2].guide as Record<string, unknown>).path,
      readBeforeFirstUse: true,
    },
  });
  assert.deepEqual(catalog[3], {
    name: "batch.execute",
    description: "Execute multiple independent ForgeRelay core operations in one Agent interaction.",
    available: true,
    batchPolicy: "unsupported",
    guide: {
      name: "batch-execution",
      path: catalog[3]?.guide && (catalog[3].guide as Record<string, unknown>).path,
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

  const batchDescription = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "batch.execute", action: "describe" },
  });
  assert.equal(batchDescription.isError, undefined);
  const batchCapability = structuredContent(batchDescription).capability as Record<string, unknown>;
  const batchGuide = batchCapability.guide as Record<string, unknown>;
  assert.equal(batchGuide.name, "batch-execution");
  const batchGuideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: batchGuide.path },
  });
  assert.equal(batchGuideRead.isError, undefined);
  assert.match(responseText(batchGuideRead), /1–100 tasks|1-100 tasks/);

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

test("batch.execute does not bypass Codex tool-mode surface", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "batch-codex-mode");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const openedStructured = structuredContent(opened);
  const catalog = openedStructured.capabilityCatalog as Array<{ name: string }>;
  assert.equal(catalog.some((entry) => entry.name === "batch.execute"), false);
  const guides = openedStructured.capabilityGuides as Array<{ name: string }>;
  assert.equal(guides.some((entry) => entry.name === "batch-execution"), false);
  const rejected = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "batch.execute",
      action: "run",
      arguments: {
        tasks: [{ id: "write", operation: "write", path: "hidden.txt", content: "no\n" }],
      },
    },
  });
  assert.equal(rejected.isError, true);
  assert.equal((structuredContent(rejected).error as Record<string, unknown>).code, "capability_unavailable");
  await assert.rejects(readFile(join(context.project, "hidden.txt"), "utf8"), /ENOENT/);
});

test("review.changes capability owns checkpoints, Hook reports, and review-card metadata", async (t) => {
  const context = await fixture(t, {
    git: true,
    env: { FORGERELAY_WIDGETS: "changes" },
    hooks: {
      BeforeTool: [{
        matcher: { tool: "capability" },
        handlers: [{ name: "Capability preflight", command: "node -e \"process.exit(0)\"" }],
      }],
    },
  });
  const opened = await callOpen(context.client, context.project, "review-capability-chat");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name: string; batchPolicy: string }>;
  assert.deepEqual(catalog.map((entry) => [entry.name, entry.batchPolicy]), [
    ["hooks.check", "parallel"],
    ["review.changes", "serial"],
    ["code.intelligence", "parallel"],
    ["workspace.tasks", "serial"],
    ["batch.execute", "unsupported"],
  ]);

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
  const activityPanelMeta = tools.tools.find((tool) => tool.name === "activity_panel")?._meta as {
    ui?: { resourceUri?: string };
  } | undefined;
  assert.match(
    activityPanelMeta?.ui?.resourceUri ?? "",
    /^ui:\/\/forgerelay\/activity-panel-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/,
  );
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
    env: { FORGERELAY_ARTIFACTS: "1" },
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

  const described = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "artifact.download", action: "describe" },
  });
  const capability = structuredContent(described).capability as {
    batchPolicy?: string;
    transport?: { nativeFileArgument?: string; gatewayParameter?: string };
  };
  assert.equal(capability.batchPolicy, "unsupported");
  assert.deepEqual(capability.transport, {
    nativeFileArgument: "file",
    gatewayParameter: "file",
  });
  if (!artifactAvailable) return;

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

