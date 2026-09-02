import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "./activity/audit-store.js";
import { BashOutputStore } from "./activity/bash-output-store.js";
import { HostTurnStore } from "./activity/host-turn-store.js";
import { ActivityLifecycle } from "./activity/lifecycle.js";
import { ActivityQueryService } from "./activity/query-service.js";
import { buildCapabilityFingerprint } from "./capabilities.js";
import { CodeIntelligenceManager } from "./lsp/runtime/manager.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { parseHookConfig, type HookConfigInput } from "./hooks.js";
import type { IncomingArtifactAdapter } from "./incoming-artifacts.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessManager } from "./process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "./remote-auth.js";
import { createMcpServer, createServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
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

test("MCP App resource identities include the full public base URL list", async (t) => {
  const first = await fixture(t, {
    env: {
      FORGERELAY_PUBLIC_BASE_URL:
        "https://shared.example.com/forgerelay/main,https://alias-a.example.com/relay",
    },
  });
  const second = await fixture(t, {
    env: {
      FORGERELAY_PUBLIC_BASE_URL:
        "https://shared.example.com/forgerelay/main,https://alias-b.example.com/relay",
    },
  });

  const currentUris = async (client: Client) => {
    const resources = await client.listResources();
    return resources.resources
      .map((resource) => resource.uri)
      .filter((uri) => /activity-panel-app-[0-9a-f]{12}\.html$/.test(uri))
      .sort();
  };

  const firstUris = await currentUris(first.client);
  const secondUris = await currentUris(second.client);
  assert.equal(firstUris.length, 1);
  assert.equal(secondUris.length, 1);
  assert.notDeepEqual(firstUris, secondUris);
});

test("Activity Panel is the single advertised MCP App for new rendering", async (t) => {
  const context = await fixture(t, {
    env: {
      FORGERELAY_PUBLIC_BASE_URL:
        "https://forge.example.com/base/path,https://forge-alt.example.com/alternate/path",
    },
  });

  const resources = await context.client.listResources();
  assert.equal(
    resources.resources.some((resource) => /workspace-lifecycle-app-/.test(resource.uri)),
    false,
  );
  const activity = resources.resources.find((resource) =>
    /^ui:\/\/forgerelay\/activity-panel-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/.test(resource.uri)
  );
  assert.ok(activity);
  const resourceMeta = activity._meta as {
    ui?: {
      domain?: string;
      csp?: { resourceDomains?: string[]; connectDomains?: string[] };
    };
  } | undefined;
  assert.equal(resourceMeta?.ui?.domain, "https://forge.example.com");
  assert.deepEqual(resourceMeta?.ui?.csp?.resourceDomains, [
    "https://forge.example.com/base/path",
    "https://forge-alt.example.com/alternate/path",
  ]);
  assert.deepEqual(resourceMeta?.ui?.csp?.connectDomains, [
    "https://forge.example.com/base/path",
    "https://forge-alt.example.com/alternate/path",
  ]);

  const activityRead = await context.client.readResource({ uri: activity.uri });
  const activityContent = activityRead.contents.find((content) => "text" in content);
  const activityText = activityContent && "text" in activityContent ? activityContent.text : "";
  const activityContentMeta = activityContent?._meta as {
    ui?: {
      domain?: string;
      csp?: { resourceDomains?: string[]; connectDomains?: string[] };
    };
    domain?: string;
    csp?: { resourceDomains?: string[]; connectDomains?: string[] };
  } | undefined;
  assert.equal(activityContentMeta?.ui?.domain, "https://forge.example.com");
  assert.deepEqual(activityContentMeta?.ui?.csp?.resourceDomains, [
    "https://forge.example.com/base/path",
    "https://forge-alt.example.com/alternate/path",
  ]);
  assert.equal(activityContentMeta?.domain, "https://forge.example.com");
  assert.deepEqual(activityContentMeta?.csp?.resourceDomains, [
    "https://forge.example.com/base/path",
    "https://forge-alt.example.com/alternate/path",
  ]);
  assert.deepEqual(activityContentMeta?.csp?.connectDomains, [
    "https://forge.example.com/base/path",
    "https://forge-alt.example.com/alternate/path",
  ]);
  assert.match(
    activityText,
    /https:\/\/forge\.example\.com\/base\/path\/mcp-app-assets\/assets\/activity-panel-app-[^"']+\.js/,
  );
  assert.doesNotMatch(activityText, /workspace-lifecycle-app-/);

  const templates = await context.client.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates, []);
});

test("activity_panel carries one lightweight Workspace presentation in metadata and changes it with workspaceId", async (t) => {
  const context = await fixture(t);
  const conversationScopeId = "unified-panel-chat";
  const opened = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(opened).workspaceId as string;
  assert.ok(workspaceId);

  const firstPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const firstTurnId = String(structuredContent(firstPanel).turnId);
  const firstWorkspace = (firstPanel._meta as Record<string, unknown> | undefined)?.[
    "forgerelay/activityPanelWorkspace"
  ] as {
    workspaceId?: string;
    root?: string;
    mode?: string;
    presentationRevision?: string;
    agentsFiles?: Array<{ path?: string; content?: string }>;
    skills?: Array<{ name?: string; description?: string; path?: string }>;
  } | undefined;
  assert.equal(firstWorkspace?.workspaceId, workspaceId);
  assert.equal(firstWorkspace?.root, context.project);
  assert.equal(firstWorkspace?.mode, "checkout");
  assert.equal(typeof firstWorkspace?.presentationRevision, "string");
  assert.ok((firstWorkspace?.agentsFiles?.length ?? 0) > 0);
  assert.ok(firstWorkspace?.agentsFiles?.every((file) => typeof file.path === "string" && file.content === undefined));
  assert.ok(firstWorkspace?.skills?.every((skill) => skill.path === undefined));
  assert.equal(structuredContent(firstPanel)["forgerelay/activityPanelWorkspace"], undefined);

  const otherProject = join(dirname(context.project), "other-panel-project");
  await mkdir(otherProject, { recursive: true });
  await writeFile(join(otherProject, "package.json"), "{}\n");
  const secondOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: otherProject },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const secondWorkspaceId = structuredContent(secondOpen).workspaceId as string;
  assert.notEqual(secondWorkspaceId, workspaceId);

  const secondPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: secondWorkspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(structuredContent(secondPanel).turnId);
  const secondWorkspace = (secondPanel._meta as Record<string, unknown> | undefined)?.[
    "forgerelay/activityPanelWorkspace"
  ] as { workspaceId?: string; root?: string; presentationRevision?: string } | undefined;
  assert.equal(secondWorkspace?.workspaceId, secondWorkspaceId);
  assert.equal(secondWorkspace?.root, otherProject);
  assert.equal(typeof secondWorkspace?.presentationRevision, "string");
  assert.equal(structuredContent(secondPanel)["forgerelay/activityPanelWorkspace"], undefined);
  assert.notEqual(secondTurnId, firstTurnId);

  await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "package.json" },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  await context.client.callTool({
    name: "read",
    arguments: { workspaceId: secondWorkspaceId, path: "package.json" },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);

  const firstBootstrap = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { workspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const secondBootstrap = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { workspaceId: secondWorkspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(firstBootstrap).turnId, firstTurnId);
  assert.equal(structuredContent(secondBootstrap).turnId, secondTurnId);
  assert.equal(structuredContent(firstBootstrap)["forgerelay/activityPanelWorkspace"], undefined);
  assert.equal(structuredContent(secondBootstrap)["forgerelay/activityPanelWorkspace"], undefined);
  assert.equal(
    ((firstBootstrap._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelWorkspace"] as { workspaceId?: string })?.workspaceId,
    workspaceId,
  );
  assert.equal(
    ((secondBootstrap._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelWorkspace"] as { workspaceId?: string })?.workspaceId,
    secondWorkspaceId,
  );
  assert.equal(structuredContent(firstBootstrap).activities, undefined);
  assert.equal(structuredContent(secondBootstrap).activities, undefined);
  const firstIndex = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId: firstTurnId },
  });
  const secondIndex = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId: secondTurnId },
  });
  assert.deepEqual(
    (structuredContent(firstIndex).activities as Array<{ workspaceId?: string }>).map((activity) => activity.workspaceId),
    [workspaceId],
  );
  assert.deepEqual(
    (structuredContent(secondIndex).activities as Array<{ workspaceId?: string }>).map((activity) => activity.workspaceId),
    [secondWorkspaceId],
  );
});

test("activity_panel reconstructs lightweight Workspace UI metadata on a fresh MCP connection", async (t) => {
  const context = await fixture(t);
  const skillDir = join(context.project, ".agents", "skills", "panel-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: panel-skill",
    "description: Visible in the Workspace panel.",
    "---",
    "panel skill body",
  ].join("\n"));

  const opened = await callOpen(context.client, context.project, "workspace-panel-first-connection");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const secondServer = createMcpServer(
    context.config,
    context.workspaces,
    createReviewCheckpointManager(),
    context.processSessions,
    [],
    [],
    context.codeIntelligence,
    context.activityLifecycle,
    context.bashOutputStore,
    context.activityQueries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const secondClient = new Client({ name: "workspace-panel-fallback-client", version: "1.0.0" });
  await Promise.all([
    secondClient.connect(clientTransport),
    secondServer.connect(serverTransport),
  ]);
  t.after(async () => {
    await secondClient.close();
    await secondServer.close();
  });

  const panel = await secondClient.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
  });
  assert.equal(panel.isError, undefined, allResponseText(panel));
  const workspace = (panel._meta as Record<string, unknown> | undefined)?.[
    "forgerelay/activityPanelWorkspace"
  ] as {
    agentsFiles?: Array<{ path?: string; content?: string }>;
    availableAgentsFiles?: Array<{ path?: string }>;
    skills?: Array<{ name?: string; description?: string }>;
  } | undefined;

  assert.ok((workspace?.agentsFiles?.length ?? 0) > 0);
  assert.ok(workspace?.agentsFiles?.some((file) => file.path === "AGENTS.md"));
  assert.ok(workspace?.agentsFiles?.every((file) => file.content === undefined));
  assert.ok(workspace?.skills?.some((skill) => skill.name === "panel-skill"));
  assert.ok(workspace?.skills?.every((skill) => skill.description === undefined));
});

test("transport session scopes Activity when openai/session metadata is absent", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "transport-scope.txt"), "transport scoped activity\n");
  const opened = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(opened).workspaceId);

  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
  });
  const turnId = String(structuredContent(panel).turnId);

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "transport-scope.txt", offset: 1, limit: 2 },
  });
  assert.equal(read.isError, undefined, allResponseText(read));

  const snapshot = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId },
  });
  assert.equal(snapshot.isError, undefined, allResponseText(snapshot));
  assert.ok(Number(structuredContent(snapshot).revision) > 0);
  assert.equal(structuredContent(snapshot).activities, undefined);
  const index = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  assert.deepEqual(
    (structuredContent(index).activities as Array<{ tool?: string; workspaceId?: string; target?: string }>).map(
      ({ tool, workspaceId: activityWorkspaceId, target }) => ({ tool, workspaceId: activityWorkspaceId, target }),
    ),
    [{ tool: "read", workspaceId, target: "transport-scope.txt" }],
  );
});

test("Activity snapshot bootstraps the current Host Turn from conversation metadata", async (t) => {
  const context = await fixture(t);
  const conversationScopeId = "activity-bootstrap-chat";
  const opened = await callOpen(context.client, context.project, conversationScopeId);
  const workspaceId = structuredContent(opened).workspaceId as string;

  const tools = await context.client.listTools();
  const snapshotTool = tools.tools.find((tool) => tool.name === "activity_snapshot");
  const snapshotInput = snapshotTool?.inputSchema as {
    required?: string[];
    properties?: Record<string, { description?: string }>;
  } | undefined;
  assert.equal(snapshotInput?.required?.includes("turnId") ?? false, false);
  assert.match(snapshotInput?.properties?.turnId?.description ?? "", /initial App bootstrap/i);

  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(panel).turnId);
  assert.match(turnId, /^turn_/);

  const bootstrap = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { workspaceId },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(bootstrap.isError, undefined);
  assert.equal(structuredContent(bootstrap).turnId, turnId);
  const bootstrapMeta = bootstrap._meta as Record<string, unknown> | undefined;
  assert.equal(bootstrapMeta?.["forgerelay/activityPanelDefaultExpanded"], false);
  assert.equal(
    (bootstrapMeta?.["forgerelay/activityPanelWorkspace"] as { workspaceId?: string } | undefined)?.workspaceId,
    workspaceId,
  );
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

test("open_workspace keeps lifecycle flags out of model output and makes repeated card metadata lightweight", async (t) => {
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
      "workspace.tasks",
      "batch.execute",
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

  const card = responseCard(repeated) as {
    workspaceReused?: boolean;
    includeBootstrapContext?: boolean;
    presentationRevision?: string;
    agentsFiles?: Array<{ path?: string; content?: string }>;
    availableAgentsFiles?: Array<{ path?: string }>;
    skills?: Array<{ name?: string; description?: string; path?: string }>;
    agentProviders?: Array<{ name?: string }>;
    agents?: Array<{ name?: string }>;
  };
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.equal(typeof card.presentationRevision, "string");
  assert.ok((card.agentsFiles?.length ?? 0) > 0);
  assert.ok(card.agentsFiles?.every((file) => typeof file.path === "string" && file.content === undefined));
  assert.ok(card.availableAgentsFiles?.every((file) => typeof file.path === "string"));
  assert.ok(card.skills?.every((skill) => skill.path === undefined));
  assert.ok(card.agentProviders?.every((provider) => provider.name !== undefined));
  assert.ok(card.agents?.every((agent) => agent.name !== undefined));
});

test("Workspace Panel loads advertised instruction bodies on demand without activating nested context", async (t) => {
  const context = await fixture(t);
  const nested = join(context.project, "panel-preview");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "AGENTS.md"), "panel-only nested instructions\n");
  await writeFile(join(nested, "target.txt"), "target\n");
  await writeFile(join(context.project, "not-an-instruction.txt"), "private workspace file\n");

  const opened = await callOpen(context.client, context.project, "chat-panel-instruction");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const available = structuredContent(opened).availableAgentsFiles as Array<{ path?: string }>;
  assert.equal(available.some((file) => file.path === "panel-preview/AGENTS.md"), true);

  const tools = await context.client.listTools();
  const instructionTool = tools.tools.find((tool) => tool.name === "workspace_instruction");
  assert.deepEqual(
    (instructionTool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility,
    ["app"],
  );

  const detail = await context.client.callTool({
    name: "workspace_instruction",
    arguments: { workspaceId, path: "panel-preview/AGENTS.md" },
  });
  assert.equal(detail.isError, undefined, allResponseText(detail));
  assert.deepEqual(structuredContent(detail), {
    path: "panel-preview/AGENTS.md",
    content: "panel-only nested instructions\n",
    status: "available",
  });

  const rejected = await context.client.callTool({
    name: "workspace_instruction",
    arguments: { workspaceId, path: "not-an-instruction.txt" },
  });
  assert.equal(rejected.isError, true);
  assert.match(allResponseText(rejected), /not advertised for this Workspace/);

  const ordinaryRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "panel-preview/target.txt" },
  });
  assert.equal(ordinaryRead.isError, undefined, allResponseText(ordinaryRead));
  assert.deepEqual(structuredContent(ordinaryRead).agentsFiles, [{
    path: "panel-preview/AGENTS.md",
    content: "panel-only nested instructions\n",
  }]);
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

test("open_workspace creates and resumes an empty Composite Workspace through the normal lifecycle", async (t) => {
  const context = await fixture(t);
  const created = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "research-project", context: "none" },
    _meta: { "openai/session": "chat-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const createdStructured = structuredContent(created);

  assert.match(String(createdStructured.workspaceId), /^cws_[a-f0-9]{10}$/);
  assert.equal(createdStructured.kind, "composite");
  assert.equal(createdStructured.name, "research-project");
  assert.deepEqual(createdStructured.members, []);
  assert.equal(createdStructured.root, undefined);
  assert.equal(createdStructured.mode, undefined);
  assert.match(allResponseText(created), /Composite Workspace/i);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: createdStructured.workspaceId, context: "none" },
    _meta: { "openai/session": "chat-composite-other" },
  } as Parameters<Client["callTool"]>[0]);
  const resumedStructured = structuredContent(resumed);
  assert.equal(resumedStructured.workspaceId, createdStructured.workspaceId);
  assert.equal(resumedStructured.kind, "composite");
  assert.equal(resumedStructured.name, "research-project");
  assert.deepEqual(resumedStructured.members, []);
});

test("Composite Workspace mounts an existing Workspace and requires explicit member routing", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "member.txt"), "member-data\n");
  const ordinary = await callOpen(context.client, context.project, "chat-member-source");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "multi-machine" },
    _meta: { "openai/session": "chat-member-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);

  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Source control and code analysis",
        workspaceId: ordinaryId,
      },
    },
    _meta: { "openai/session": "chat-member-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(mounted.isError, undefined, allResponseText(mounted));
  const mountedStructured = structuredContent(mounted);
  assert.equal(mountedStructured.kind, "composite");
  assert.deepEqual(mountedStructured.members, [{
    name: "code",
    purpose: "Source control and code analysis",
    workspaceId: ordinaryId,
  }]);

  const missingMember = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: "member.txt" },
  });
  assert.equal(missingMember.isError, true);
  assert.match(allResponseText(missingMember), /requires member/i);

  const routed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "member.txt" },
  });
  assert.equal(routed.isError, undefined);
  assert.match(allResponseText(routed), /member-data/);
  assert.equal((routed._meta as Record<string, unknown> | undefined)?.tool, "read");
  const routedCard = (routed._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(routedCard?.workspaceId, compositeId);
  assert.equal(routedCard?.member, "code");
});

test("Composite Workspace can open a path-backed member and explicitly load that member bootstrap", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "compute.txt"), "compute-data\n");
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "member-definition" },
    _meta: { "openai/session": "chat-member-definition" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);

  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "compute",
        purpose: "High-performance computation",
        path: context.project,
      },
    },
    _meta: { "openai/session": "chat-member-definition" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(mounted.isError, undefined, allResponseText(mounted));
  const mountedStructured = structuredContent(mounted);
  const members = mountedStructured.members as Array<Record<string, unknown>>;
  assert.equal(members.length, 1);
  assert.equal(members[0]?.name, "compute");
  assert.equal(members[0]?.purpose, "High-performance computation");
  assert.match(String(members[0]?.workspaceId), /^ws_[a-f0-9]{10}$/);
  const memberWorkspaceId = String(members[0]?.workspaceId);

  const updated = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "update",
      member: {
        name: "compute",
        newName: "gpu",
        purpose: "Accelerated computation",
      },
    },
  });
  assert.equal(updated.isError, undefined, allResponseText(updated));
  assert.deepEqual(structuredContent(updated).members, [{
    name: "gpu",
    purpose: "Accelerated computation",
    workspaceId: memberWorkspaceId,
  }]);

  const suppressed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "none" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const suppressedMemberContext = structuredContent(suppressed).memberContext as Record<string, unknown>;
  assert.equal(suppressedMemberContext.includeBootstrapContext, false);
  assert.equal(suppressedMemberContext.agentsFiles, undefined);
  assert.match(String(suppressedMemberContext.instruction), /suppressed.*context=none/i);
  assert.doesNotMatch(String(suppressedMemberContext.instruction), /already delivered/i);

  const automatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const automaticMemberContext = structuredContent(automatic).memberContext as Record<string, unknown>;
  assert.equal(automaticMemberContext.includeBootstrapContext, true);
  assert.ok(Array.isArray(automaticMemberContext.agentsFiles));

  const repeatedAutomatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const repeatedMemberContext = structuredContent(repeatedAutomatic).memberContext as Record<string, unknown>;
  assert.equal(repeatedMemberContext.includeBootstrapContext, false);
  assert.match(String(repeatedMemberContext.instruction), /already delivered/i);

  await writeFile(join(context.project, "AGENTS.md"), "updated Composite member instructions\n");
  const incremental = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const incrementalMemberContext = structuredContent(incremental).memberContext as Record<string, unknown>;
  assert.equal(incrementalMemberContext.includeBootstrapContext, true);
  assert.match(JSON.stringify(incrementalMemberContext.agentsFiles), /updated Composite member instructions/);
  assert.equal(incrementalMemberContext.availableAgentsFiles, undefined);
  assert.equal(incrementalMemberContext.skills, undefined);
  assert.equal(incrementalMemberContext.capabilityGuides, undefined);
  assert.equal(incrementalMemberContext.agentProviders, undefined);
  assert.equal(incrementalMemberContext.agents, undefined);
  assert.equal(incrementalMemberContext.skillDiagnostics, undefined);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).status, "closed");

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "full" },
    _meta: { "openai/session": "chat-member-bootstrap" },
  } as Parameters<Client["callTool"]>[0]);
  const reopenedStructured = structuredContent(reopened);
  const memberContext = reopenedStructured.memberContext as Record<string, unknown>;
  assert.equal(reopenedStructured.workspaceId, compositeId);
  assert.equal(memberContext.member, "gpu");
  assert.equal(memberContext.workspaceId, compositeId);
  assert.equal(memberContext.root, context.project);
  assert.equal(memberContext.includeBootstrapContext, true);
  assert.ok(Array.isArray(memberContext.agentsFiles));
  assert.match(JSON.stringify(memberContext.agentsFiles), /updated Composite member instructions/);
  assert.ok(Array.isArray(memberContext.capabilityGuides));
  assert.ok(Array.isArray(memberContext.agentProviders));
  assert.ok(Array.isArray(memberContext.agents));

  const ordinaryBootstrap = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: memberWorkspaceId, context: "full" },
    _meta: { "openai/session": "chat-member-bootstrap-ordinary" },
  } as Parameters<Client["callTool"]>[0]);
  const ordinaryBootstrapStructured = structuredContent(ordinaryBootstrap);
  assert.deepEqual(memberContext.capabilityGuides, ordinaryBootstrapStructured.capabilityGuides);
  assert.deepEqual(memberContext.agentProviders, ordinaryBootstrapStructured.agentProviders);
  assert.deepEqual(memberContext.agents, ordinaryBootstrapStructured.agents);

  const routed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "gpu", path: "compute.txt" },
  });
  assert.match(allResponseText(routed), /compute-data/);

  const ordinaryMember = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, member: "gpu", path: "compute.txt" },
  });
  assert.equal(ordinaryMember.isError, true);
  assert.match(allResponseText(ordinaryMember), /not composite/i);

  const removed = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "remove",
      member: { name: "gpu" },
    },
  });
  assert.equal(removed.isError, undefined, allResponseText(removed));
  assert.deepEqual(structuredContent(removed).members, []);

  const removedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "gpu", path: "compute.txt" },
  });
  assert.equal(removedRoute.isError, true);
  assert.match(allResponseText(removedRoute), /has no member gpu/i);

  const memberStillOpen = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "compute.txt" },
  });
  assert.equal(memberStillOpen.isError, undefined, allResponseText(memberStillOpen));
  assert.match(allResponseText(memberStillOpen), /compute-data/);
});

test("Composite Workspace explicitly routes filesystem, process, and capability surfaces to one member", async (t) => {
  const context = await fixture(t);
  const ordinary = await callOpen(context.client, context.project, "chat-composite-surfaces-member");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "surface-routing" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Source mutations and verification",
        workspaceId: ordinaryId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId: compositeId, member: "code", path: "routed.txt", content: "before\n" },
  });
  assert.equal(written.isError, undefined, allResponseText(written));
  assert.equal((written._meta as { card?: Record<string, unknown> } | undefined)?.card?.workspaceId, compositeId);

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      path: "routed.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
  });
  assert.equal(edited.isError, undefined, allResponseText(edited));

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId: compositeId, member: "code", path: "routed.txt", newPath: "renamed.txt" },
  });
  assert.equal(renamed.isError, undefined, allResponseText(renamed));

  const process = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId: compositeId, member: "code", command: "cat renamed.txt" },
  });
  assert.equal(process.isError, undefined, allResponseText(process));
  assert.match(allResponseText(process), /after/);
  assert.equal((process._meta as { card?: Record<string, unknown> } | undefined)?.card?.workspaceId, compositeId);
  assert.equal((process._meta as { card?: Record<string, unknown> } | undefined)?.card?.member, "code");

  const capability = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId: compositeId, member: "code", name: "hooks.check", action: "describe" },
  });
  assert.equal(capability.isError, undefined, allResponseText(capability));
  assert.match(allResponseText(capability), /hooks\.check/);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId: compositeId, member: "code", path: "renamed.txt" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
});

test("Composite Workspace aggregates member Activities into one Host Turn without changing audit ownership", async (t) => {
  const context = await fixture(t);
  const secondProject = join(dirname(context.project), "second-project");
  await mkdir(secondProject, { recursive: true });
  await writeFile(join(secondProject, "AGENTS.md"), "second project instructions\n");
  await writeFile(join(context.project, "code.txt"), "code-member\n");
  await writeFile(join(secondProject, "data.txt"), "data-member\n");

  const codeWorkspace = await callOpen(context.client, context.project, "chat-composite-activity-code");
  const dataWorkspace = await callOpen(context.client, secondProject, "chat-composite-activity-data");
  const codeWorkspaceId = String(structuredContent(codeWorkspace).workspaceId);
  const dataWorkspaceId = String(structuredContent(dataWorkspace).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "activity-aggregate" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  for (const member of [
    { name: "code", purpose: "Source work", workspaceId: codeWorkspaceId },
    { name: "data", purpose: "Dataset work", workspaceId: dataWorkspaceId },
  ]) {
    const mounted = await context.client.callTool({
      name: "open_workspace",
      arguments: { action: "member", workspaceId: compositeId, memberAction: "add", member },
    });
    assert.equal(mounted.isError, undefined, allResponseText(mounted));
  }

  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(panel.isError, undefined, allResponseText(panel));
  const turnId = String(structuredContent(panel).turnId);

  for (const [member, path] of [["code", "code.txt"], ["data", "data.txt"]] as const) {
    const read = await context.client.callTool({
      name: "read",
      arguments: { workspaceId: compositeId, member, path },
    });
    assert.equal(read.isError, undefined, allResponseText(read));
  }

  const snapshotResult = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId },
  });
  assert.equal(snapshotResult.isError, undefined, allResponseText(snapshotResult));
  assert.equal(structuredContent(snapshotResult).activities, undefined);
  const indexResult = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  assert.equal(indexResult.isError, undefined, allResponseText(indexResult));
  const activities = structuredContent(indexResult).activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 2);
  assert.deepEqual(activities.map((activity) => activity.member), ["code", "data"]);
  assert.deepEqual(activities.map((activity) => activity.workspaceId), [codeWorkspaceId, dataWorkspaceId]);

  const auditRecords = activities.map((activity) => context.auditStore.getActivity(String(activity.activityId)));
  assert.equal(auditRecords[0]?.turnId, turnId);
  assert.equal(auditRecords[0]?.workspace.id, codeWorkspaceId);
  assert.equal(auditRecords[1]?.turnId, turnId);
  assert.equal(auditRecords[1]?.workspace.id, dataWorkspaceId);
});

test("Composite close preserves identity and members while delete dissolves only Composite state", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "preserved.txt"), "preserved-member\n");
  const memberWorkspace = await callOpen(context.client, context.project, "chat-composite-close-member");
  const memberWorkspaceId = String(structuredContent(memberWorkspace).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "persistent-process" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Preserved source workspace",
        workspaceId: memberWorkspaceId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const running = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId: memberWorkspaceId,
      command: `${node} -e \"setTimeout(() => console.log('member-finished'), 1200)\"`,
      yieldTimeMs: 0,
    },
  });
  assert.equal(running.isError, undefined, allResponseText(running));
  const processId = Number(structuredContent(running).processId);
  assert.ok(processId > 0);
  assert.equal(structuredContent(running).running, true);

  const invalidCommitMessage = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, commitMessage: "must not be used" },
  });
  assert.equal(invalidCommitMessage.isError, true);
  assert.match(allResponseText(invalidCommitMessage), /not valid.*Composite/i);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  const closedStructured = structuredContent(closed);
  assert.equal(closedStructured.kind, "composite");
  assert.equal(closedStructured.action, "close");
  assert.equal(closedStructured.status, "closed");
  assert.equal(closedStructured.dissolved, false);
  assert.equal(closedStructured.workspaceId, compositeId);
  assert.deepEqual(closedStructured.members, [{
    name: "code",
    purpose: "Preserved source workspace",
    workspaceId: memberWorkspaceId,
  }]);
  assert.match(allResponseText(closed), /identity and member topology were preserved/i);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId, status: "closed" },
  });
  const listedComposite = (structuredContent(listed).compositeWorkspaces as Array<Record<string, unknown>>)[0];
  assert.equal(listedComposite?.workspaceId, compositeId);
  assert.equal(listedComposite?.status, "closed");
  assert.equal(listedComposite?.state, "closed");
  assert.deepEqual(listedComposite?.members, closedStructured.members);

  const closedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "preserved.txt" },
  });
  assert.equal(closedRoute.isError, true);
  assert.match(allResponseText(closedRoute), /Composite Workspace .* is closed/i);

  const closedMemberMutation = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "remove",
      member: { name: "code" },
    },
  });
  assert.equal(closedMemberMutation.isError, true);
  assert.match(allResponseText(closedMemberMutation), /is closed/i);

  const unopenedMemberProject = join(dirname(context.project), "closed-composite-unopened-member");
  await mkdir(unopenedMemberProject, { recursive: true });
  await writeFile(join(unopenedMemberProject, "AGENTS.md"), "unopened member instructions\n");
  const closedAdd = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "data",
        purpose: "Must not be opened while Composite is closed",
        path: unopenedMemberProject,
      },
    },
  });
  assert.equal(closedAdd.isError, true);
  assert.match(allResponseText(closedAdd), /is closed/i);
  const unopenedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "workspace", root: unopenedMemberProject },
  });
  assert.equal((structuredContent(unopenedInventory).workspaces as Array<Record<string, unknown>>).length, 0);

  const closedPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closedPanel.isError, true);
  assert.match(allResponseText(closedPanel), /No Workspace presentation|closed/i);

  const directMemberRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "preserved.txt" },
  });
  assert.equal(directMemberRead.isError, undefined, allResponseText(directMemberRead));
  assert.match(allResponseText(directMemberRead), /preserved-member/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, compositeId);
  assert.equal(structuredContent(reopened).status, "active");
  assert.deepEqual(structuredContent(reopened).members, closedStructured.members);

  const reopenedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "preserved.txt" },
  });
  assert.equal(reopenedRoute.isError, undefined, allResponseText(reopenedRoute));
  assert.match(allResponseText(reopenedRoute), /preserved-member/);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).action, "delete");
  assert.equal(structuredContent(deleted).dissolved, true);
  assert.match(allResponseText(deleted), /Composite relationship.*dissolved/i);

  const processResult = await waitForToolText(
    context.client,
    {
      name: "bash",
      arguments: { workspaceId: memberWorkspaceId, action: "process", processId, yieldTimeMs: 2_000 },
    },
    /member-finished/,
    4_000,
  );
  assert.equal(processResult.isError, undefined, allResponseText(processResult));
  assert.match(allResponseText(processResult), /member-finished/);

  const deletedOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(deletedOpen.isError, true);
  assert.match(allResponseText(deletedOpen), /Unknown workspaceId|Unknown Composite Workspace/i);
});

test("Composite close and delete never finalize a managed-worktree member", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(
    context.client,
    context.project,
    "chat-composite-close-worktree",
    "worktree",
  );
  const worktreeStructured = structuredContent(worktree);
  const worktreeWorkspaceId = String(worktreeStructured.workspaceId);
  const worktreeRoot = String(worktreeStructured.root);
  await writeFile(join(worktreeRoot, "unfinished.txt"), "still in worktree\n");

  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "dissolve-worktree" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "isolated",
        purpose: "Managed isolated work",
        workspaceId: worktreeWorkspaceId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).status, "closed");
  assert.equal((await stat(worktreeRoot)).isDirectory(), true);
  assert.equal(await readFile(join(worktreeRoot, "unfinished.txt"), "utf8"), "still in worktree\n");

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, compositeId);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).dissolved, true);
  assert.equal((await stat(worktreeRoot)).isDirectory(), true);
  assert.equal(await readFile(join(worktreeRoot, "unfinished.txt"), "utf8"), "still in worktree\n");

  const stillOpen = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: worktreeWorkspaceId, path: "unfinished.txt" },
  });
  assert.equal(stillOpen.isError, undefined, allResponseText(stillOpen));
  assert.match(allResponseText(stillOpen), /still in worktree/);
});

test("open_workspace list action exposes canonical Workspace inventory through the MCP surface", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-list-1");
  const second = await callOpen(context.client, context.project, "chat-list-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", root: context.project },
    _meta: { "openai/session": "chat-list-1" },
  } as Parameters<Client["callTool"]>[0]);
  const structured = structuredContent(listed);
  const inventory = structured.workspaces as Array<Record<string, unknown>>;

  assert.equal(structured.action, "list");
  assert.equal(inventory.length, 1);
  assert.deepEqual(new Set(inventory.map((entry) => entry.workspaceId)), new Set([firstId]));
  assert.equal(inventory.find((entry) => entry.workspaceId === firstId)?.current, true);
  assert.equal(inventory.every((entry) => entry.mode === "checkout"), true);
  assert.equal(inventory.every((entry) => entry.status === "active"), true);
  assert.equal(inventory.every((entry) => entry.state === "active"), true);
  assert.equal(inventory.every((entry) => entry.rootValid === true), true);
  assert.equal(inventory.every((entry) => String(entry.label).startsWith("project/ws_")), true);
  assert.equal((structured.summary as Record<string, unknown>).matching, 1);
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
      FORGERELAY_ARTIFACTS: "1",
      FORGERELAY_SUBAGENTS: "1",
      FORGERELAY_WIDGETS: "changes",
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
        "workspace.tasks",
        "batch.execute",
        "subagent.session",
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
    "workspace-tasks",
    "batch-execution",
  ]);

  for (const [name, firstPattern, secondPattern] of [
    ["subagents", /subagent\.session/, /first-class Subagent/],
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
    "workspace-tasks",
    "batch-execution",
  ]);
  assert.match(String(guides[0]?.description), /Hook/);
  assert.match(String(guides[0]?.whenToRead), /Hook/);
  assert.match(String(guides[0]?.path), /capabilities\/lifecycle-hooks\/GUIDE\.md$/);
  assert.match(String(guides[1]?.path), /capabilities\/managed-worktrees\/GUIDE\.md$/);
  assert.match(String(guides[2]?.path), /capabilities\/host-integration\/GUIDE\.md$/);
  assert.match(String(guides[3]?.path), /capabilities\/shell-processes\/GUIDE\.md$/);
  assert.match(String(guides[4]?.path), /capabilities\/code-intelligence\/GUIDE\.md$/);
  assert.match(String(guides[5]?.path), /capabilities\/workspace-tasks\/GUIDE\.md$/);
  assert.match(String(guides[6]?.path), /capabilities\/batch-execution\/GUIDE\.md$/);

  const guideExpectations = [
    [0, /BeforeTool/, /BeforeWorktreeClose/],
    [2, /oauth-protected-resource/, /Failed to fetch template/],
    [3, /action="process"/, /tty: true/],
    [4, /definition/, /Language server/],
    [5, /workspace\.tasks/, /current Workspace|当前 Workspace/],
    [6, /1–100 tasks|1-100 tasks/, /bash\.run/],
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

test("open_workspace hides skill filesystem paths and read loads skills through skills://", async (t) => {
  const context = await fixture(t);
  const skillDir = join(context.project, ".agents", "skills", "hidden-path-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: hidden-path-skill",
    "description: Loads without exposing its filesystem path.",
    "---",
    "skill entry body",
  ].join("\n"));
  await writeFile(join(skillDir, "reference.md"), "skill reference body\n");

  const duplicateSkillDir = join(context.config.agentDir, "skills", "hidden-path-skill");
  await mkdir(duplicateSkillDir, { recursive: true });
  await writeFile(join(duplicateSkillDir, "SKILL.md"), [
    "---",
    "name: hidden-path-skill",
    "description: Lower-priority duplicate.",
    "---",
    "duplicate body",
  ].join("\n"));

  const opened = await callOpen(context.client, context.project, "chat-skill-uri");
  const openedStructured = structuredContent(opened);
  const skills = openedStructured.skills as Array<Record<string, unknown>>;
  const skill = skills.find((candidate) => candidate.name === "hidden-path-skill");
  assert.deepEqual(skill, {
    name: "hidden-path-skill",
    description: "Loads without exposing its filesystem path.",
  });
  assert.equal("path" in skill!, false);
  assert.doesNotMatch(allResponseText(opened), /hidden-path-skill\/SKILL\.md/);

  const cardSkills = responseCard(opened).skills as Array<Record<string, unknown>>;
  const cardSkill = cardSkills.find((candidate) => candidate.name === "hidden-path-skill");
  assert.ok(cardSkill);
  assert.equal("path" in cardSkill, false);

  const diagnostics = openedStructured.skillDiagnostics as Array<Record<string, unknown>>;
  const collision = diagnostics.find((diagnostic) => diagnostic.type === "collision");
  assert.ok(collision);
  assert.equal("path" in collision, false);
  assert.doesNotMatch(JSON.stringify(collision), /winnerPath|loserPath|SKILL\.md|\.agents\/skills/);

  const workspaceId = String(openedStructured.workspaceId);
  const entry = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "skills://hidden-path-skill" },
  });
  assert.equal(entry.isError, undefined);
  assert.match(allResponseText(entry), /skill entry body/);

  const reference = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "skills://hidden-path-skill/reference.md" },
  });
  assert.equal(reference.isError, undefined);
  assert.match(allResponseText(reference), /skill reference body/);
});

test("different MCP conversations share one canonical checkout Workspace id and can explicitly resume it", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(resumed).workspaceId, firstId);

  const repeated = await callOpen(context.client, context.project, "chat-2");
  assert.equal(structuredContent(repeated).workspaceId, firstId);
});

test("open_workspace resolves a historical Workspace alias to the canonical Workspace id", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-canonical");
  const canonicalId = String(structuredContent(opened).workspaceId);
  const legacyAliasId = "ws_bbbbbbbbbb";
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      insert into workspace_session_aliases (alias_id, workspace_session_id)
      values (?, ?)
    `).run(legacyAliasId, canonicalId);
  } finally {
    database.close();
  }

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: legacyAliasId, context: "none" },
    _meta: { "openai/session": "chat-legacy-alias" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(resumed.isError, undefined, allResponseText(resumed));
  assert.equal(structuredContent(resumed).workspaceId, canonicalId);
  assert.doesNotMatch(allResponseText(resumed), new RegExp(legacyAliasId));
});

test("open_workspace reuses a stale checkout instead of reporting a duplicate logical Workspace", async (t) => {
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
  assert.equal(structuredContent(current).workspaceId, oldId);
  assert.deepEqual(stale, []);
  assert.doesNotMatch(allResponseText(current), /Idle logical workspaces.*>2 days/);
});

test("idle GC keeps an unbound checkout Workspace identity reachable through MCP", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(first).workspaceId);
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), workspaceId);
  } finally {
    database.close();
  }

  const reopened = await callOpen(context.client, context.project);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const inventory = structuredContent(listed).workspaces as Array<Record<string, unknown>>;
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0]?.workspaceId, workspaceId);
});

test("close_workspace preserves, reopens, and explicitly deletes a checkout Workspace", async (t) => {
  const context = await fixture(t);
  const sentinel = join(context.project, "workspace-delete-sentinel.txt");
  await writeFile(sentinel, "preserve checkout\n");
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);
  const legacyAliasId = "ws_cccccccccc";
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      insert into workspace_session_aliases (alias_id, workspace_session_id)
      values (?, ?)
    `).run(legacyAliasId, firstId);
  } finally {
    database.close();
  }

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: legacyAliasId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).workspaceId, firstId);
  assert.equal(structuredContent(closed).action, "close");
  assert.doesNotMatch(allResponseText(closed), new RegExp(legacyAliasId));
  assert.match(allResponseText(closed), /preserved/i);
  assert.match(allResponseText(closed), /Physical project files were not removed/);

  const listedClosed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId: legacyAliasId },
  });
  const closedInventory = structuredContent(listedClosed).workspaces as Array<Record<string, unknown>>;
  assert.equal(closedInventory.length, 1);
  assert.equal(closedInventory[0]?.workspaceId, firstId);
  assert.equal(closedInventory[0]?.state, "closed");
  assert.equal(closedInventory[0]?.status, "closed");

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: firstId, path: "AGENTS.md" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId, context: "none" },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, firstId);

  const reclosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: firstId, action: "close" },
  });
  assert.equal(reclosed.isError, undefined, allResponseText(reclosed));

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: legacyAliasId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).workspaceId, firstId);
  assert.equal(structuredContent(deleted).action, "delete");
  assert.doesNotMatch(allResponseText(deleted), new RegExp(legacyAliasId));
  assert.match(allResponseText(deleted), /deleted ForgeRelay Workspace/i);
  assert.equal((await stat(context.project)).isDirectory(), true);
  assert.equal(await readFile(sentinel, "utf8"), "preserve checkout\n");

  const listedDeleted = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId: firstId },
  });
  assert.equal(
    (structuredContent(listedDeleted).workspaces as Array<Record<string, unknown>>).length,
    0,
  );

  const replacement = await callOpen(context.client, context.project, "chat-1");
  assert.notEqual(structuredContent(replacement).workspaceId, firstId);
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

test("Activity Panel exposes the default-expanded preference only through app result metadata", async (t) => {
  const collapsed = await fixture(t);
  const collapsedOpened = await callOpen(collapsed.client, collapsed.project, "chat-activity-panel-collapsed");
  const collapsedWorkspaceId = String(structuredContent(collapsedOpened).workspaceId);
  const collapsedPanel = await collapsed.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: collapsedWorkspaceId },
  });
  assert.equal(
    (collapsedPanel._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelDefaultExpanded"],
    false,
  );

  const expanded = await fixture(t, {
    env: { FORGERELAY_ACTIVITY_PANEL_EXPANDED: "1" },
  });
  const expandedOpened = await callOpen(expanded.client, expanded.project, "chat-activity-panel-expanded");
  const expandedWorkspaceId = String(structuredContent(expandedOpened).workspaceId);
  const expandedPanel = await expanded.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: expandedWorkspaceId },
  });
  assert.equal(
    (expandedPanel._meta as Record<string, unknown> | undefined)?.["forgerelay/activityPanelDefaultExpanded"],
    true,
  );
  assert.equal(structuredContent(expandedPanel).turnId, "turn_host_test_1");
  assert.equal(structuredContent(expandedPanel).activityPanelDefaultExpanded, undefined);
});

test("Activity Panel establishes one durable Host Turn with state-only polling and lazy index, detail, and Bash output queries", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-activity-query-contract";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);
  assert.equal(turnId, "turn_host_test_1");
  assert.equal(structuredContent(panel).state, "working");
  assert.equal(structuredContent(panel).revision, 0);

  await writeFile(join(context.project, "query-secret.txt"), "READ-QUERY-SECRET\n");
  const read = await call("read", { workspaceId, path: "query-secret.txt" });
  assert.equal(read.isError, undefined);
  const written = await call("write", {
    workspaceId,
    path: "query-write.txt",
    content: "WRITE-QUERY-SECRET\n",
  });
  assert.equal(written.isError, undefined);
  const renamed = await call("rename", {
    workspaceId,
    path: "query-write.txt",
    newPath: "query-renamed.txt",
  });
  assert.equal(renamed.isError, undefined);
  const bash = await call("bash", {
    workspaceId,
    action: "run",
    command: "node -e \"console.log('BASH-QUERY-OUTPUT-SECRET')\"",
    yieldTimeMs: 10_000,
  });
  assert.equal(bash.isError, undefined);
  const outputId = String(structuredContent(bash).outputId);

  const snapshot = await call("activity_snapshot", { turnId });
  assert.equal(snapshot.isError, undefined);
  const snapshotStructured = structuredContent(snapshot);
  assert.equal(snapshotStructured.changed, true);
  assert.equal(snapshotStructured.state, "done");
  assert.equal(snapshotStructured.activities, undefined);
  assert.deepEqual(snapshot.content, []);

  const index = await call("activity_index", { turnId });
  assert.equal(index.isError, undefined);
  const indexStructured = structuredContent(index);
  assert.deepEqual(index.content, []);
  const activities = indexStructured.activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 4);
  assert.deepEqual(activities.map((activity) => activity.activityId), [
    "act_test_1",
    "act_test_2",
    "act_test_3",
    "act_test_4",
  ]);
  assert.ok(activities.every((activity) => context.auditStore.getActivity(String(activity.activityId))?.turnId === turnId));
  assert.equal(activities.find((activity) => activity.activityId === "act_test_3")?.target, "query-write.txt → query-renamed.txt");
  assert.equal(activities.find((activity) => activity.activityId === "act_test_3")?.detailAvailable, false);
  assert.equal(activities.find((activity) => activity.activityId === "act_test_4")?.outputId, outputId);
  const serializedSnapshot = JSON.stringify(indexStructured);
  assert.doesNotMatch(serializedSnapshot, /READ-QUERY-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /WRITE-QUERY-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /BASH-QUERY-OUTPUT-SECRET/);
  assert.doesNotMatch(serializedSnapshot, /console\.log/);

  const readDetail = await call("activity_detail", { turnId, activityId: "act_test_1" });
  assert.equal(readDetail.isError, undefined);
  assert.match(JSON.stringify(structuredContent(readDetail)), /READ-QUERY-SECRET/);

  const renameDetail = await call("activity_detail", { turnId, activityId: "act_test_3" });
  assert.equal(renameDetail.isError, true);
  assert.match(allResponseText(renameDetail), /summary-complete/i);

  const fullOutput = await call("activity_output", { turnId, outputId });
  assert.equal(fullOutput.isError, undefined);
  assert.match(String(structuredContent(fullOutput).command), /console\.log/);
  assert.match(String(structuredContent(fullOutput).output), /BASH-QUERY-OUTPUT-SECRET/);
  const outputCursor = Number(structuredContent(fullOutput).cursor);
  assert.ok(Number.isInteger(outputCursor) && outputCursor >= 0);

  context.bashOutputStore.append(outputId, "stdout", "BASH-QUERY-OUTPUT-DELTA\n");
  const deltaOutput = await call("activity_output", { turnId, outputId, cursor: outputCursor });
  assert.equal(deltaOutput.isError, undefined);
  assert.equal(structuredContent(deltaOutput).output, "BASH-QUERY-OUTPUT-DELTA\n");
  assert.ok(Number(structuredContent(deltaOutput).cursor) > outputCursor);

  const revision = Number(snapshotStructured.revision);
  const unchanged = await call("activity_snapshot", { turnId, knownRevision: revision });
  assert.equal(structuredContent(unchanged).changed, false);
  assert.equal(structuredContent(unchanged).activities, undefined);
  const unchangedIndex = await call("activity_index", { turnId, knownRevision: Number(indexStructured.revision) });
  assert.equal(structuredContent(unchangedIndex).changed, false);
  assert.deepEqual(structuredContent(unchangedIndex).activities, []);

  const secondPanel = await call("activity_panel", { workspaceId });
  const secondTurnId = String(structuredContent(secondPanel).turnId);
  assert.equal(secondTurnId, "turn_host_test_2");
  await call("read", { workspaceId, path: "AGENTS.md" });
  const secondSnapshot = await call("activity_snapshot", { turnId: secondTurnId });
  assert.equal(structuredContent(secondSnapshot).activities, undefined);
  assert.equal((structuredContent(await call("activity_index", { turnId: secondTurnId })).activities as unknown[]).length, 1);
  assert.equal(context.auditStore.getActivity("act_test_5")?.turnId, secondTurnId);
  assert.equal((structuredContent(await call("activity_index", { turnId })).activities as unknown[]).length, 4);
});

test("batch.execute runs heterogeneous core tasks with one parent Activity and ordered child results", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "read" },
        handlers: [{
          name: "Batch child read hook",
          command: "node -e \"require('node:fs').appendFileSync('batch-hook-count.txt', '1\\n')\"",
          report: true,
        }],
      }],
    },
  });
  const conversation = "chat-batch-core";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  await writeFile(join(context.project, "batch-read.txt"), "BATCH-READ-SENTINEL\n");
  await writeFile(join(context.project, "batch-edit.txt"), "before edit-target after\n");
  await writeFile(join(context.project, "batch-rename-before.txt"), "rename me\n");
  await writeFile(join(context.project, "batch-delete.txt"), "delete me\n");
  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 4,
      tasks: [
        { id: "read", operation: "read", path: "batch-read.txt" },
        { id: "write", operation: "write", path: "batch-written.txt", content: "BATCH-WRITE-SENTINEL\n" },
        {
          id: "edit",
          operation: "edit",
          path: "batch-edit.txt",
          edits: [{ oldText: "edit-target", newText: "edited" }],
        },
        { id: "rename", operation: "rename", path: "batch-rename-before.txt", newPath: "batch-rename-after.txt" },
        { id: "delete", operation: "delete", path: "batch-delete.txt" },
        { id: "missing", operation: "read", path: "batch-missing.txt" },
        { id: "bash", operation: "bash.run", command: "node -e \"console.log('BATCH-BASH-SENTINEL')\"" },
      ],
    },
  });
  assert.equal(batch.isError, undefined);
  const batchValue = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(batchValue.status, "partial");
  assert.equal(batchValue.tasks, 7);
  assert.equal(batchValue.completed, 6);
  assert.equal(batchValue.failed, 1);
  const results = batchValue.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((entry) => [entry.id, entry.operation, entry.status]), [
    ["read", "read", "done"],
    ["write", "write", "done"],
    ["edit", "edit", "done"],
    ["rename", "rename", "done"],
    ["delete", "delete", "done"],
    ["missing", "read", "error"],
    ["bash", "bash.run", "done"],
  ]);
  assert.match(JSON.stringify(results[0]), /BATCH-READ-SENTINEL/);
  assert.match(JSON.stringify(results[5]), /ENOENT|no such file/i);
  assert.match(JSON.stringify(results[6]), /BATCH-BASH-SENTINEL/);
  const bashChildResult = results[6]?.result as Record<string, unknown>;
  const bashStructured = bashChildResult.structuredContent as Record<string, unknown>;
  assert.equal(typeof bashStructured.outputId, "string");
  assert.equal(bashStructured.running, false);
  assert.equal(
    (await readFile(join(context.project, "batch-hook-count.txt"), "utf8")).trim().split("\n").length,
    2,
  );

  assert.equal(await readFile(join(context.project, "batch-written.txt"), "utf8"), "BATCH-WRITE-SENTINEL\n");
  assert.equal(await readFile(join(context.project, "batch-edit.txt"), "utf8"), "before edited after\n");
  assert.equal(await readFile(join(context.project, "batch-rename-after.txt"), "utf8"), "rename me\n");
  await assert.rejects(readFile(join(context.project, "batch-rename-before.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "batch-delete.txt"), "utf8"), /ENOENT/);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  const activities = snapshot.activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 8);
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.equal(parent?.title, "Batch");
  assert.equal(parent?.target, "7 tasks");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.detailAvailable, false);
  assert.deepEqual(parent?.children, { total: 7, working: 0, done: 6, error: 1 });
  const children = activities.filter((activity) => activity.parentActivityId === parent?.activityId);
  assert.equal(children.length, 7);
  assert.deepEqual(children.map((activity) => activity.tool).sort(), [
    "bash", "delete", "edit", "read", "read", "rename", "write",
  ]);
  const parentAudit = context.auditStore.getActivity(String(parent?.activityId));
  assert.doesNotMatch(
    JSON.stringify(parentAudit),
    /BATCH-READ-SENTINEL|BATCH-WRITE-SENTINEL|BATCH-BASH-SENTINEL|edit-target/,
  );
  assert.deepEqual(parentAudit?.result, { childCount: 7, completed: 6, failed: 1 });
});

test("batch.execute runs Capability children through declared batch policy and audits unsupported children", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-capability";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  await writeFile(join(context.project, "batch-capability-read.txt"), "BATCH-CAPABILITY-READ\n");
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 3,
      tasks: [
        { id: "hooks", operation: "capability.run", name: "hooks.check", arguments: {} },
        { id: "unsupported", operation: "capability.run", name: "batch.execute", arguments: { tasks: [] } },
        { id: "read", operation: "read", path: "batch-capability-read.txt" },
      ],
    },
  });
  assert.equal(batch.isError, undefined);
  const value = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(value.status, "partial");
  assert.equal(value.completed, 2);
  assert.equal(value.failed, 1);
  const results = value.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((entry) => [entry.id, entry.operation, entry.status]), [
    ["hooks", "capability.run", "done"],
    ["unsupported", "capability.run", "error"],
    ["read", "read", "done"],
  ]);
  assert.match(JSON.stringify(results[0]), /globalHooks|projectHooks/);
  assert.match(JSON.stringify(results[1]), /capability_batch_unsupported|not supported inside batch\.execute/);
  assert.match(JSON.stringify(results[2]), /BATCH-CAPABILITY-READ/);

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 2, error: 1 });
  const children = activities.filter((activity) => activity.parentActivityId === parent?.activityId);
  assert.deepEqual(children.map((activity) => [activity.tool, activity.status]).sort(), [
    ["capability", "done"],
    ["capability", "error"],
    ["read", "done"],
  ]);
});

test("Host cancellation stops queued batch tasks and creates no fake child Activities", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-cancel";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const turn = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(turn).turnId);
  const hookDir = join(context.project, ".forgerelay", "hooks");
  const hookScript = join(context.project, "batch-cancel-hook.mjs");
  await mkdir(hookDir, { recursive: true });
  await writeFile(hookScript, "setTimeout(() => {}, 250);\n");
  await writeFile(
    join(hookDir, "batch-cancel.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "batch-cancel-first" },
      command: `node "${hookScript}"`,
      timeoutSeconds: 30,
    }),
  );

  const controller = new AbortController();
  const pending = context.client.callTool(
    {
      name: "capability",
      arguments: {
        workspaceId,
        name: "batch.execute",
        action: "run",
        arguments: {
          concurrency: 1,
          tasks: [
            { id: "first", operation: "bash.run", command: "echo batch-cancel-first" },
            { id: "queued-a", operation: "write", path: "batch-cancel-a.txt", content: "should-not-run\n" },
            { id: "queued-b", operation: "write", path: "batch-cancel-b.txt", content: "should-not-run\n" },
          ],
        },
      },
      _meta: { "openai/session": conversation },
    } as Parameters<Client["callTool"]>[0],
    undefined,
    { signal: controller.signal, timeout: 5_000 },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /abort|cancel/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(readFile(join(context.project, "batch-cancel-a.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "batch-cancel-b.txt"), "utf8"), /ENOENT/);

  const snapshot = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  const activities = structuredContent(snapshot).activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 2);
  const parent = activities.find((activity) => activity.tool === "batch");
  const child = activities.find((activity) => activity.parentActivityId === parent?.activityId);
  assert.equal(parent?.status, "error");
  assert.equal(child?.tool, "bash");
  assert.equal(child?.status, "error");
});

test("batch.execute accepts 100 tasks and persists 100 child Activities", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-hundred";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const batch = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      concurrency: 10,
      tasks: Array.from({ length: 100 }, (_, index) => ({
        id: `hooks-${index}`,
        operation: "capability.run",
        name: "hooks.check",
        arguments: {},
      })),
    },
  });
  assert.equal(batch.isError, undefined);
  const value = structuredContent(batch).result as Record<string, unknown>;
  assert.equal(value.status, "done");
  assert.equal(value.tasks, 100);
  assert.equal(value.completed, 100);
  assert.equal(value.failed, 0);
  const results = value.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 100);
  assert.deepEqual(results.map((entry) => entry.id), Array.from({ length: 100 }, (_, index) => `hooks-${index}`));

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.tool === "batch");
  assert.equal(activities.length, 101);
  assert.deepEqual(parent?.children, { total: 100, working: 0, done: 100, error: 0 });
});

test("batch.execute rejects more than 100 tasks before creating a Batch Activity", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-batch-limit";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const rejected = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: Array.from({ length: 101 }, (_, index) => ({
        id: `task-${index}`,
        operation: "read",
        path: `file-${index}.txt`,
      })),
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(allResponseText(rejected), /invalid_arguments|100|too big/i);

  const nested = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: [{ id: "nested", operation: "batch.execute", tasks: [] }],
    },
  });
  assert.equal(nested.isError, true);
  assert.match(allResponseText(nested), /invalid_arguments|operation/i);

  const processControl = await call("capability", {
    workspaceId,
    name: "batch.execute",
    action: "run",
    arguments: {
      tasks: [{ id: "process", operation: "bash.run", command: "echo no", processId: 1 }],
    },
  });
  assert.equal(processControl.isError, true);
  assert.match(allResponseText(processControl), /invalid_arguments|unrecognized/i);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  assert.deepEqual(snapshot.activities, []);
});

test("bulk Read returns ordered per-file results and persists one parent Activity with child Reads", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "read" },
        handlers: [{
          name: "Bulk read preflight",
          command: "node -e \"process.exit(0)\"",
        }],
      }],
    },
  });
  const conversation = "chat-bulk-read";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  await writeFile(join(context.project, "bulk-a.txt"), "BULK-READ-A-SENTINEL\n");
  await writeFile(join(context.project, "bulk-b.txt"), "BULK-READ-B-SENTINEL\n");
  const panel = await call("activity_panel", { workspaceId });
  const turnId = String(structuredContent(panel).turnId);

  const read = await call("read", {
    workspaceId,
    paths: ["bulk-a.txt", "bulk-b.txt", "bulk-missing.txt"],
  });
  assert.equal(read.isError, undefined);
  const readStructured = structuredContent(read);
  const results = readStructured.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((result) => [result.path, result.status]), [
    ["bulk-a.txt", "done"],
    ["bulk-b.txt", "done"],
    ["bulk-missing.txt", "error"],
  ]);
  assert.match(String(results[0]?.result), /BULK-READ-A-SENTINEL/);
  assert.match(String(results[1]?.result), /BULK-READ-B-SENTINEL/);
  assert.match(String(results[2]?.result), /ENOENT|no such file/i);
  assert.equal(readStructured.files, 3);
  assert.equal(readStructured.failed, 1);
  assert.equal((allResponseText(read).match(/Bulk read preflight \(BeforeTool, global\) passed/g) ?? []).length, 3);

  const ambiguous = await call("read", {
    workspaceId,
    path: "bulk-a.txt",
    paths: ["bulk-b.txt"],
  });
  assert.equal(ambiguous.isError, true);
  assert.match(allResponseText(ambiguous), /exactly one of path or paths/i);
  const empty = await call("read", { workspaceId, paths: [] });
  assert.equal(empty.isError, true);

  const snapshot = structuredContent(await call("activity_index", { turnId }));
  const activities = snapshot.activities as Array<Record<string, unknown>>;
  assert.deepEqual(activities.map((activity) => activity.activityId), [
    "act_test_1",
    "act_test_2",
    "act_test_3",
    "act_test_4",
  ]);
  const parent = activities[0];
  assert.equal(parent?.target, "3 files");
  assert.equal(parent?.status, "error");
  assert.equal(parent?.detailAvailable, false);
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 2, error: 1 });
  assert.ok(activities.slice(1).every((activity) => activity.parentActivityId === "act_test_1"));
  assert.ok(activities.every((activity) => context.auditStore.getActivity(String(activity.activityId))?.turnId === turnId));
  assert.deepEqual(context.auditStore.getActivity("act_test_1")?.result, {
    childCount: 3,
    succeeded: 2,
    failed: 1,
  });
  assert.doesNotMatch(JSON.stringify(context.auditStore.getActivity("act_test_1")), /BULK-READ-A-SENTINEL|BULK-READ-B-SENTINEL/);
  assert.doesNotMatch(JSON.stringify(snapshot), /BULK-READ-A-SENTINEL|BULK-READ-B-SENTINEL/);

  const firstDetail = await call("activity_detail", { turnId, activityId: "act_test_2" });
  assert.match(JSON.stringify(structuredContent(firstDetail)), /BULK-READ-A-SENTINEL/);
  const parentDetail = await call("activity_detail", { turnId, activityId: "act_test_1" });
  assert.equal(parentDetail.isError, true);
  assert.match(allResponseText(parentDetail), /summary-complete/i);
});

test("bulk Edit preflights every target before mutation and records child edits only after preflight", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-bulk-edit";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const paths = ["edit-a.txt", "edit-b.txt", "edit-c.txt"];
  await writeFile(join(context.project, paths[0]!), "before common after\n");
  await writeFile(join(context.project, paths[1]!), "before common after\n");
  await writeFile(join(context.project, paths[2]!), "common and common\n");

  const failedTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const preflightFailure = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(preflightFailure.isError, true);
  assert.match(allResponseText(preflightFailure), /unique|multiple|match/i);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(context.project, paths[1]!), "utf8"), "before common after\n");
  assert.equal(await readFile(join(context.project, paths[2]!), "utf8"), "common and common\n");
  const failedActivities = structuredContent(await call("activity_index", { turnId: failedTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(failedActivities.length, 1);
  assert.equal(failedActivities[0]?.target, "3 files");
  assert.equal(failedActivities[0]?.status, "error");
  assert.equal(failedActivities[0]?.detailAvailable, false);
  assert.equal(failedActivities[0]?.children, undefined);

  const duplicateTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const duplicateFailure = await call("edit", {
    workspaceId,
    paths: [paths[0], paths[0]],
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(duplicateFailure.isError, true);
  assert.match(allResponseText(duplicateFailure), /overlap|same file/i);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "before common after\n");
  const duplicateActivities = structuredContent(await call("activity_index", { turnId: duplicateTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(duplicateActivities.length, 1);

  await writeFile(join(context.project, paths[2]!), "before common after\n");
  const successTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const edited = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(edited.isError, undefined);
  const editedResult = structuredContent(edited);
  assert.equal(editedResult.status, "applied");
  assert.equal(editedResult.files, 3);
  assert.equal(editedResult.completed, 3);
  assert.equal(editedResult.unexecuted, 0);
  assert.deepEqual((editedResult.results as Array<Record<string, unknown>>).map((entry) => [entry.path, entry.status]), [
    [paths[0], "done"], [paths[1], "done"], [paths[2], "done"],
  ]);
  for (const path of paths) {
    assert.equal(await readFile(join(context.project, path), "utf8"), "before changed after\n");
  }
  const successActivities = structuredContent(await call("activity_index", { turnId: successTurn })).activities as Array<Record<string, unknown>>;
  const parent = successActivities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.target, "3 files");
  assert.deepEqual(parent?.children, { total: 3, working: 0, done: 3, error: 0 });
  assert.equal(successActivities.filter((activity) => activity.parentActivityId === parent?.activityId).length, 3);
});

test("bulk Edit stops after a mutation-phase Hook failure and reports unexecuted targets", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        matcher: { tool: "edit", pathRegex: "partial-b\\.txt$" },
        handlers: [{ name: "Block second bulk edit", command: "node -e \"process.exit(13)\"" }],
      }],
    },
  });
  const conversation = "chat-bulk-edit-partial";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  const paths = ["partial-a.txt", "partial-b.txt", "partial-c.txt"];
  for (const path of paths) await writeFile(join(context.project, path), "common\n");
  const turnId = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);

  const edited = await call("edit", {
    workspaceId,
    paths,
    edits: [{ oldText: "common", newText: "changed" }],
  });
  assert.equal(edited.isError, true);
  const result = structuredContent(edited);
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.unexecuted, 1);
  assert.deepEqual((result.results as Array<Record<string, unknown>>).map((entry) => [entry.path, entry.status]), [
    [paths[0], "done"], [paths[1], "error"], [paths[2], "unexecuted"],
  ]);
  assert.equal(await readFile(join(context.project, paths[0]!), "utf8"), "changed\n");
  assert.equal(await readFile(join(context.project, paths[1]!), "utf8"), "common\n");
  assert.equal(await readFile(join(context.project, paths[2]!), "utf8"), "common\n");

  const activities = structuredContent(await call("activity_index", { turnId })).activities as Array<Record<string, unknown>>;
  const parent = activities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.status, "error");
  assert.deepEqual(parent?.children, { total: 2, working: 0, done: 1, error: 1 });
  assert.equal(activities.filter((activity) => activity.parentActivityId === parent?.activityId).length, 2);
});

test("bulk Delete preflights all targets and rejects dangerous overlaps before deleting anything", async (t) => {
  const context = await fixture(t);
  const conversation = "chat-bulk-delete";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  await writeFile(join(context.project, "delete-a.txt"), "a\n");
  await writeFile(join(context.project, "delete-b.txt"), "b\n");
  await mkdir(join(context.project, "delete-dir"));
  await writeFile(join(context.project, "delete-dir", "child.txt"), "child\n");

  const failedTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const nonEmptyFailure = await call("delete", {
    workspaceId,
    paths: ["delete-a.txt", "delete-dir"],
    recursive: false,
  });
  assert.equal(nonEmptyFailure.isError, true);
  assert.match(allResponseText(nonEmptyFailure), /not empty|non-empty/i);
  assert.equal(await readFile(join(context.project, "delete-a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(join(context.project, "delete-dir", "child.txt"), "utf8"), "child\n");
  const failedActivities = structuredContent(await call("activity_index", { turnId: failedTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(failedActivities.length, 1);
  assert.equal(failedActivities[0]?.target, "2 paths");
  assert.equal(failedActivities[0]?.detailAvailable, false);

  const overlapTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const overlapFailure = await call("delete", {
    workspaceId,
    paths: ["delete-dir", "delete-dir/child.txt"],
    recursive: true,
  });
  assert.equal(overlapFailure.isError, true);
  assert.match(allResponseText(overlapFailure), /overlap|ancestor|descendant/i);
  assert.equal(await readFile(join(context.project, "delete-dir", "child.txt"), "utf8"), "child\n");
  const overlapActivities = structuredContent(await call("activity_index", { turnId: overlapTurn })).activities as Array<Record<string, unknown>>;
  assert.equal(overlapActivities.length, 1);

  const successTurn = String(structuredContent(await call("activity_panel", { workspaceId })).turnId);
  const deleted = await call("delete", {
    workspaceId,
    paths: ["delete-a.txt", "delete-b.txt"],
  });
  assert.equal(deleted.isError, undefined);
  const deletedResult = structuredContent(deleted);
  assert.equal(deletedResult.status, "deleted");
  assert.equal(deletedResult.completed, 2);
  assert.equal(deletedResult.unexecuted, 0);
  await assert.rejects(readFile(join(context.project, "delete-a.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(context.project, "delete-b.txt"), "utf8"), /ENOENT/);
  const successActivities = structuredContent(await call("activity_index", { turnId: successTurn })).activities as Array<Record<string, unknown>>;
  const parent = successActivities.find((activity) => activity.parentActivityId === undefined);
  assert.equal(parent?.target, "2 paths");
  assert.deepEqual(parent?.children, { total: 2, working: 0, done: 2, error: 0 });
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
  const codex = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });

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
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
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

test("Composite Workspace routes Codex apply_patch and process tools through an explicit member", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
  const ordinary = await callOpen(context.client, context.project, "chat-codex-composite-member");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "codex-composite" },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Codex member",
        workspaceId: ordinaryId,
      },
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const panelOpened = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(panelOpened).turnId);

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      patch: "*** Begin Patch\n*** Add File: composite-codex.txt\n+patched\n*** End Patch",
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(patched.isError, undefined, allResponseText(patched));
  assert.equal(await readFile(join(context.project, "composite-codex.txt"), "utf8"), "patched\n");
  const patchedCard = (patched._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(patchedCard?.workspaceId, compositeId);
  assert.equal(patchedCard?.member, "code");

  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  const started = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      cmd: `${node} -e \"console.log('composite-codex-process'); setTimeout(() => {}, 150)\"`,
      yieldTimeMs: 0,
    },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(started.isError, undefined, allResponseText(started));
  const processId = structuredContent(started).processId;
  assert.equal(typeof processId, "number");
  const startedCard = (started._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(startedCard?.workspaceId, compositeId);
  assert.equal(startedCard?.member, "code");

  const completed = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId: compositeId, member: "code", processId, yieldTimeMs: 1_000 },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(completed.isError, undefined, allResponseText(completed));
  assert.match(allResponseText(completed), /composite-codex-process/);
  const completedCard = (completed._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(completedCard?.workspaceId, compositeId);
  assert.equal(completedCard?.member, "code");

  const panel = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
    _meta: { "openai/session": "chat-codex-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(panel.isError, undefined);
  const activities = structuredContent(panel).activities as Array<Record<string, unknown>>;
  assert.deepEqual(activities.map((activity) => [activity.tool, activity.member]), [
    ["apply_patch", "code"],
    ["exec_command", "code"],
  ]);
  for (const record of ["act_test_1", "act_test_2"]) {
    assert.equal(context.auditStore.getActivity(record)?.workspace.id, ordinaryId);
  }
});

test("codex exec_command is a top-level Activity while write_stdin remains process control", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_TOOL_MODE: "codex" } });
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
  const firstPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-poll" },
  } as Parameters<Client["callTool"]>[0]);
  const firstTurnId = String(structuredContent(firstPanel).turnId);

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

  const secondPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-poll" },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(structuredContent(secondPanel).turnId);

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
  assert.equal(context.auditStore.getActivity("act_test_1")?.turnId, firstTurnId);
  assert.equal(resultActivity?.turnId, secondTurnId);
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
  const firstPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  const firstTurnId = String(structuredContent(firstPanel).turnId);

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
  const completionDeadline = performance.now() + 5_000;
  while (context.processSessions.stats().completed === 0 && performance.now() < completionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(context.processSessions.stats().completed, 1);
  const secondPanel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-bash-result-attached" },
  } as Parameters<Client["callTool"]>[0]);
  const secondTurnId = String(structuredContent(secondPanel).turnId);

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
  assert.equal(context.auditStore.getActivity("act_test_1")?.turnId, firstTurnId);
  assert.equal(context.auditStore.getActivity("act_test_2")?.turnId, secondTurnId);
  assert.equal(context.auditStore.getActivity("act_test_3")?.turnId, secondTurnId);

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

  await waitForCompletedProcess(processSessions);
  await new Promise((resolve) => setTimeout(resolve, 100));
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
  await waitForCompletedProcess(processSessions);
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.match(allResponseText(closed), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(closed), /close-completed/);
  const closedMeta = closed._meta as {
    tool?: string;
    card?: { workspaceId?: string; mode?: string; payload?: unknown };
  } | undefined;
  assert.equal(closedMeta?.tool, "close_workspace");
  assert.equal(closedMeta?.card?.workspaceId, workspaceId);
  assert.equal(closedMeta?.card?.mode, "checkout");
  assert.ok(closedMeta?.card?.payload);
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

  const otherProject = join(dirname(context.project), "other-process-project");
  await mkdir(otherProject, { recursive: true });
  const secondWorkspace = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: otherProject },
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

test("workspace.tasks persists checkout Task state across close/reopen and removes it only on Workspace delete", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-task-checkout");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name?: string }>;
  assert.equal(catalog.some((entry) => entry.name === "workspace.tasks"), true);
  const taskStatePath = join(context.stateDir, "workspaces", workspaceId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Release" },
    },
  });
  assert.equal(createdList.isError, undefined, allResponseText(createdList));
  const createdSnapshot = structuredContent(createdList).result as Record<string, unknown>;
  const releaseList = (createdSnapshot.lists as Array<Record<string, unknown>>)[0]!;
  const listId = String(releaseList.id);

  const createdTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Publish 0.8.3",
        content: "Run the release gate before pushing the tag.",
        status: "in_progress",
      },
    },
  });
  assert.equal(createdTask.isError, undefined, allResponseText(createdTask));
  const taskOnlyReopen = await callOpen(context.client, context.project, "chat-task-checkout");
  assert.equal(
    structuredContent(taskOnlyReopen).contextFingerprint,
    structuredContent(opened).contextFingerprint,
  );
  assert.equal(structuredContent(taskOnlyReopen).agentsFiles, undefined);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal((await stat(taskStatePath)).isFile(), true);
  const closedRead = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "workspace.tasks", action: "run", arguments: { operation: "get" } },
  });
  assert.equal(closedRead.isError, true);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-task-checkout" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  const restored = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "workspace.tasks", action: "run", arguments: { operation: "get" } },
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  const restoredResult = structuredContent(restored).result as Record<string, unknown>;
  assert.equal(restoredResult.level, "summary");
  const restoredLists = restoredResult.lists as Array<Record<string, unknown>>;
  assert.equal(restoredLists[0]?.id, listId);
  assert.equal(restoredLists[0]?.taskCount, 1);
  assert.equal(restoredLists[0]?.unfinishedTaskCount, 1);
  assert.equal(restoredLists[0]?.tasks, undefined);
  assert.doesNotMatch(JSON.stringify(restoredResult), /Run the release gate/);

  const restoredHeaders = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId },
    },
  });
  assert.equal(restoredHeaders.isError, undefined, allResponseText(restoredHeaders));
  const restoredHeaderLists = (structuredContent(restoredHeaders).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  const restoredTasks = restoredHeaderLists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(restoredTasks[0]?.subject, "Publish 0.8.3");
  assert.equal(restoredTasks[0]?.status, "in_progress");
  assert.equal(restoredTasks[0]?.content, undefined);
  const firstTaskId = String(restoredTasks[0]?.id);

  const restoredDetail = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "detail", listId, taskId: firstTaskId },
    },
  });
  assert.equal(restoredDetail.isError, undefined, allResponseText(restoredDetail));
  assert.equal(
    ((structuredContent(restoredDetail).result as Record<string, unknown>).task as Record<string, unknown>).content,
    "Run the release gate before pushing the tag.",
  );

  const secondTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.create", listId, subject: "Verify package", position: 0 },
    },
  });
  const secondTasks = (((structuredContent(secondTask).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  const secondTaskId = String(secondTasks[0]?.id);
  const completedAndReordered = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.update",
        listId,
        taskId: firstTaskId,
        status: "completed",
        content: "Published and verified.",
        position: 0,
      },
    },
  });
  const updatedTasks = (((structuredContent(completedAndReordered).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  assert.equal(updatedTasks[0]?.id, firstTaskId);
  assert.equal(updatedTasks[0]?.status, "completed");

  const archived = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "archived", name: "Release 0.8.3" },
    },
  });
  assert.equal(
    (((structuredContent(archived).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.state),
    "archived",
  );
  const reactivated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "active" },
    },
  });
  assert.equal(
    (((structuredContent(reactivated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.state),
    "active",
  );
  const removedTask = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.delete", listId, taskId: secondTaskId },
    },
  });
  const remainingTasks = (((structuredContent(removedTask).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(remainingTasks.map((task) => task.id), [firstTaskId]);
  const scratch = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Scratch", position: 0 },
    },
  });
  const scratchListId = String(
    ((structuredContent(scratch).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const removedList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.delete", listId: scratchListId },
    },
  });
  assert.equal(
    ((structuredContent(removedList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>).length,
    1,
  );

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
});

test("open_workspace inspect reads bounded ordinary Workspace metadata without opening, binding, or leaking bootstrap context", async (t) => {
  const context = await fixture(t);
  const otherProject = join(dirname(context.project), "inspection-target");
  await mkdir(join(otherProject, ".forgerelay", "agents"), { recursive: true });
  await writeFile(join(otherProject, "AGENTS.md"), "INSPECTION_BOOTSTRAP_SECRET\n");
  await writeFile(join(otherProject, ".forgerelay", "agents", "reviewer.md"), [
    "---",
    "name: inspection-reviewer",
    "description: Inspection-only reviewer.",
    "provider: codex",
    "---",
    "SUBAGENT_BODY_SECRET",
  ].join("\n"));

  const targetOpen = await callOpen(context.client, otherProject, "inspection-target-chat");
  const targetWorkspaceId = String(structuredContent(targetOpen).workspaceId);
  assert.equal(JSON.stringify(targetOpen).includes("INSPECTION_BOOTSTRAP_SECRET"), true);
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: targetWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Inspection coordination" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: targetWorkspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Safe header",
        content: "TASK_BODY_SECRET",
        status: "in_progress",
      },
    },
  });

  const callerOpen = await callOpen(context.client, context.project, "inspection-caller-chat");
  const callerWorkspaceId = String(structuredContent(callerOpen).workspaceId);
  assert.notEqual(callerWorkspaceId, targetWorkspaceId);
  const beforeSession = context.store.getSession(targetWorkspaceId);
  assert.ok(beforeSession);
  const beforeBindings = structuredClone(context.store.listConversationBindings());
  const targetBinding = beforeBindings.find((binding) =>
    binding.conversationScopeId === "inspection-target-chat" && binding.workspaceSessionId === targetWorkspaceId
  );
  assert.ok(targetBinding);
  const beforeDelivery = context.store.getContextDelivery(
    targetBinding.conversationScopeId,
    targetBinding.targetKey,
  );
  assert.ok(beforeDelivery);

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: targetWorkspaceId },
    _meta: { "openai/session": "inspection-caller-chat" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const inspectedStructured = structuredContent(inspected);
  assert.equal(inspectedStructured.action, "inspect");
  assert.equal(inspectedStructured.workspaceId, targetWorkspaceId);
  const projection = inspectedStructured.inspection as Record<string, unknown>;
  assert.equal(projection.kind, "workspace");
  assert.equal(projection.location, "local");
  assert.equal(projection.root, otherProject);
  assert.equal(projection.mode, "checkout");
  assert.equal(projection.rootValid, true);
  const taskSummary = projection.taskSummary as Record<string, unknown>;
  const lists = taskSummary.lists as Array<Record<string, unknown>>;
  assert.equal(lists[0]?.name, "Inspection coordination");
  assert.equal(lists[0]?.taskCount, 1);
  assert.equal(lists[0]?.unfinishedTaskCount, 1);

  const serialized = JSON.stringify(inspected);
  for (const forbidden of [
    "INSPECTION_BOOTSTRAP_SECRET",
    "SUBAGENT_BODY_SECRET",
    "TASK_BODY_SECRET",
    "agentsFiles",
    "availableAgentsFiles",
    "capabilityGuides",
    "skillDiagnostics",
    "agentProviders",
    "contextFingerprint",
    "capabilityFingerprint",
    "fingerprint",
    "memberContext",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `inspect leaked forbidden value/key: ${forbidden}`);
  }
  assert.deepEqual(context.store.getSession(targetWorkspaceId), beforeSession);
  assert.deepEqual(context.store.listConversationBindings(), beforeBindings);
  assert.deepEqual(
    context.store.getContextDelivery(targetBinding.conversationScopeId, targetBinding.targetKey),
    beforeDelivery,
  );
});

test("open_workspace inspect observes a closed managed worktree without recreating its backing", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "inspection-worktree-chat", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const worktreePath = String(worktree.path);
  const targetBranch = String(worktree.targetBranch);

  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Managed inspection" },
    },
  });
  assert.equal(listCreated.isError, undefined, allResponseText(listCreated));
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close inspected worktree" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await assert.rejects(stat(worktreePath), /ENOENT/);
  const beforeSession = context.store.getSession(workspaceId);
  assert.equal(beforeSession?.status, "closed");

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const projection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(projection.workspaceId, workspaceId);
  assert.equal(projection.mode, "worktree");
  assert.equal(projection.managed, true);
  assert.equal(projection.state, "closed");
  assert.equal(projection.rootValid, false);
  assert.equal(projection.targetBranch, targetBranch);
  assert.ok(projection.taskSummary);
  await assert.rejects(stat(worktreePath), /ENOENT/);
  assert.deepEqual(context.store.getSession(workspaceId), beforeSession);
});

test("open_workspace inspect projects Composite members and Tasks without touching Composite lifecycle state", async (t) => {
  const context = await fixture(t);
  const memberOpen = await callOpen(context.client, context.project, "inspection-composite-member-chat");
  const memberWorkspaceId = String(structuredContent(memberOpen).workspaceId);
  const compositeOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "inspection-composite", context: "none" },
  });
  const compositeId = String(structuredContent(compositeOpen).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Primary code", workspaceId: memberWorkspaceId },
    },
  });
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite coordination" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Coordinate",
        content: "COMPOSITE_TASK_BODY_SECRET",
      },
    },
  });
  const beforeList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId },
  });
  const beforeComposite = (structuredContent(beforeList).compositeWorkspaces as Array<Record<string, unknown>>)[0]!;

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: compositeId },
  });
  assert.equal(inspected.isError, undefined, allResponseText(inspected));
  const projection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(projection.kind, "composite");
  assert.equal(projection.name, "inspection-composite");
  const members = projection.members as Array<Record<string, unknown>>;
  assert.deepEqual(members, [{
    name: "code",
    purpose: "Primary code",
    workspaceId: memberWorkspaceId,
    known: true,
    location: "local",
    state: "active",
    status: "active",
    mode: "checkout",
    rootValid: true,
  }]);
  assert.equal(JSON.stringify(inspected).includes("COMPOSITE_TASK_BODY_SECRET"), false);
  const afterList = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", kind: "composite", workspaceId: compositeId },
  });
  const afterComposite = (structuredContent(afterList).compositeWorkspaces as Array<Record<string, unknown>>)[0]!;
  assert.equal(afterComposite.lastUsedAt, beforeComposite.lastUsedAt);
  assert.deepEqual(afterComposite.members, beforeComposite.members);
});

test("workspace.tasks reminder counts semantic work, excludes lifecycle/process follow-ups, and resets on Task mutation", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_TASK_REMINDER_INTERVAL: "2" },
  });
  await writeFile(join(context.project, "reminder.txt"), "semantic work\n");
  const opened = await callOpen(context.client, context.project, "chat-task-reminder");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Current" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const taskCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Keep current",
        content: "secret reminder body",
      },
    },
  });
  const taskId = String(
    ((((structuredContent(taskCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.tasks ?? []) as Array<Record<string, unknown>>)[0]?.id,
  );

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.doesNotMatch(allResponseText(inventory), /unfinished active Tasks/i);
  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId },
    _meta: { "openai/session": "chat-task-reminder" },
  } as Parameters<Client["callTool"]>[0]);
  assert.doesNotMatch(allResponseText(panel), /unfinished active Tasks/i);
  const taskSummary = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.doesNotMatch(allResponseText(taskSummary), /unfinished active Tasks/i);

  const firstRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(firstRead), /unfinished active Tasks/i);
  const secondRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(secondRead), /unfinished active Tasks/i);
  assert.doesNotMatch(allResponseText(secondRead), /secret reminder body/);

  const oneMoreRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(oneMoreRead), /unfinished active Tasks/i);
  const reset = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.update", listId, taskId, subject: "Still current" },
    },
  });
  assert.doesNotMatch(allResponseText(reset), /unfinished active Tasks/i);
  const batchWork = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "batch.execute",
      action: "run",
      arguments: {
        tasks: [
          { id: "read-a", operation: "read", path: "reminder.txt", limit: 1 },
          { id: "read-b", operation: "read", path: "reminder.txt", limit: 1 },
        ],
      },
    },
  });
  assert.doesNotMatch(allResponseText(batchWork), /unfinished active Tasks/i);
  const afterBatch = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(afterBatch), /unfinished active Tasks/i);

  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.update", listId, taskId, subject: "Current after batch" },
    },
  });
  const afterResetFirst = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "reminder.txt", limit: 1 },
  });
  assert.doesNotMatch(allResponseText(afterResetFirst), /unfinished active Tasks/i);

  const background = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      action: "run",
      command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('task-reminder-process'), 100)"`,
      yieldTimeMs: 0,
    },
  });
  assert.match(allResponseText(background), /unfinished active Tasks/i);
  const processId = Number(structuredContent(background).processId);
  const processFollowUp = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "process", processId, yieldTimeMs: 5_000 },
  });
  assert.doesNotMatch(allResponseText(processFollowUp), /unfinished active Tasks/i);
  const outputId = String(structuredContent(processFollowUp).outputId);
  const outputFollowUp = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, action: "output", outputId },
  });
  assert.doesNotMatch(allResponseText(outputFollowUp), /unfinished active Tasks/i);

  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.update", listId, state: "archived" },
    },
  });
  for (let call = 0; call < 3; call += 1) {
    const read = await context.client.callTool({
      name: "read",
      arguments: { workspaceId, path: "reminder.txt", limit: 1 },
    });
    assert.doesNotMatch(allResponseText(read), /unfinished active Tasks/i);
  }
});

test("workspace.tasks reminder follows the Composite identity during explicit member work", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_TASK_REMINDER_INTERVAL: "1" },
  });
  await writeFile(join(context.project, "reminder.txt"), "composite semantic work\n");
  const memberOpen = await callOpen(context.client, context.project, "chat-composite-task-reminder-member");
  const memberWorkspaceId = String(structuredContent(memberOpen).workspaceId);
  const compositeOpen = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "task-reminder-composite", context: "none" },
  });
  const compositeId = String(structuredContent(compositeOpen).workspaceId);
  await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Semantic work", workspaceId: memberWorkspaceId },
    },
  });
  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite current" },
    },
  });
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Keep Composite Task current",
        content: "composite secret body",
      },
    },
  });

  const memberRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "reminder.txt", limit: 1 },
  });
  assert.match(allResponseText(memberRead), /unfinished active Tasks/i);
  assert.doesNotMatch(allResponseText(memberRead), /composite secret body/);
});

test("workspace.tasks belongs to Composite Workspace itself and survives Composite close/reopen", async (t) => {
  const context = await fixture(t);
  const opened = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "task-composite", context: "none" },
  });
  const compositeId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name?: string }>;
  assert.deepEqual(catalog.map((entry) => entry.name), ["workspace.tasks"]);
  const guides = structuredContent(opened).capabilityGuides as Array<Record<string, unknown>>;
  const taskGuide = guides.find((guide) => guide.name === "workspace-tasks");
  assert.ok(taskGuide);
  const guideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: taskGuide.path },
  });
  assert.equal(guideRead.isError, undefined, allResponseText(guideRead));
  assert.match(allResponseText(guideRead), /workspace\.tasks/);
  const taskStatePath = join(context.stateDir, "workspaces", compositeId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const created = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Composite work" },
    },
  });
  assert.equal(created.isError, undefined, allResponseText(created));
  const createdLists = (structuredContent(created).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(createdLists[0]?.name, "Composite work");

  const memberScoped = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "anything",
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.equal(memberScoped.isError, true);
  assert.match(allResponseText(memberScoped), /Composite Workspace itself|does not accept member/i);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const closedGuideRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: taskGuide.path },
  });
  assert.equal(closedGuideRead.isError, true);
  assert.match(allResponseText(closedGuideRead), /closed.*reopen|reopen.*closed/i);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, context: "none" },
  });
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  const restored = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get" },
    },
  });
  assert.equal(restored.isError, undefined, allResponseText(restored));
  const restoredLists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(restoredLists[0]?.name, "Composite work");

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
});

test("workspace.tasks survives MCP server restart through the same persistent Workspace identity", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-task-restart");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Restart work" },
    },
  });
  const listId = String(
    ((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Resume after restart",
        content: "The Task file is the durable truth.",
      },
    },
  });
  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredAuditStore = new ActivityAuditStore(context.stateDir);
  const restoredBashOutputStore = new BashOutputStore(context.stateDir);
  const restoredHostTurnStore = new HostTurnStore(context.stateDir);
  const restoredActivityQueries = new ActivityQueryService(
    restoredHostTurnStore,
    restoredAuditStore,
    restoredBashOutputStore,
  );
  const restoredActivityLifecycle = new ActivityLifecycle(restoredAuditStore, {
    turnIdForConversation: (conversationScopeId, targetWorkspaceId) =>
      restoredActivityQueries.currentTurnId(conversationScopeId, targetWorkspaceId),
  });
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
    restoredActivityQueries,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "task-restart-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    await restoredCodeIntelligence.shutdown();
    restoredProcessSessions.shutdown();
    restoredHostTurnStore.close();
    restoredBashOutputStore.close();
    restoredAuditStore.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(clientTransport),
      restoredServer.connect(serverTransport),
    ]);
    const reopened = await restoredClient.callTool({
      name: "open_workspace",
      arguments: { workspaceId, context: "none" },
      _meta: { "openai/session": "chat-task-restart-restored" },
    } as Parameters<Client["callTool"]>[0]);
    assert.equal(reopened.isError, undefined, allResponseText(reopened));
    assert.equal(structuredContent(reopened).workspaceId, workspaceId);
    const restored = await restoredClient.callTool({
      name: "capability",
      arguments: {
        workspaceId,
        name: "workspace.tasks",
        action: "run",
        arguments: { operation: "get", level: "headers", listId },
      },
    });
    assert.equal(restored.isError, undefined, allResponseText(restored));
    const lists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
    assert.equal(lists[0]?.name, "Restart work");
    const tasks = lists[0]?.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks[0]?.subject, "Resume after restart");
    assert.equal(tasks[0]?.content, undefined);
  } finally {
    await closeRestored();
  }
});

test("workspace.tasks survives managed-worktree backing replacement and never enters Git contents", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-task-worktree", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const firstWorktreePath = String(worktree.path);
  const taskStatePath = join(context.stateDir, "workspaces", workspaceId, "tasks.json");
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const createdList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Isolated release" },
    },
  });
  const listId = String(
    ((structuredContent(createdList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "task.create", listId, subject: "Keep across backing replacement" },
    },
  });
  const worktreeStatus = await execFileAsync("git", ["status", "--porcelain"], { cwd: firstWorktreePath });
  assert.equal(worktreeStatus.stdout.trim(), "");

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close task worktree" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await assert.rejects(stat(firstWorktreePath), /ENOENT/);
  assert.equal((await stat(taskStatePath)).isFile(), true);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-task-worktree" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  const reopenedWorktree = structuredContent(reopened).worktree as Record<string, unknown>;
  assert.notEqual(reopenedWorktree.path, firstWorktreePath);
  const restored = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId },
    },
  });
  const lists = (structuredContent(restored).result as Record<string, unknown>).lists as Array<Record<string, unknown>>;
  assert.equal(lists[0]?.id, listId);
  const tasks = lists[0]?.tasks as Array<Record<string, unknown>>;
  assert.equal(tasks[0]?.subject, "Keep across backing replacement");
  assert.equal(tasks[0]?.content, undefined);

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      action: "delete",
      commitMessage: "test: delete task worktree",
    },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  await assert.rejects(stat(taskStatePath), /ENOENT/);
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
  assert.equal(structured.action, "close");
  assert.match(responseText(closed), /fast-forward/);
  const originalWorktreePath = String(worktree.path);
  await assert.rejects(stat(originalWorktreePath), /ENOENT/);

  const closedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const closedEntry = (structuredContent(closedInventory).workspaces as Array<Record<string, unknown>>)[0];
  assert.equal(closedEntry?.workspaceId, workspaceId);
  assert.equal(closedEntry?.state, "closed");

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "feature.txt" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  const reopenedWorktree = structuredContent(reopened).worktree as Record<string, unknown>;
  assert.notEqual(reopenedWorktree.path, originalWorktreePath);
  assert.notEqual(reopenedWorktree.branch, worktree.branch);
  assert.equal(reopenedWorktree.targetBranch, worktree.targetBranch);
  assert.equal((await stat(String(reopenedWorktree.path))).isDirectory(), true);

  const reclosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close reopened managed worktree" },
  });
  assert.equal(reclosed.isError, undefined, allResponseText(reclosed));

  const deletedClosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(deletedClosed.isError, undefined, allResponseText(deletedClosed));
  assert.equal(structuredContent(deletedClosed).workspaceId, workspaceId);
  assert.equal(structuredContent(deletedClosed).action, "delete");
  assert.match(allResponseText(deletedClosed), /already-removed worktree backing was not recreated/);

  const deletedInventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.equal(
    (structuredContent(deletedInventory).workspaces as Array<Record<string, unknown>>).length,
    0,
  );

  const tools = await context.client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "close_worktree"), false);
});

test("close_workspace delete safely finalizes an active managed-worktree Workspace before deleting identity", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-delete-worktree", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "delete-feature.txt", content: "preserve through finalize\n" },
  });

  const unsafeDelete = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, action: "delete" },
  });
  assert.equal(unsafeDelete.isError, true);
  assert.match(allResponseText(unsafeDelete), /requires commitMessage/);
  assert.equal(
    await readFile(join(String(worktree.path), "delete-feature.txt"), "utf8"),
    "preserve through finalize\n",
  );

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      action: "delete",
      commitMessage: "test: safely finalize deleted worktree",
    },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).workspaceId, workspaceId);
  assert.equal(structuredContent(deleted).action, "delete");
  assert.equal(structuredContent(deleted).mode, "worktree");
  assert.match(allResponseText(deleted), /Safely finalized and deleted/);
  assert.equal(
    (await readFile(join(context.project, "delete-feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "preserve through finalize\n",
  );
  await assert.rejects(stat(String(worktree.path)), /ENOENT/);

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  assert.equal((structuredContent(inventory).workspaces as Array<Record<string, unknown>>).length, 0);
});

test("failed managed-worktree reopen leaves the Workspace closed through MCP", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-failed-reopen", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const targetBranch = String(worktree.targetBranch);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId, commitMessage: "test: close before failed reopen" },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  await git(context.project, ["switch", "-c", "replacement-target"]);
  await git(context.project, ["branch", "-D", targetBranch]);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-failed-reopen" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, true);
  assert.match(allResponseText(reopened), /baseRef|local branch|managed worktree/i);

  const inventory = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const entry = (structuredContent(inventory).workspaces as Array<Record<string, unknown>>)[0];
  assert.equal(entry?.workspaceId, workspaceId);
  assert.equal(entry?.state, "closed");
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

test("open_workspace auto returns only changed bootstrap components", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-incremental-bootstrap");
  const firstContent = structuredContent(first);
  assert.ok(Array.isArray(firstContent.agentsFiles));
  assert.ok(Array.isArray(firstContent.capabilityGuides));

  await writeFile(join(context.project, "AGENTS.md"), "updated project instructions only\n");

  const updated = await callOpen(context.client, context.project, "chat-incremental-bootstrap");
  const updatedContent = structuredContent(updated);
  const updatedAgentsFiles = updatedContent.agentsFiles as Array<{ path?: string; content?: string }>;
  assert.equal(
    updatedAgentsFiles.some((file) =>
      file.path === "AGENTS.md" && file.content === "updated project instructions only\n"
    ),
    true,
  );
  assert.equal(updatedContent.availableAgentsFiles, undefined);
  assert.equal(updatedContent.skills, undefined);
  assert.equal(updatedContent.skillDiagnostics, undefined);
  assert.equal(updatedContent.capabilityGuides, undefined);
  assert.equal(updatedContent.agentProviders, undefined);
  assert.equal(updatedContent.agents, undefined);
});

test("open_workspace context none does not acknowledge changed bootstrap components", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-incremental-none");
  const workspaceId = String(structuredContent(first).workspaceId);

  await writeFile(join(context.project, "AGENTS.md"), "changed while bootstrap is suppressed\n");
  const suppressed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "none" },
    _meta: { "openai/session": "chat-incremental-none" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(suppressed).agentsFiles, undefined);

  const automatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId, context: "auto" },
    _meta: { "openai/session": "chat-incremental-none" },
  } as Parameters<Client["callTool"]>[0]);
  const automaticContent = structuredContent(automatic);
  assert.match(JSON.stringify(automaticContent.agentsFiles), /changed while bootstrap is suppressed/);
  assert.equal(automaticContent.skills, undefined);
  assert.equal(automaticContent.capabilityGuides, undefined);
  assert.equal(automaticContent.agents, undefined);
});

test("open_workspace auto returns an empty changed component when bootstrap content is removed", async (t) => {
  const context = await fixture(t);
  const nestedDir = join(context.project, "nested-bootstrap");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, "AGENTS.md"), "nested bootstrap instructions\n");

  const first = await callOpen(context.client, context.project, "chat-incremental-delete");
  const firstAvailable = structuredContent(first).availableAgentsFiles as Array<{ path?: string }>;
  assert.equal(firstAvailable.some((file) => file.path === "nested-bootstrap/AGENTS.md"), true);

  await rm(join(nestedDir, "AGENTS.md"), { force: true });
  const updated = await callOpen(context.client, context.project, "chat-incremental-delete");
  const updatedContent = structuredContent(updated);
  assert.deepEqual(updatedContent.availableAgentsFiles, []);
  assert.equal(updatedContent.agentsFiles, undefined);
  assert.equal(updatedContent.skills, undefined);
  assert.equal(updatedContent.capabilityGuides, undefined);
  assert.equal(updatedContent.agents, undefined);
});

test("legacy whole-bootstrap delivery upgrades without resending unchanged context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-legacy-bootstrap-delivery");
  const workspaceId = String(structuredContent(first).workspaceId);
  const binding = context.store.listConversationBindings().find((candidate) =>
    candidate.conversationScopeId === "chat-legacy-bootstrap-delivery" &&
    candidate.workspaceSessionId === workspaceId
  );
  assert.ok(binding);

  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      update workspace_context_deliveries
         set component_fingerprints_json = null
       where conversation_scope_id = ? and target_key = ?
    `).run(binding.conversationScopeId, binding.targetKey);
  } finally {
    database.close();
  }

  const repeated = await callOpen(context.client, context.project, "chat-legacy-bootstrap-delivery");
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.equal(structuredContent(repeated).skills, undefined);
  assert.ok(
    context.store.getContextDelivery(binding.conversationScopeId, binding.targetKey)?.componentFingerprints,
  );
});

test("a host without conversation metadata reuses the directory workspace and still receives full context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).availableAgentsFiles));
  assert.ok(Array.isArray(structuredContent(second).skills));
  assert.ok(Array.isArray(structuredContent(second).skillDiagnostics));
  assert.ok(Array.isArray(structuredContent(second).capabilityGuides));
  assert.ok(Array.isArray(structuredContent(second).agents));
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout context and durable Activity queries survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;
  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: firstWorkspaceId },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  const turnId = String(structuredContent(panel).turnId);
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
  await writeFile(join(context.project, "restart-bulk-a.txt"), "RESTART-BULK-A\n");
  await writeFile(join(context.project, "restart-bulk-b.txt"), "RESTART-BULK-B\n");
  const bulkRead = await context.client.callTool({
    name: "read",
    arguments: {
      workspaceId: firstWorkspaceId,
      paths: ["restart-bulk-a.txt", "restart-bulk-b.txt"],
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(bulkRead.isError, undefined);
  const durableBatch = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: firstWorkspaceId,
      name: "batch.execute",
      action: "run",
      arguments: {
        tasks: [
          { id: "read", operation: "read", path: "restart-bulk-a.txt" },
          { id: "bash", operation: "bash.run", command: "node -e \"console.log('restart-batch-output')\"" },
          { id: "hooks", operation: "capability.run", name: "hooks.check", arguments: {} },
        ],
      },
    },
    _meta: { "openai/session": "chat-1" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(durableBatch.isError, undefined);
  const durableBatchValue = structuredContent(durableBatch).result as Record<string, unknown>;
  const durableBatchResults = durableBatchValue.results as Array<Record<string, unknown>>;
  const durableBatchBashResult = durableBatchResults.find((result) => result.id === "bash")?.result as Record<string, unknown>;
  const durableBatchBashStructured = durableBatchBashResult.structuredContent as Record<string, unknown>;
  const batchOutputId = String(durableBatchBashStructured.outputId);
  assert.match(batchOutputId, /^out_/);

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredAuditStore = new ActivityAuditStore(context.stateDir);
  const restoredBashOutputStore = new BashOutputStore(context.stateDir);
  const restoredHostTurnStore = new HostTurnStore(context.stateDir);
  const restoredActivityQueries = new ActivityQueryService(
    restoredHostTurnStore,
    restoredAuditStore,
    restoredBashOutputStore,
  );
  const restoredActivityLifecycle = new ActivityLifecycle(restoredAuditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      restoredActivityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
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
    restoredActivityQueries,
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "forgerelay-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    await restoredCodeIntelligence.shutdown();
    restoredProcessSessions.shutdown();
    restoredHostTurnStore.close();
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

    const restoredSnapshot = await restoredClient.callTool({
      name: "activity_snapshot",
      arguments: { turnId },
    });
    assert.equal(restoredSnapshot.isError, undefined);
    assert.equal(structuredContent(restoredSnapshot).activities, undefined);
    const restoredIndex = await restoredClient.callTool({
      name: "activity_index",
      arguments: { turnId },
    });
    assert.equal(restoredIndex.isError, undefined);
    const restoredActivities = structuredContent(restoredIndex).activities as Array<Record<string, unknown>>;
    assert.equal(restoredActivities.length, 8);
    const restoredBash = restoredActivities.find((activity) => activity.tool === "bash");
    assert.equal(restoredBash?.outputId, outputId);
    const restoredActivityId = String(restoredBash?.activityId);
    const restoredBulkParent = restoredActivities.find((activity) =>
      activity.tool === "read" && activity.parentActivityId === undefined && activity.children !== undefined
    );
    assert.equal(restoredBulkParent?.target, "2 files");
    assert.deepEqual(restoredBulkParent?.children, { total: 2, working: 0, done: 2, error: 0 });
    const restoredBulkChildren = restoredActivities.filter((activity) =>
      activity.parentActivityId === restoredBulkParent?.activityId
    );
    assert.equal(restoredBulkChildren.length, 2);
    const restoredBatchParent = restoredActivities.find((activity) => activity.tool === "batch");
    assert.equal(restoredBatchParent?.target, "3 tasks");
    assert.deepEqual(restoredBatchParent?.children, { total: 3, working: 0, done: 3, error: 0 });
    const restoredBatchChildren = restoredActivities.filter((activity) =>
      activity.parentActivityId === restoredBatchParent?.activityId
    );
    assert.equal(restoredBatchChildren.length, 3);
    const restoredBatchBash = restoredBatchChildren.find((activity) => activity.tool === "bash");
    assert.equal(restoredBatchBash?.outputId, batchOutputId);

    const restoredDetail = await restoredClient.callTool({
      name: "activity_detail",
      arguments: { turnId, activityId: restoredActivityId },
    });
    assert.equal(restoredDetail.isError, undefined);
    assert.match(JSON.stringify(structuredContent(restoredDetail)), /restart-durable-output/);
    const restoredBulkDetail = await restoredClient.callTool({
      name: "activity_detail",
      arguments: { turnId, activityId: String(restoredBulkChildren[0]?.activityId) },
    });
    assert.equal(restoredBulkDetail.isError, undefined);
    assert.match(JSON.stringify(structuredContent(restoredBulkDetail)), /RESTART-BULK-A/);

    const restoredOutput = await restoredClient.callTool({
      name: "activity_output",
      arguments: { turnId, outputId },
    });
    assert.equal(restoredOutput.isError, undefined);
    assert.match(String(structuredContent(restoredOutput).output), /restart-durable-output/);
    assert.equal(structuredContent(restoredOutput).outputId, outputId);
    const restoredBatchOutput = await restoredClient.callTool({
      name: "activity_output",
      arguments: { turnId, outputId: batchOutputId },
    });
    assert.equal(restoredBatchOutput.isError, undefined);
    assert.match(String(structuredContent(restoredBatchOutput).output), /restart-batch-output/);
    assert.equal(structuredContent(restoredBatchOutput).outputId, batchOutputId);
  } finally {
    await closeRestored();
  }
});

test("HTTP MCP transports share Composite Workspace runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-server-shared-runtime-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const ownerToken = "shared-runtime-owner-token-that-is-long-enough";
  await mkdir(project, { recursive: true });

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_WORKTREE_ROOT: join(root, "worktrees"),
    FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  try {
    const port = (httpServer.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}`;
    const remote = await authenticateRemote(endpoint, ownerToken);
    const created = await withRemoteMcpClient(remote, endpoint, (client) =>
      client.callTool({
        name: "open_workspace",
        arguments: { kind: "composite", name: "shared-runtime" },
      })
    );
    assert.equal(created.isError, undefined);
    const compositeId = String(structuredContent(created).workspaceId);
    assert.match(compositeId, /^cws_/);

    const inspected = await withRemoteMcpClient(remote, endpoint, (client) =>
      client.callTool({
        name: "open_workspace",
        arguments: { action: "inspect", workspaceId: compositeId },
      })
    );
    assert.equal(inspected.isError, undefined);
    const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
    assert.equal(inspection.workspaceId, compositeId);
    assert.equal(inspection.kind, "composite");
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface ServerFixture {
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

async function waitForCompletedProcess(processSessions: ProcessManager): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (processSessions.stats().completed === 0 && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processSessions.stats().completed, 1);
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
