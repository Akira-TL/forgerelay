import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDebugEnvironment,
  debugBaseUrl,
  debugMcpUrl,
  debugRoot,
  repoRoot,
} from "./runtime.mjs";
import {
  assertCodeIntelligenceShutdown as assertCodeIntelligenceAcceptanceShutdown,
  exerciseCodeIntelligence as exerciseCodeIntelligenceAcceptance,
  setupCodeIntelligenceProject as setupCodeIntelligenceAcceptanceProject,
} from "./code-intelligence-accept.mjs";

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const acceptanceRoot = resolve(debugRoot, "acceptance");
const stateDir = resolve(acceptanceRoot, "state");
const worktreeRoot = resolve(acceptanceRoot, "worktrees");
const hookLog = resolve(acceptanceRoot, "hooks.jsonl");
const checkoutWorkspace = resolve(acceptanceRoot, "workspace");
const lifecycleDeleteWorkspace = resolve(acceptanceRoot, "delete-workspace");
const codeIntelligenceLog = resolve(acceptanceRoot, "code-intelligence-lsp.jsonl");
const fakeLanguageServer = resolve(repoRoot, "src", "lsp", "test-fixtures", "fake-lsp-server.mjs");
const gitProject = resolve(acceptanceRoot, "git-project");
const releaseProject = resolve(acceptanceRoot, "release-project");
const releaseRemote = resolve(acceptanceRoot, "release-remote.git");
const ownerToken = randomBytes(32).toString("base64url");
const tempAcceptanceRoot = resolve(tmpdir(), `forgerelay-debug-acceptance-${randomUUID()}`);

assertCurlAvailable();
await assertDebugPortFree();
rmSync(acceptanceRoot, { recursive: true, force: true });
mkdirSync(acceptanceRoot, { recursive: true });
setupGitProject(checkoutWorkspace);
setupGitProject(lifecycleDeleteWorkspace);
writeFileSync(join(lifecycleDeleteWorkspace, "keep.txt"), "keep checkout files\n");
setupCodeIntelligenceAcceptanceProject({
  root: checkoutWorkspace,
  fakeLanguageServer,
  logPath: codeIntelligenceLog,
});

const { env } = createDebugEnvironment({
  ownerToken,
  stateDir,
  worktreeRoot,
  hookLog,
  widgets: "changes",
});
env.FORGERELAY_ARTIFACTS = "1";
const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor"], {
  cwd: repoRoot,
  env,
  encoding: "utf8",
});
assert.equal(doctor.status, 0, doctor.stderr);
assert.match(doctor.stdout, /Public base URL: http:\/\/127\.0\.0\.1:7677/);
assert.match(doctor.stdout, /Tool mode: full/);
assert.match(doctor.stdout, /Widgets: changes/);
assert.match(doctor.stdout, /Trust proxy: off/);
pass("doctor resolved MCP shape", "public URL + tool/widgets/proxy state");

const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
let acceptanceCompleted = false;

try {
  const health = await waitForHealth(server);
  assert.deepEqual(health, { ok: true, name: "forgerelay" });
  pass("health", JSON.stringify(health));

  const protectedResource = jsonRequest(`${debugBaseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedResource.status, 200);
  assert.equal(protectedResource.json.resource, debugMcpUrl);
  assert.equal(protectedResource.json.resource_name, "ForgeRelay");
  pass("OAuth protected-resource discovery", protectedResource.json.resource);

  const authorizationServer = jsonRequest(`${debugBaseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationServer.status, 200);
  assert.equal(authorizationServer.json.authorization_endpoint, `${debugBaseUrl}/authorize`);
  assert.equal(authorizationServer.json.token_endpoint, `${debugBaseUrl}/token`);
  assert.equal(authorizationServer.json.registration_endpoint, `${debugBaseUrl}/register`);
  pass("OAuth authorization-server discovery", authorizationServer.json.token_endpoint);

  const unauthorized = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(),
    body: JSON.stringify(initializeRequest(1)),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.parse(unauthorized.body).error, "invalid_token");
  pass("unauthorized MCP is rejected", "HTTP 401 invalid_token");

  const oauth = authorizeDebugClient(authorizationServer.json);
  pass("OAuth owner-password flow", "registered client and issued access token");

  const initialized = mcpRequest(oauth.accessToken, undefined, initializeRequest(1));
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.equal(initialized.message.result.serverInfo.name, "forgerelay");
  assert.equal(initialized.message.result.serverInfo.title, "ForgeRelay");
  assert.equal(initialized.message.result.serverInfo.version, packageJson.version);
  const serverInstructions = initialized.message.result.instructions ?? "";
  assert.match(serverInstructions, /Shell commands may modify ordinary project files/);
  assert.match(serverInstructions, /\/etc\/sudoers/);
  assert.match(serverInstructions, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.match(serverInstructions, /Project-work order: open_workspace if needed → activity_panel\(workspaceId\) once → work tools/);
  assert.ok(serverInstructions.length < 3_000, `server instructions should stay compact, got ${serverInstructions.length} characters`);
  assert.doesNotMatch(serverInstructions, /fast-forwards the original target branch/);
  assert.doesNotMatch(serverInstructions, /Do not create or modify files with bash/);
  pass(
    "MCP initialize",
    JSON.stringify(initialized.message.result.serverInfo),
  );

  const initializedNotification = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initializedNotification.status, 202);

  const tools = mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }).message.result.tools;
  const toolNames = tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, [
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
  ]);
  const bashTool = tools.find((tool) => tool.name === "bash");
  assert.match(bashTool?.description ?? "", /local user's authority/);
  assert.doesNotMatch(bashTool?.description ?? "", /may modify ordinary project files/);
  assert.doesNotMatch(bashTool?.description ?? "", /\/etc\/sudoers/);
  assert.doesNotMatch(bashTool?.description ?? "", /external device or hardware mutations/);
  assert.doesNotMatch(bashTool?.description ?? "", /Do not use bash to create, move, rename, or delete project files/);
  assert.equal(bashTool?.inputSchema?.properties?.timeout, undefined);
  assert.match(bashTool?.description ?? "", /action=process/);
  assert.equal(bashTool?.inputSchema?.properties?.yieldTimeMs?.maximum, 300000);
  assert.equal(bashTool?.inputSchema?.properties?.timeoutMs?.maximum, 86400000);
  assert.match(bashTool?.inputSchema?.properties?.processId?.description ?? "", /action=process/);
  assert.match(bashTool?.inputSchema?.properties?.interrupt?.description ?? "", /SIGINT/);
  const openWorkspaceTool = tools.find((tool) => tool.name === "open_workspace");
  assert.ok(openWorkspaceTool?.inputSchema?.properties?.workspaceId);
  assert.ok(openWorkspaceTool?.inputSchema?.properties?.newWorkspace);
  assert.ok(openWorkspaceTool?.outputSchema?.properties?.staleWorkspaces);
  assert.ok(openWorkspaceTool?.outputSchema?.properties?.capabilityFingerprint);
  assert.ok(openWorkspaceTool?.outputSchema?.properties?.capabilityCatalog);
  assert.ok(openWorkspaceTool?.outputSchema?.properties?.capabilityGuides);
  const capabilityTool = tools.find((tool) => tool.name === "capability");
  assert.deepEqual(capabilityTool?._meta?.["openai/fileParams"], ["file"]);
  const activityPanelTool = tools.find((tool) => tool.name === "activity_panel");
  const activityTemplateUri = activityPanelTool?._meta?.ui?.resourceUri;
  assert.match(
    activityTemplateUri ?? "",
    /^ui:\/\/forgerelay\/activity-panel-app-[0-9a-f]{12}\.html$/,
  );
  assert.deepEqual(activityPanelTool?._meta?.ui?.visibility, ["model", "app"]);
  pass("MCP tools/list", `${toolNames.length} tools: ${toolNames.join(", ")}`);

  const resources = mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id: 21,
    method: "resources/list",
    params: {},
  }).message.result.resources;
  const currentActivityResource = resources.find((resource) => resource.uri === activityTemplateUri);
  assert.ok(currentActivityResource);
  assert.equal(currentActivityResource._meta?.ui?.domain, debugBaseUrl);
  assert.equal(
    resources.some((resource) => /^ui:\/\/forgerelay\/workspace-lifecycle-app-/.test(resource.uri)),
    false,
  );
  assert.ok(resources.some((resource) => resource.uri === "ui://forgerelay/workspace-app.html"));

  const resourceTemplates = mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id: 22,
    method: "resources/templates/list",
    params: {},
  }).message.result.resourceTemplates;
  assert.ok(resourceTemplates.some(
    (resourceTemplate) => resourceTemplate.uriTemplate === "ui://forgerelay/workspace-lifecycle-app-{revision}.html",
  ));
  assert.ok(resourceTemplates.some(
    (resourceTemplate) => resourceTemplate.uriTemplate === "ui://forgerelay/activity-panel-app-{revision}.html",
  ));

  const readTemplate = (id, uri) => mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "resources/read",
    params: { uri },
  }).message.result.contents[0];

  const activityTemplate = readTemplate(24, activityTemplateUri);
  assert.equal(activityTemplate.uri, activityTemplateUri);
  assert.equal(activityTemplate.mimeType, "text/html;profile=mcp-app");
  assert.match(activityTemplate.text ?? "", /activity-panel-app-[^\"]+\.js/);
  assert.equal(activityTemplate._meta?.ui?.domain, debugBaseUrl);
  assert.ok(activityTemplate._meta?.ui?.csp?.resourceDomains?.includes(debugBaseUrl));
  const scriptUrl = activityTemplate.text?.match(/<script type="module" crossorigin src="([^"]+)"/)?.[1];
  assert.ok(scriptUrl);
  const scriptAsset = curlRequest({ method: "GET", url: scriptUrl });
  assert.equal(scriptAsset.status, 200, scriptAsset.body);

  const legacyTemplate = readTemplate(25, "ui://forgerelay/workspace-app.html");
  assert.equal(legacyTemplate.uri, "ui://forgerelay/workspace-app.html");
  assert.equal(legacyTemplate.mimeType, "text/html;profile=mcp-app");
  pass("MCP app templates", `${activityTemplateUri} + historical compatibility templates`);

  const workspaceConversationMeta = { "openai/session": "acceptance-workspace" };
  const opened = callTool(oauth.accessToken, sessionId, 3, "open_workspace", {
    path: checkoutWorkspace,
  }, workspaceConversationMeta);
  const workspaceId = opened.structuredContent.workspaceId;
  assert.match(workspaceId, /^ws_/);
  assert.equal(opened.structuredContent.action, "open");
  assert.equal(opened.structuredContent.root, checkoutWorkspace);
  assert.equal(opened.structuredContent.mode, "checkout");
  assert.equal(typeof opened.structuredContent.contextFingerprint, "string");
  assert.deepEqual(opened.structuredContent.capabilityFingerprint, {
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
      "batch.execute",
      ...(process.platform === "linux" ? ["artifact.native-download"] : []),
      "ui.mcp-app",
      "review.changes",
    ],
  });
  const capabilityCatalog = opened.structuredContent.capabilityCatalog;
  assert.deepEqual(capabilityCatalog.map((entry) => entry.name), [
    "hooks.check",
    "review.changes",
    "code.intelligence",
    "batch.execute",
    ...(process.platform === "linux" ? ["artifact.download"] : []),
  ]);
  assert.equal(capabilityCatalog[0].available, true);
  assert.equal(capabilityCatalog[0].guide.name, "lifecycle-hooks");

  const repeatedOpen = callTool(oauth.accessToken, sessionId, 84, "open_workspace", {
    path: checkoutWorkspace,
    newWorkspace: true,
  }, workspaceConversationMeta);
  assert.equal(repeatedOpen.structuredContent.workspaceId, workspaceId);
  assert.equal(repeatedOpen.structuredContent.action, "open");
  assert.equal(
    repeatedOpen.structuredContent.contextFingerprint,
    opened.structuredContent.contextFingerprint,
  );
  assert.equal(repeatedOpen.structuredContent.agentsFiles, undefined);
  assert.equal(repeatedOpen.structuredContent.capabilityGuides, undefined);

  const workspaceInventory = callTool(oauth.accessToken, sessionId, 85, "open_workspace", {
    action: "list",
    root: checkoutWorkspace,
  }, workspaceConversationMeta);
  assert.equal(workspaceInventory.structuredContent.action, "list");
  assert.equal(workspaceInventory.structuredContent.summary.matching, 1);
  const inventoryEntries = workspaceInventory.structuredContent.workspaces;
  assert.equal(inventoryEntries.length, 1);
  assert.equal(inventoryEntries[0].workspaceId, workspaceId);
  assert.equal(inventoryEntries[0].current, true);

  const closedWorkspace = callTool(oauth.accessToken, sessionId, 86, "close_workspace", {
    workspaceId,
  });
  assert.equal(closedWorkspace.isError, undefined);
  assert.equal(closedWorkspace.structuredContent.workspaceId, workspaceId);
  assert.equal(closedWorkspace.structuredContent.action, "close");

  const closedInventory = callTool(oauth.accessToken, sessionId, 87, "open_workspace", {
    action: "list",
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(closedInventory.structuredContent.workspaces.length, 1);
  assert.equal(closedInventory.structuredContent.workspaces[0].state, "closed");
  assert.equal(closedInventory.structuredContent.workspaces[0].current, false);

  const closedRead = callTool(oauth.accessToken, sessionId, 89, "read", {
    workspaceId,
    path: "AGENTS.md",
  });
  assert.equal(closedRead.isError, true);

  const resumedOriginal = callTool(oauth.accessToken, sessionId, 90, "open_workspace", {
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(resumedOriginal.structuredContent.workspaceId, workspaceId);
  assert.equal(resumedOriginal.structuredContent.agentsFiles, undefined);
  assert.equal(
    resumedOriginal.structuredContent.contextFingerprint,
    opened.structuredContent.contextFingerprint,
  );

  const deleteOpened = callTool(oauth.accessToken, sessionId, 91, "open_workspace", {
    path: lifecycleDeleteWorkspace,
    context: "none",
  }, { "openai/session": "acceptance-workspace-delete" });
  const deleteWorkspaceId = deleteOpened.structuredContent.workspaceId;
  const deleteClosed = callTool(oauth.accessToken, sessionId, 92, "close_workspace", {
    workspaceId: deleteWorkspaceId,
  });
  assert.equal(deleteClosed.structuredContent.action, "close");
  const deletedWorkspace = callTool(oauth.accessToken, sessionId, 93, "close_workspace", {
    workspaceId: deleteWorkspaceId,
    action: "delete",
  });
  assert.equal(deletedWorkspace.isError, undefined);
  assert.equal(deletedWorkspace.structuredContent.workspaceId, deleteWorkspaceId);
  assert.equal(deletedWorkspace.structuredContent.action, "delete");
  assert.equal(readFileSync(join(lifecycleDeleteWorkspace, "keep.txt"), "utf8"), "keep checkout files\n");
  const deletedInventory = callTool(oauth.accessToken, sessionId, 94, "open_workspace", {
    action: "list",
    workspaceId: deleteWorkspaceId,
  });
  assert.equal(deletedInventory.structuredContent.workspaces.length, 0);

  pass(
    "workspace lifecycle + inventory",
    `${workspaceId} canonical reuse -> close -> list -> reopen; explicit delete preserves checkout files`,
  );

  const directCapability = callTool(oauth.accessToken, sessionId, 79, "capability", {
    workspaceId,
    name: "hooks.check",
    action: "run",
    arguments: {},
  });
  assert.equal(directCapability.isError, undefined);
  assert.equal(directCapability.structuredContent.result.ok, true);
  const describedCapability = callTool(oauth.accessToken, sessionId, 80, "capability", {
    workspaceId,
    name: "hooks.check",
    action: "describe",
  });
  assert.equal(describedCapability.isError, undefined);
  assert.equal(describedCapability.structuredContent.capability.guide.name, "lifecycle-hooks");
  assert.equal(describedCapability.structuredContent.capability.inputSchema.type, "object");
  const describedCodeIntelligence = callTool(oauth.accessToken, sessionId, 88, "capability", {
    workspaceId,
    name: "code.intelligence",
    action: "describe",
  });
  assert.equal(describedCodeIntelligence.isError, undefined);
  assert.equal(describedCodeIntelligence.structuredContent.capability.guide.name, "code-intelligence");
  const codeIntelligenceSchema = describedCodeIntelligence.structuredContent.capability.inputSchema;
  assert.ok(Array.isArray(codeIntelligenceSchema.oneOf));
  assert.deepEqual(
    codeIntelligenceSchema.oneOf.map((variant) => variant.properties.operation.const),
    ["definition", "hover", "references", "documentSymbols", "workspaceSymbols", "diagnostics"],
  );
  for (const operation of ["references", "documentSymbols", "workspaceSymbols", "diagnostics"]) {
    const boundedSchema = codeIntelligenceSchema.oneOf.find(
      (variant) => variant.properties.operation.const === operation,
    );
    assert.equal(boundedSchema.properties.limit.minimum, 1);
    assert.equal(boundedSchema.properties.limit.maximum, 1000);
  }
  const workspaceSymbolsSchema = codeIntelligenceSchema.oneOf.find(
    (variant) => variant.properties.operation.const === "workspaceSymbols",
  );
  assert.ok(workspaceSymbolsSchema.required.includes("query"));
  exerciseCodeIntelligenceAcceptance({
    callTool,
    accessToken: oauth.accessToken,
    sessionId,
    workspaceId,
    pass,
  });
  if (process.platform === "linux") {
    const describedArtifact = callTool(oauth.accessToken, sessionId, 82, "capability", {
      workspaceId,
      name: "artifact.download",
      action: "describe",
    });
    assert.equal(describedArtifact.isError, undefined);
    assert.deepEqual(describedArtifact.structuredContent.capability.transport, {
      nativeFileArgument: "file",
      gatewayParameter: "file",
    });
  }
  const unknownCapability = callTool(oauth.accessToken, sessionId, 81, "capability", {
    workspaceId,
    name: "unknown.capability",
    action: "run",
    arguments: {},
  });
  assert.equal(unknownCapability.isError, true);
  assert.equal(unknownCapability.structuredContent.error.code, "unknown_capability");
  const capabilityGuides = opened.structuredContent.capabilityGuides;
  assert.deepEqual(capabilityGuides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "artifacts-review",
    "host-integration",
    "shell-processes",
    "code-intelligence",
    "batch-execution",
  ]);
  const hooksGuide = callTool(oauth.accessToken, sessionId, 78, "read", {
    workspaceId,
    path: capabilityGuides[0].path,
  });
  assert.match(hooksGuide.structuredContent.result, /BeforeTool/);
  assert.match(hooksGuide.structuredContent.result, /BeforeWorktreeClose/);
  pass("open_workspace", `${workspaceId} -> ${capabilityCatalog.length} capabilities + ${capabilityGuides.length} capability guides`);

  const unifiedPanel = callTool(oauth.accessToken, sessionId, 89, "activity_panel", {
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(unifiedPanel.isError, undefined);
  assert.equal(
    unifiedPanel._meta?.["forgerelay/activityPanelWorkspace"]?.workspaceId,
    workspaceId,
  );
  assert.equal(
    unifiedPanel._meta?.["forgerelay/activityPanelWorkspace"]?.root,
    checkoutWorkspace,
  );
  pass("unified ForgeRelay Panel", `${workspaceId} -> Workspace + Activity`);

  const inspectorActivityPath = join(checkoutWorkspace, "inspector-activity.txt");
  writeFileSync(inspectorActivityPath, "inspector transport-scoped activity\n");
  try {
    const inspectorPanel = callTool(oauth.accessToken, sessionId, 90, "activity_panel", {
      workspaceId,
    });
    const inspectorTurnId = inspectorPanel.structuredContent.turnId;
    const inspectorRead = callTool(oauth.accessToken, sessionId, 91, "read", {
      workspaceId,
      path: "inspector-activity.txt",
      offset: 1,
      limit: 2,
    });
    assert.equal(inspectorRead.isError, undefined);
    const inspectorSnapshot = callTool(oauth.accessToken, sessionId, 92, "activity_snapshot", {
      turnId: inspectorTurnId,
    });
    assert.equal(inspectorSnapshot.isError, undefined);
    assert.ok(inspectorSnapshot.structuredContent.revision > 0);
    assert.deepEqual(
      inspectorSnapshot.structuredContent.activities.map(({ tool, workspaceId: activityWorkspaceId, target }) => ({
        tool,
        workspaceId: activityWorkspaceId,
        target,
      })),
      [{ tool: "read", workspaceId, target: "inspector-activity.txt" }],
    );
    pass("Inspector-style Activity scope", `${sessionId} -> ${inspectorTurnId} -> read captured`);
  } finally {
    rmSync(inspectorActivityPath, { force: true });
  }

  const written = callTool(oauth.accessToken, sessionId, 4, "write", {
    workspaceId,
    path: "acceptance.txt",
    content: "forgerelay 7677 acceptance\n",
  });
  assert.equal(written.isError, undefined);

  const read = callTool(oauth.accessToken, sessionId, 5, "read", {
    workspaceId,
    path: "acceptance.txt",
  });
  assert.match(read.structuredContent.result, /forgerelay 7677 acceptance/);
  pass("write + read", JSON.stringify(read.structuredContent));

  const reviewed = callTool(oauth.accessToken, sessionId, 83, "capability", {
    workspaceId,
    name: "review.changes",
    action: "run",
    arguments: {},
  });
  assert.equal(reviewed.isError, undefined);
  assert.match(reviewed.structuredContent.result.result, /Changed 1 file/);
  assert.equal(reviewed._meta?.tool, "capability");
  assert.equal(reviewed._meta?.card?.capabilityName, "review.changes");
  assert.match(reviewed._meta?.card?.payload?.patch ?? "", /acceptance\.txt/);
  pass("review.changes", "Capability Gateway produced the aggregate review card");

  const shell = callTool(oauth.accessToken, sessionId, 6, "bash", {
    workspaceId,
    command: "printf debug-bash-ok",
  });
  assert.match(shell.structuredContent.result, /debug-bash-ok/);
  assert.equal(shell.structuredContent.running, false);
  pass("bash", "foreground command completed through ProcessManager");

  const background = callTool(oauth.accessToken, sessionId, 61, "bash", {
    workspaceId,
    action: "run",
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('debug-process-ok'), 100)"`,
    yieldTimeMs: 0,
  });
  assert.equal(background.structuredContent.running, true);
  assert.equal(typeof background.structuredContent.processId, "number");
  const polled = callTool(oauth.accessToken, sessionId, 62, "bash", {
    workspaceId,
    action: "process",
    processId: background.structuredContent.processId,
    yieldTimeMs: 5_000,
  });
  assert.equal(polled.structuredContent.running, false);
  assert.equal(polled.structuredContent.exitCode, 0);
  assert.match(polled.structuredContent.result, /debug-process-ok/);
  pass("bash process", "action=run -> processId -> action=process completed through one MCP tool");

  const failedEdit = callTool(oauth.accessToken, sessionId, 7, "edit", {
    workspaceId,
    path: "acceptance.txt",
    edits: [{ oldText: "text that is not present", newText: "unused" }],
  });
  assert.equal(failedEdit.isError, true);
  pass("failed tool path", "edit returned isError=true and triggered AfterToolFailure");

  const renamedWorkspaceFile = callTool(oauth.accessToken, sessionId, 74, "rename", {
    workspaceId,
    path: "acceptance.txt",
    newPath: "renamed-acceptance.txt",
  });
  assert.equal(renamedWorkspaceFile.isError, undefined);
  assert.equal(readFileSync(join(checkoutWorkspace, "renamed-acceptance.txt"), "utf8"), "forgerelay 7677 acceptance\n");
  const deletedWorkspaceFile = callTool(oauth.accessToken, sessionId, 75, "delete", {
    workspaceId,
    path: "renamed-acceptance.txt",
  });
  assert.equal(deletedWorkspaceFile.isError, undefined);
  assert.equal(existsSync(join(checkoutWorkspace, "renamed-acceptance.txt")), false);
  pass("rename + delete", "workspace file renamed and deleted through MCP");

  mkdirSync(tempAcceptanceRoot, { recursive: true });
  const tempFile = join(tempAcceptanceRoot, "mcp-temp.txt");
  const tempWritten = callTool(oauth.accessToken, sessionId, 70, "write", {
    workspaceId,
    path: tempFile,
    content: "forgerelay temp before edit\n",
  });
  assert.equal(tempWritten.isError, undefined);

  const tempRead = callTool(oauth.accessToken, sessionId, 71, "read", {
    workspaceId,
    path: tempFile,
  });
  assert.match(tempRead.structuredContent.result, /forgerelay temp before edit/);

  const tempEdited = callTool(oauth.accessToken, sessionId, 72, "edit", {
    workspaceId,
    path: tempFile,
    edits: [{ oldText: "before edit", newText: "after edit" }],
  });
  assert.equal(tempEdited.isError, undefined);
  assert.equal(readFileSync(tempFile, "utf8"), "forgerelay temp after edit\n");

  const renamedTempFile = join(tempAcceptanceRoot, "mcp-temp-renamed.txt");
  const tempRenamed = callTool(oauth.accessToken, sessionId, 76, "rename", {
    workspaceId,
    path: tempFile,
    newPath: renamedTempFile,
  });
  assert.equal(tempRenamed.isError, undefined);
  assert.equal(readFileSync(renamedTempFile, "utf8"), "forgerelay temp after edit\n");
  const tempDeleted = callTool(oauth.accessToken, sessionId, 77, "delete", {
    workspaceId,
    path: renamedTempFile,
  });
  assert.equal(tempDeleted.isError, undefined);
  assert.equal(existsSync(renamedTempFile), false);

  const outsideRoots = callTool(oauth.accessToken, sessionId, 73, "read", {
    workspaceId,
    path: join(homedir(), "forgerelay-debug-outside-roots.txt"),
  });
  assert.equal(outsideRoots.isError, true);
  assert.match(toolText(outsideRoots), /outside allowed roots/i);
  pass("OS temp file tools", "write + read + edit + rename + delete passed; arbitrary home path rejected");

  setupGitProject(gitProject);
  const worktreeOpened = callTool(oauth.accessToken, sessionId, 8, "open_workspace", {
    path: gitProject,
    mode: "worktree",
  });
  const worktreeWorkspaceId = worktreeOpened.structuredContent.workspaceId;
  const managedWorktreePath = worktreeOpened.structuredContent.worktree.path;
  assert.equal(worktreeOpened.structuredContent.mode, "worktree");
  assert.ok(existsSync(managedWorktreePath));

  callTool(oauth.accessToken, sessionId, 9, "write", {
    workspaceId: worktreeWorkspaceId,
    path: "feature.txt",
    content: "debug worktree acceptance\n",
  });
  const closed = callTool(oauth.accessToken, sessionId, 10, "close_workspace", {
    workspaceId: worktreeWorkspaceId,
    commitMessage: "test(debug): verify 7677 worktree lifecycle",
  });
  assert.equal(closed.structuredContent.committed, true);
  assert.equal(existsSync(managedWorktreePath), false);
  assert.equal(
    readFileSync(join(gitProject, "feature.txt"), "utf8").replace(/\r\n/g, "\n"),
    "debug worktree acceptance\n",
  );
  const closedWorktreeInventory = callTool(oauth.accessToken, sessionId, 110, "open_workspace", {
    action: "list",
    workspaceId: worktreeWorkspaceId,
  });
  assert.equal(closedWorktreeInventory.structuredContent.workspaces.length, 1);
  assert.equal(closedWorktreeInventory.structuredContent.workspaces[0].state, "closed");

  const reopenedWorktree = callTool(oauth.accessToken, sessionId, 111, "open_workspace", {
    workspaceId: worktreeWorkspaceId,
    context: "none",
  });
  assert.equal(reopenedWorktree.structuredContent.workspaceId, worktreeWorkspaceId);
  const reopenedWorktreePath = reopenedWorktree.structuredContent.worktree.path;
  assert.notEqual(reopenedWorktreePath, managedWorktreePath);
  assert.ok(existsSync(reopenedWorktreePath));

  callTool(oauth.accessToken, sessionId, 112, "write", {
    workspaceId: worktreeWorkspaceId,
    path: "delete-feature.txt",
    content: "debug worktree delete acceptance\n",
  });
  const deletedWorktree = callTool(oauth.accessToken, sessionId, 113, "close_workspace", {
    workspaceId: worktreeWorkspaceId,
    action: "delete",
    commitMessage: "test(debug): verify 7677 worktree delete lifecycle",
  });
  assert.equal(deletedWorktree.structuredContent.action, "delete");
  assert.equal(existsSync(reopenedWorktreePath), false);
  assert.equal(
    readFileSync(join(gitProject, "delete-feature.txt"), "utf8").replace(/\r\n/g, "\n"),
    "debug worktree delete acceptance\n",
  );
  const deletedWorktreeInventory = callTool(oauth.accessToken, sessionId, 114, "open_workspace", {
    action: "list",
    workspaceId: worktreeWorkspaceId,
  });
  assert.equal(deletedWorktreeInventory.structuredContent.workspaces.length, 0);
  pass(
    "managed worktree lifecycle",
    `${worktreeWorkspaceId} close -> closed inventory -> same-id reopen with fresh backing -> safe delete`,
  );

  callTool(oauth.accessToken, sessionId, 115, "write", {
    workspaceId,
    path: "composite-sentinel.txt",
    content: "debug composite member acceptance\n",
  });
  const compositeOpened = callTool(oauth.accessToken, sessionId, 116, "open_workspace", {
    kind: "composite",
    name: "debug-lifecycle-composite",
    context: "none",
  });
  const compositeWorkspaceId = compositeOpened.structuredContent.workspaceId;
  callTool(oauth.accessToken, sessionId, 117, "open_workspace", {
    action: "member",
    workspaceId: compositeWorkspaceId,
    memberAction: "add",
    member: {
      name: "code",
      purpose: "Debug lifecycle member",
      workspaceId,
    },
  });
  const closedComposite = callTool(oauth.accessToken, sessionId, 118, "close_workspace", {
    workspaceId: compositeWorkspaceId,
  });
  assert.equal(closedComposite.structuredContent.action, "close");
  assert.equal(closedComposite.structuredContent.status, "closed");
  assert.equal(closedComposite.structuredContent.dissolved, false);
  const closedCompositeInventory = callTool(oauth.accessToken, sessionId, 119, "open_workspace", {
    action: "list",
    kind: "composite",
    workspaceId: compositeWorkspaceId,
    status: "closed",
  });
  assert.equal(closedCompositeInventory.structuredContent.compositeWorkspaces.length, 1);
  assert.equal(closedCompositeInventory.structuredContent.compositeWorkspaces[0].state, "closed");
  const closedCompositeRead = callTool(oauth.accessToken, sessionId, 120, "read", {
    workspaceId: compositeWorkspaceId,
    member: "code",
    path: "composite-sentinel.txt",
  });
  assert.equal(closedCompositeRead.isError, true);

  const reopenedComposite = callTool(oauth.accessToken, sessionId, 121, "open_workspace", {
    workspaceId: compositeWorkspaceId,
    context: "none",
  });
  assert.equal(reopenedComposite.structuredContent.workspaceId, compositeWorkspaceId);
  assert.equal(reopenedComposite.structuredContent.status, "active");
  assert.equal(reopenedComposite.structuredContent.members[0].workspaceId, workspaceId);
  const reopenedCompositeRead = callTool(oauth.accessToken, sessionId, 122, "read", {
    workspaceId: compositeWorkspaceId,
    member: "code",
    path: "composite-sentinel.txt",
  });
  assert.match(reopenedCompositeRead.structuredContent.result, /debug composite member acceptance/);

  const deletedComposite = callTool(oauth.accessToken, sessionId, 123, "close_workspace", {
    workspaceId: compositeWorkspaceId,
    action: "delete",
  });
  assert.equal(deletedComposite.structuredContent.action, "delete");
  assert.equal(deletedComposite.structuredContent.dissolved, true);
  const memberAfterCompositeDelete = callTool(oauth.accessToken, sessionId, 124, "read", {
    workspaceId,
    path: "composite-sentinel.txt",
  });
  assert.match(memberAfterCompositeDelete.structuredContent.result, /debug composite member acceptance/);
  const deletedCompositeInventory = callTool(oauth.accessToken, sessionId, 125, "open_workspace", {
    action: "list",
    kind: "composite",
    workspaceId: compositeWorkspaceId,
  });
  assert.equal(deletedCompositeInventory.structuredContent.compositeWorkspaces.length, 0);
  pass(
    "Composite lifecycle",
    `${compositeWorkspaceId} close -> closed/non-routable -> same-id reopen -> delete; member Workspace preserved`,
  );

  exerciseReleaseTagHooks(oauth.accessToken, sessionId);
  exerciseSubagentHooks(env, stateDir, workspaceId, checkoutWorkspace);

  const hookEntries = readHookEntries(hookLog);
  const hookEvents = hookEntries.map((entry) => entry.event);
  for (const expected of [
    "WorkspaceOpen",
    "BeforeTool",
    "AfterTool",
    "AfterToolFailure",
    "AfterFileChange",
    "BeforeWorktreeClose",
    "AfterWorktreeClose",
    "SubagentStart",
    "SubagentStop",
  ]) {
    assert.ok(hookEvents.includes(expected), `debug hook log did not contain ${expected}`);
  }
  assert.ok(
    hookEvents.indexOf("BeforeWorktreeClose") < hookEvents.indexOf("AfterWorktreeClose"),
    "worktree close hooks were recorded out of order",
  );
  pass("Hooks v1 dogfood", Array.from(new Set(hookEvents)).join(", "));

  const deleteSession = curlRequest({
    method: "DELETE",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
  });
  assert.ok([200, 202, 204].includes(deleteSession.status));
  acceptanceCompleted = true;
} catch (error) {
  console.error("\nForgeRelay 7677 acceptance failed.");
  throw error;
} finally {
  rmSync(tempAcceptanceRoot, { recursive: true, force: true });
  await stopServer(server);
}

if (acceptanceCompleted) {
  assertCodeIntelligenceAcceptanceShutdown({ logPath: codeIntelligenceLog, pass });
  console.log("\nForgeRelay 7677 acceptance passed.");
  console.log(`Artifacts: ${acceptanceRoot}`);
}

function authorizeDebugClient(metadata) {
  const redirectUri = `${debugBaseUrl}/debug/callback`;
  const registration = jsonRequest(metadata.registration_endpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ForgeRelay 7677 acceptance",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(registration.status, 201);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationBody = new URLSearchParams({
    response_type: "code",
    client_id: registration.json.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource: debugMcpUrl,
    state: "forgerelay-debug-acceptance",
    owner_token: ownerToken,
  }).toString();
  const authorization = curlRequest({
    method: "POST",
    url: metadata.authorization_endpoint,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationBody,
  });
  assert.equal(authorization.status, 302);
  const redirect = new URL(authorization.headers.get("location"));
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "forgerelay-debug-acceptance");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const token = jsonRequest(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.json.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: debugMcpUrl,
    }).toString(),
  });
  assert.equal(token.status, 200);
  assert.equal(token.json.token_type, "bearer");
  assert.equal(token.json.scope, "devspace");
  assert.ok(token.json.access_token);
  return { accessToken: token.json.access_token };
}

function initializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
      clientInfo: { name: "forgerelay-debug-acceptance", version: "1.0.0" },
    },
  };
}

function mcpRequest(accessToken, sessionId, request) {
  const response = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, response.body);
  return { response, message: parseMcpMessage(response.body, request.id) };
}

function callTool(accessToken, sessionId, id, name, args, meta) {
  const message = mcpRequest(accessToken, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    },
  }).message;
  assert.equal(message.id, id);
  assert.ok(message.result, `tool ${name} did not return a result`);
  return message.result;
}

function mcpHeaders(accessToken, sessionId) {
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function parseMcpMessage(body, expectedId) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const messages = dataLines.length > 0
    ? dataLines.map((line) => JSON.parse(line))
    : [JSON.parse(body)];
  return messages.find((message) => message.id === expectedId) ?? messages[0];
}

function jsonRequest(url, options = {}) {
  const response = curlRequest({
    method: options.method ?? "GET",
    url,
    headers: options.headers,
    body: options.body,
  });
  return { ...response, json: JSON.parse(response.body) };
}

function curlRequest({ method = "GET", url, headers = {}, body }) {
  const marker = `__FORGERELAY_DEBUG_STATUS_${randomUUID()}__`;
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--request",
    method,
    "--dump-header",
    "-",
    "--output",
    "-",
    "--write-out",
    `\n${marker}%{http_code}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }
  if (body !== undefined) {
    args.push("--data-binary", "@-");
  }
  args.push(url);

  const result = spawnSync("curl", args, {
    cwd: repoRoot,
    input: body,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`curl ${method} ${url} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }

  const statusMarker = `\n${marker}`;
  const markerIndex = result.stdout.lastIndexOf(statusMarker);
  assert.notEqual(markerIndex, -1, `curl response did not contain status marker for ${url}`);
  const rawResponse = result.stdout.slice(0, markerIndex);
  const status = Number(result.stdout.slice(markerIndex + statusMarker.length).trim());
  const separator = rawResponse.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const headerEnd = rawResponse.indexOf(separator);
  assert.notEqual(headerEnd, -1, `curl response did not contain headers for ${url}`);
  const headerBlock = rawResponse.slice(0, headerEnd);
  const responseBody = rawResponse.slice(headerEnd + separator.length);
  const responseHeaders = new Map();
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers: responseHeaders, body: responseBody };
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`debug server exited before health check: ${child.exitCode}`);
    }
    try {
      const response = jsonRequest(`${debugBaseUrl}/healthz`);
      if (response.status === 200) return response.json;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error("debug server did not become healthy on 127.0.0.1:7677");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function setupGitProject(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "debug git project\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "forgerelay-debug@example.com"]);
  runGit(root, ["config", "user.name", "ForgeRelay Debug"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial debug commit"]);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function gitOutput(cwd, args, options = {}) {
  const gitArgs = options.gitDir ? ["--git-dir", cwd, ...args] : args;
  const result = spawnSync("git", gitArgs, {
    ...(options.gitDir ? {} : { cwd }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

function exerciseReleaseTagHooks(accessToken, sessionId) {
  setupGitProject(releaseProject);
  runGit(acceptanceRoot, ["init", "--bare", releaseRemote]);
  runGit(releaseProject, ["remote", "add", "origin", releaseRemote]);
  mkdirSync(join(releaseProject, ".forgerelay", "hooks"), { recursive: true });
  writeFileSync(
    join(releaseProject, ".forgerelay", "release-check.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'const payload = process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}";',
      'const parsed = JSON.parse(payload);',
      'writeFileSync("release-ci-ran.txt", payload);',
      'if (parsed.command === "git push origin v0.2.1") process.exit(17);',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(releaseProject, ".forgerelay", "hooks", "release-tag-local-ci.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "git push origin v0\\.2\\.[01]" },
      command: "node .forgerelay/release-check.mjs",
      timeoutSeconds: 30,
      report: true,
    }, null, 2) + "\n",
  );
  runGit(releaseProject, ["add", ".forgerelay"]);
  runGit(releaseProject, ["commit", "-m", "Add release hook fixture"]);
  runGit(releaseProject, ["tag", "v0.2.0"]);
  runGit(releaseProject, ["tag", "v0.2.1"]);

  const opened = callTool(accessToken, sessionId, 11, "open_workspace", {
    path: releaseProject,
  });
  const releaseWorkspaceId = opened.structuredContent.workspaceId;

  const pushed = callTool(accessToken, sessionId, 12, "bash", {
    workspaceId: releaseWorkspaceId,
    command: "git status --short && git push origin v0.2.0 && echo release-pushed",
  });
  assert.equal(pushed.isError, undefined);
  assert.match(toolText(pushed), /release-tag-local-ci \(BeforeTool, project\) passed/);
  assert.ok(existsSync(join(releaseProject, "release-ci-ran.txt")));
  assert.deepEqual(JSON.parse(readFileSync(join(releaseProject, "release-ci-ran.txt"), "utf8")), {
    tool: "bash",
    action: "run",
    command: "git push origin v0.2.0",
    workingDirectory: ".",
    originalCommand: "git status --short && git push origin v0.2.0 && echo release-pushed",
  });
  assert.equal(
    gitOutput(releaseRemote, ["rev-parse", "refs/tags/v0.2.0"], { gitDir: true }),
    gitOutput(releaseProject, ["rev-parse", "v0.2.0"]),
  );

  const blocked = callTool(accessToken, sessionId, 13, "bash", {
    workspaceId: releaseWorkspaceId,
    command: "git status --short && git push origin v0.2.1 && echo should-not-run",
  });
  assert.equal(blocked.isError, true);
  assert.match(toolText(blocked), /release-tag-local-ci.*failed/);
  const missingTag = spawnSync("git", ["--git-dir", releaseRemote, "show-ref", "--verify", "--quiet", "refs/tags/v0.2.1"]);
  assert.notEqual(missingTag.status, 0, "blocked release tag unexpectedly reached the remote");
  pass("release tag hook gate", "local Hook passed before v0.2.0 push and blocked v0.2.1 before remote mutation");
}

function exerciseSubagentHooks(runtimeEnv, debugStateDir, workspaceId, workspaceRoot) {
  const seedScript = [
    'import { SubagentSessionStore } from "./src/subagents/sessions/store.js";',
    'const store = new SubagentSessionStore(process.env.FORGERELAY_STATE_DIR);',
    'const record = store.create({',
    `  workspaceId: ${JSON.stringify(workspaceId)},`,
    `  workspaceRoot: ${JSON.stringify(workspaceRoot)},`,
    '  profileName: "debug-missing-profile",',
    '  provider: "codex",',
    '  activeRun: { id: "run_debug_acceptance", startedAt: new Date().toISOString() },',
    '});',
    'store.close();',
    'process.stdout.write(record.id);',
  ].join("\n");
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", seedScript], {
    cwd: repoRoot,
    env: { ...runtimeEnv, FORGERELAY_STATE_DIR: debugStateDir },
    encoding: "utf8",
  });
  if (seeded.status !== 0) {
    throw new Error(`unable to seed debug subagent: ${seeded.stderr.trim()}`);
  }
  const agentId = seeded.stdout.trim();
  assert.match(agentId, /^agt_/);

  const promptFile = join(acceptanceRoot, "subagent-prompt.txt");
  writeFileSync(promptFile, "debug acceptance prompt that must not reach a provider\n", "utf8");
  const worker = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "agents", "__worker", agentId, "--prompt-file", promptFile],
    { cwd: repoRoot, env: runtimeEnv, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (worker.status !== 0) {
    throw new Error(`debug subagent worker failed to execute: ${worker.stderr.trim()}`);
  }

  const inspectScript = [
    'import { SubagentSessionStore } from "./src/subagents/sessions/store.js";',
    'import { SubagentDeliveryMailbox } from "./src/subagents/sessions/delivery-mailbox.js";',
    'const store = new SubagentSessionStore(process.env.FORGERELAY_STATE_DIR);',
    `const record = store.get(${JSON.stringify(agentId)});`,
    `const deliveries = new SubagentDeliveryMailbox(process.env.FORGERELAY_STATE_DIR).claimSession(${JSON.stringify(workspaceId)}, ${JSON.stringify(agentId)});`,
    'store.close();',
    'process.stdout.write(JSON.stringify({ status: record?.status, latestRun: record?.latestRun, delivery: deliveries[0] }));',
  ].join("\n");
  const inspected = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", inspectScript], {
    cwd: repoRoot,
    env: runtimeEnv,
    encoding: "utf8",
  });
  if (inspected.status !== 0) {
    throw new Error(`unable to inspect debug subagent: ${inspected.stderr.trim()}`);
  }
  const record = JSON.parse(inspected.stdout);
  assert.equal(record.status, "idle");
  assert.equal(record.latestRun?.status, "failed");
  assert.equal(record.delivery?.outcome, "failed");
  assert.match(record.delivery?.error ?? "", /Subagent profile not found/);
  pass("subagent hook path", `${agentId} stopped in deterministic failed Run without calling a provider`);
}

function toolText(result) {
  return (result.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function readHookEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertDebugPortFree() {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: "127.0.0.1", port: 7677 });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      rejectPromise(new Error("debug port 7677 is already in use; stop the existing debug server first"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise();
    });
  });
}

function assertCurlAvailable() {
  const result = spawnSync("curl", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("npm run debug:accept requires curl on PATH.");
  }
}

function pass(label, detail) {
  console.log(`✓ ${label}: ${detail}`);
}
