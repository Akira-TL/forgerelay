import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../runtime/testing/server-fixture.js";

const fixtureServer = fileURLToPath(new URL("./test-fixtures/external-mcp-server.mjs", import.meta.url));
const CONFIG_SECRET = "EXTERNAL_MCP_CONFIG_SECRET_SENTINEL";
const CALL_SECRET = "EXTERNAL_MCP_CALL_SECRET_SENTINEL";
const HTTP_SECRET = "EXTERNAL_MCP_HTTP_SECRET_SENTINEL";

test("configured external MCP tools are discovered and called through capability without implicit path dereference", async (t) => {
  const context = await fixture(t, {
    userConfig: {
      mcpServers: {
        blender: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureServer],
          env: { FIXTURE_SECRET: CONFIG_SECRET },
        },
      },
    },
  });
  const conversation = "chat-external-mcp-capability";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<Record<string, unknown>>;
  assert.ok(catalog.some((entry) => entry.name === "mcp.external"));

  const call = (arguments_: Record<string, unknown>) => context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "mcp.external", action: "run", arguments: arguments_ },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const servers = await call({ operation: "servers" });
  assert.equal(servers.isError, undefined, allResponseText(servers));
  assert.deepEqual((structuredContent(servers).result as Record<string, unknown>).servers, [
    { name: "blender", transport: "stdio" },
  ]);
  assert.doesNotMatch(JSON.stringify(servers), new RegExp(CONFIG_SECRET));
  assert.doesNotMatch(JSON.stringify(servers), new RegExp(fixtureServer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const tools = await call({ operation: "tools", server: "blender" });
  assert.equal(tools.isError, undefined, allResponseText(tools));
  const toolNames = ((structuredContent(tools).result as Record<string, unknown>).tools as Array<Record<string, unknown>>)
    .map((entry) => entry.name);
  assert.deepEqual(toolNames.sort(), ["echo_text", "fail", "path_only"]);

  const echoed = await call({
    operation: "call",
    server: "blender",
    tool: "echo_text",
    arguments: { message: CALL_SECRET },
  });
  assert.equal(echoed.isError, undefined, allResponseText(echoed));
  const echoedResult = structuredContent(echoed).result as Record<string, unknown>;
  assert.deepEqual(echoedResult.content, [{ type: "text", text: `echo:${CALL_SECRET}` }]);

  const pathOnly = await call({ operation: "call", server: "blender", tool: "path_only" });
  assert.equal(pathOnly.isError, undefined, allResponseText(pathOnly));
  assert.deepEqual((structuredContent(pathOnly).result as Record<string, unknown>).content, [
    { type: "text", text: "renders/output.png" },
  ]);
  assert.doesNotMatch(JSON.stringify(pathOnly), /image\/|base64|mimeType|artifact/i);

  const warningLines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    warningLines.push(values.map(String).join(" "));
    originalWarn(...values);
  };
  let failed;
  try {
    failed = await call({
      operation: "call",
      server: "blender",
      tool: "fail",
      arguments: { message: CALL_SECRET },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(failed.isError, true);
  assert.match(allResponseText(failed), /blender.*fail|fail.*blender/i);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(CALL_SECRET));
  assert.doesNotMatch(JSON.stringify(failed), /fixture upstream failure/i);
  assert.doesNotMatch(warningLines.join("\n"), new RegExp(CALL_SECRET));
  assert.doesNotMatch(warningLines.join("\n"), /fixture upstream failure/i);

  const unknownServer = await call({ operation: "tools", server: "not-configured" });
  assert.equal(unknownServer.isError, true);
  assert.match(allResponseText(unknownServer), /not-configured/i);

  const unknownTool = await call({ operation: "call", server: "blender", tool: "not_registered" });
  assert.equal(unknownTool.isError, true);
  assert.match(allResponseText(unknownTool), /blender.*not_registered|not_registered.*blender/i);

  const injectedTarget = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "mcp.external",
      action: "run",
      arguments: {
        operation: "call",
        server: "blender",
        tool: "echo_text",
        url: "http://127.0.0.1:1/mcp",
      },
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(injectedTarget.isError, true);
  assert.match(allResponseText(injectedTarget), /invalid_arguments/i);

  const echoActivity = context.auditStore.getActivity("act_test_3");
  assert.equal(echoActivity?.state, "done");
  assert.equal(echoActivity?.workspace.id, workspaceId);
  assert.deepEqual(echoActivity?.request, {
    workspaceId,
    name: "mcp.external",
    action: "run",
    arguments: {
      operation: "call",
      server: "blender",
      tool: "echo_text",
      argumentKeys: ["message"],
    },
  });
  assert.deepEqual(echoActivity?.result, {
    name: "mcp.external",
    action: "run",
    result: {
      operation: "call",
      server: "blender",
      tool: "echo_text",
      contentTypes: ["text"],
    },
  });
  const failedActivity = context.auditStore.getActivity("act_test_5");
  assert.equal(failedActivity?.state, "failed");
  assert.equal(failedActivity?.workspace.id, workspaceId);
  assert.deepEqual(failedActivity?.result, {
    name: "mcp.external",
    action: "run",
    error: { code: "mcp.tool_failed" },
  });

  const auditJson = JSON.stringify([
    context.auditStore.getActivity("act_test_1"),
    context.auditStore.getActivity("act_test_2"),
    echoActivity,
    context.auditStore.getActivity("act_test_4"),
    failedActivity,
  ]);
  assert.doesNotMatch(auditJson, new RegExp(CONFIG_SECRET));
  assert.doesNotMatch(auditJson, new RegExp(CALL_SECRET));
  assert.doesNotMatch(auditJson, /fixture upstream failure/i);
  assert.match(auditJson, /mcp\.external/);
  assert.match(auditJson, /blender/);
  assert.match(auditJson, /echo_text/);
});

test("configured Streamable HTTP MCP tools are discovered and called through capability", async (t) => {
  const external = await startStreamableHttpFixture(t);
  const context = await fixture(t, {
    userConfig: {
      mcpServers: {
        renderer: {
          transport: "streamable-http",
          url: external.url,
          headers: { "X-Fixture-Secret": HTTP_SECRET },
        },
      },
    },
  });
  const conversation = "chat-external-mcp-http-capability";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (arguments_: Record<string, unknown>) => context.client.callTool({
    name: "capability",
    arguments: { workspaceId, name: "mcp.external", action: "run", arguments: arguments_ },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const servers = await call({ operation: "servers" });
  assert.equal(servers.isError, undefined, allResponseText(servers));
  assert.deepEqual((structuredContent(servers).result as Record<string, unknown>).servers, [
    { name: "renderer", transport: "streamable-http" },
  ]);
  assert.doesNotMatch(JSON.stringify(servers), new RegExp(HTTP_SECRET));
  assert.doesNotMatch(JSON.stringify(servers), /127\.0\.0\.1:\d+\/mcp/);

  const tools = await call({ operation: "tools", server: "renderer" });
  assert.equal(tools.isError, undefined, allResponseText(tools));
  assert.deepEqual(
    ((structuredContent(tools).result as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      .map((entry) => entry.name),
    ["http_echo"],
  );

  const echoed = await call({
    operation: "call",
    server: "renderer",
    tool: "http_echo",
    arguments: { message: "hello-http" },
  });
  assert.equal(echoed.isError, undefined, allResponseText(echoed));
  assert.deepEqual((structuredContent(echoed).result as Record<string, unknown>).content, [
    { type: "text", text: "http:hello-http" },
  ]);
  assert.equal(external.lastSecret(), HTTP_SECRET);
  assert.doesNotMatch(JSON.stringify(echoed), new RegExp(HTTP_SECRET));
});

async function startStreamableHttpFixture(t: TestContext): Promise<{
  url: string;
  lastSecret: () => string | undefined;
}> {
  let lastSecret: string | undefined;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Set<McpServer>();

  const httpServer = createHttpServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const header = request.headers["x-fixture-secret"];
    lastSecret = Array.isArray(header) ? header[0] : header;
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      void existing.handleRequest(request, response).catch(() => failHttpFixtureRequest(response));
      return;
    }
    if (sessionId) {
      response.writeHead(404).end();
      return;
    }
    void readJsonRequest(request).then(async (body) => {
      if (!isJsonRpcInitialize(body)) {
        response.writeHead(400).end();
        return;
      }
      const mcpServer = createHttpMcpServer();
      servers.add(mcpServer);
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, transport);
        },
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
    }).catch(() => failHttpFixtureRequest(response));
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await Promise.all([...servers].map((server) => server.close().catch(() => undefined)));
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });
  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}/mcp`,
    lastSecret: () => lastSecret,
  };
}

function createHttpMcpServer(): McpServer {
  const server = new McpServer({ name: "forgerelay-external-mcp-http-fixture", version: "1.0.0" });
  server.registerTool(
    "http_echo",
    {
      description: "Echo one value over Streamable HTTP.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `http:${message}` }],
    }),
  );
  return server;
}

async function readJsonRequest(request: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isJsonRpcInitialize(value: unknown): value is { method: "initialize" } {
  return typeof value === "object"
    && value !== null
    && "method" in value
    && (value as { method?: unknown }).method === "initialize";
}

function failHttpFixtureRequest(response: { headersSent: boolean; writeHead: (status: number) => unknown; end: () => unknown }): void {
  if (!response.headersSent) response.writeHead(500);
  response.end();
}
