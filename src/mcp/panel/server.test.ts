import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReviewCheckpointManager } from "../../workspaces/review/review-checkpoints.js";
import { createMcpServer } from "../../server.js";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../runtime/testing/server-fixture.js";

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

