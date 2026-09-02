import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { debugBaseUrl, debugMcpUrl } from "../runtime.mjs";
import {
  authorizeDebugClient,
  callTool,
  curlRequest,
  initializeRequest,
  jsonRequest,
  mcpHeaders,
  mcpRequest,
  pass,
  toolText,
  waitForHealth,
} from "./support.mjs";

/** Validate the public MCP/OAuth contract and establish the canonical checkout
 * Workspace used by the remaining acceptance scenarios. */
export async function runBootstrapAcceptance({ server, packageJson, ownerToken, checkoutWorkspace, stateDir }) {
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

  const oauth = authorizeDebugClient(authorizationServer.json, ownerToken);
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
  assert.equal(resources.length, 1);

  const resourceTemplates = mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id: 22,
    method: "resources/templates/list",
    params: {},
  }).message.result.resourceTemplates;
  assert.deepEqual(resourceTemplates, []);

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

  pass("MCP App template", activityTemplateUri);

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
      "workspace.tasks",
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
    "workspace.tasks",
    "batch.execute",
    ...(process.platform === "linux" ? ["artifact.download"] : []),
  ]);
  assert.equal(capabilityCatalog[0].available, true);
  assert.equal(capabilityCatalog[0].guide.name, "lifecycle-hooks");

  const checkoutTaskStatePath = join(stateDir, "workspaces", workspaceId, "tasks.json");
  assert.ok(existsSync(checkoutTaskStatePath));
  const checkoutTaskList = callTool(oauth.accessToken, sessionId, 130, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "7677 release tasks" },
  });
  assert.equal(checkoutTaskList.isError, undefined);
  const checkoutListId = checkoutTaskList.structuredContent.result.lists[0].id;
  const checkoutTask = callTool(oauth.accessToken, sessionId, 131, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: checkoutListId,
      subject: "Verify v0.8.3 Task persistence",
      content: "created through real MCP",
      status: "in_progress",
    },
  });
  assert.equal(checkoutTask.isError, undefined);
  const checkoutTaskId = checkoutTask.structuredContent.result.lists[0].tasks[0].id;
  const taskFingerprintBeforeExternal = checkoutTask.structuredContent.result.fingerprint;
  const externalTaskState = JSON.parse(readFileSync(checkoutTaskStatePath, "utf8"));
  externalTaskState.lists[0].tasks[0].content = "reloaded external task edit";
  writeFileSync(checkoutTaskStatePath, `${JSON.stringify(externalTaskState, null, 2)}\n`);
  const reloadedCheckoutTasks = callTool(oauth.accessToken, sessionId, 132, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "get",
      level: "detail",
      listId: checkoutListId,
      taskId: checkoutTaskId,
    },
  });
  assert.equal(reloadedCheckoutTasks.isError, undefined);
  assert.equal(reloadedCheckoutTasks.structuredContent.result.task.id, checkoutTaskId);
  assert.equal(reloadedCheckoutTasks.structuredContent.result.task.content, "reloaded external task edit");
  assert.notEqual(reloadedCheckoutTasks.structuredContent.result.fingerprint, taskFingerprintBeforeExternal);

  const checkoutTaskSummary = callTool(oauth.accessToken, sessionId, 150, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get" },
  });
  const summaryProjection = checkoutTaskSummary.structuredContent.result;
  assert.equal(summaryProjection.level, "summary");
  assert.equal(summaryProjection.lists[0].id, checkoutListId);
  assert.equal(summaryProjection.lists[0].taskCount, 1);
  assert.equal(summaryProjection.lists[0].unfinishedTaskCount, 1);
  assert.equal(JSON.stringify(summaryProjection).includes(checkoutTaskId), false);
  assert.equal(JSON.stringify(summaryProjection).includes("reloaded external task edit"), false);

  const checkoutTaskHeaders = callTool(oauth.accessToken, sessionId, 151, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get", level: "headers", listId: checkoutListId },
  });
  const headersProjection = checkoutTaskHeaders.structuredContent.result;
  assert.equal(headersProjection.level, "headers");
  assert.equal(headersProjection.lists.length, 1);
  assert.equal(headersProjection.lists[0].tasks[0].id, checkoutTaskId);
  assert.equal(headersProjection.lists[0].tasks[0].subject, "Verify v0.8.3 Task persistence");
  assert.equal("content" in headersProjection.lists[0].tasks[0], false);

  const checkoutTaskDetail = callTool(oauth.accessToken, sessionId, 152, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "get",
      level: "detail",
      listId: checkoutListId,
      taskId: checkoutTaskId,
    },
  });
  const detailProjection = checkoutTaskDetail.structuredContent.result;
  assert.equal(detailProjection.level, "detail");
  assert.equal(detailProjection.task.id, checkoutTaskId);
  assert.equal(detailProjection.task.content, "reloaded external task edit");
  pass("workspace.tasks progressive disclosure", "summary -> headers -> one Task detail through real MCP");

  for (let index = 0; index < 29; index += 1) {
    const semanticWork = callTool(oauth.accessToken, sessionId, 160 + index, "read", {
      workspaceId,
      path: "README.md",
    });
    assert.doesNotMatch(toolText(semanticWork), /Reminder: this Workspace has unfinished active Tasks/);
  }
  const reminderWork = callTool(oauth.accessToken, sessionId, 189, "read", {
    workspaceId,
    path: "README.md",
  });
  assert.match(toolText(reminderWork), /Reminder: this Workspace has unfinished active Tasks/);
  assert.equal(toolText(reminderWork).includes("reloaded external task edit"), false);
  pass("workspace.tasks reminder", "default 30 semantic work calls emitted one body-free reminder");

  return {
    oauth,
    sessionId,
    workspaceConversationMeta,
    opened,
    workspaceId,
    capabilityCatalog,
    checkoutListId,
    checkoutTaskId,
  };
}
