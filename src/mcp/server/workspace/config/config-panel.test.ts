import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ACTIVITY_PANEL_WORKSPACE_META_KEY } from "../../../../activity/ui/contract.js";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../../../runtime/testing/server-fixture.js";

test("activity Panel reports restart-required and last-known-good live configuration state", async (t) => {
  const context = await fixture(t, { userConfig: { host: "127.0.0.1" } });
  const opened = await callOpen(context.client, context.project, "chat-config-runtime-panel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const configPath = join(context.config.configDir, "config.json");

  await writeFile(configPath, JSON.stringify({ host: "0.0.0.0" }) + "\n");
  const panel = await context.client.callTool({ name: "activity_panel", arguments: { workspaceId } });
  assert.equal(panel.isError, undefined, allResponseText(panel));
  const panelWorkspace = (panel._meta as Record<string, unknown>)[ACTIVITY_PANEL_WORKSPACE_META_KEY] as Record<string, unknown>;
  const panelConfiguration = panelWorkspace.configuration as Record<string, unknown>;
  const restartRequired = panelConfiguration.restartRequired as Array<Record<string, unknown>>;
  assert.deepEqual(restartRequired.find((field) => field.logicalPath === "config.host"), {
    logicalPath: "config.host",
    configuredValue: "0.0.0.0",
    appliedValue: "127.0.0.1",
  });
  assert.equal(context.config.host, "127.0.0.1", "live config status must not mutate the running server");

  await writeFile(configPath, "{ invalid json\n");
  const snapshot = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId: String(structuredContent(panel).turnId), workspaceId },
  });
  assert.equal(snapshot.isError, undefined, allResponseText(snapshot));
  const snapshotWorkspace = (snapshot._meta as Record<string, unknown>)[ACTIVITY_PANEL_WORKSPACE_META_KEY] as Record<string, unknown>;
  const snapshotConfiguration = snapshotWorkspace.configuration as Record<string, unknown>;
  assert.deepEqual(snapshotConfiguration.restartRequired, restartRequired);
  assert.deepEqual(snapshotConfiguration.source, {
    state: "invalid",
    usingLastKnownGood: true,
    message: "General configuration is not valid JSON.",
  });
});

test("activity Panel reports live External MCP invalid/LKG state without duplicating an unchanged diagnostic", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-config-mcp-panel");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const mcpPath = join(context.config.configDir, "mcp.json");
  await writeFile(mcpPath, JSON.stringify({
    servers: { demo: { transport: "stdio", command: "demo-mcp" } },
  }) + "\n");

  const panel = await context.client.callTool({ name: "activity_panel", arguments: { workspaceId } });
  assert.equal(panel.isError, undefined, allResponseText(panel));

  await writeFile(mcpPath, "{ invalid json\n");
  const snapshot = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId: String(structuredContent(panel).turnId), workspaceId },
  });
  assert.equal(snapshot.isError, undefined, allResponseText(snapshot));
  const snapshotWorkspace = (snapshot._meta as Record<string, unknown>)[ACTIVITY_PANEL_WORKSPACE_META_KEY] as Record<string, unknown>;
  const configuration = snapshotWorkspace.configuration as Record<string, unknown>;
  const issues = configuration.issues as Array<Record<string, unknown>>;
  assert.deepEqual(issues, [{
    domain: "mcp",
    severity: "error",
    code: "invalid_source",
    source: mcpPath,
    usingLastKnownGood: true,
    message: "Configuration source is not valid JSON.",
  }]);

  const repeated = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId: String(structuredContent(panel).turnId), workspaceId },
  });
  const repeatedWorkspace = (repeated._meta as Record<string, unknown>)[ACTIVITY_PANEL_WORKSPACE_META_KEY] as Record<string, unknown>;
  const repeatedIssues = ((repeatedWorkspace.configuration as Record<string, unknown>).issues) as Array<Record<string, unknown>>;
  assert.deepEqual(repeatedIssues, issues);
});
