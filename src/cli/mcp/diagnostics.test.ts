import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

void test("mcp list resolves Project scope from a nested cwd and --global excludes Project entries", async (t) => {
  const context = createCliContext(t);
  const nested = join(context.projectRoot, "src", "nested");
  mkdirSync(nested, { recursive: true });
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      global: { transport: "stdio", command: process.execPath },
      shared: { transport: "streamable-http", url: "https://global.example/mcp" },
    },
  });
  writeJson(join(context.projectRoot, ".forgerelay", "mcp.json"), {
    servers: {
      project: { transport: "stdio", command: process.execPath },
      shared: { disabled: true },
    },
  });

  const project = await runCli(["mcp", "list"], context.env, nested);
  assert.equal(project.status, 0, project.stderr);
  assert.match(project.stdout, /Scope: project/);
  assert.match(project.stdout, new RegExp(`Project: ${escapeRegExp(context.projectRoot)}`));
  assert.match(project.stdout, /project[\s\S]*source: project[\s\S]*transport: stdio/);
  assert.match(project.stdout, /shared[\s\S]*source: project[\s\S]*status: disabled/);
  assert.match(project.stdout, /global[\s\S]*source: global/);

  const global = await runCli(["mcp", "list", "--global"], context.env, nested);
  assert.equal(global.status, 0, global.stderr);
  assert.match(global.stdout, /Scope: global/);
  assert.match(global.stdout, /shared[\s\S]*source: global/);
  assert.doesNotMatch(global.stdout, /\n  project\n/);
});

void test("mcp list returns a nonzero exit for invalid config and explains last-known-good runtime behavior", async (t) => {
  const context = createCliContext(t);
  writeFileSync(
    join(context.projectRoot, ".forgerelay", "mcp.json"),
    '{"servers":{"secret":"INVALID-CONTENT-SENTINEL"',
  );

  const result = await runCli(["mcp", "list", "--project", context.projectRoot], context.env, context.projectRoot);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /project[\s\S]*invalid/);
  assert.match(result.stdout, /Existing ForgeRelay runtimes[\s\S]*last-known-good/);
  assert.doesNotMatch(result.stdout + result.stderr, /INVALID-CONTENT-SENTINEL/);
});

void test("mcp test reports protocol, tool count, and ready status for a reachable server", async (t) => {
  const fixture = await startMcpFixture(t);
  const context = createCliContext(t);
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      ready: { transport: "streamable-http", url: fixture.url },
    },
  });

  const result = await runCli(["mcp", "test", "ready", "--global"], context.env, context.projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Testing External MCP ready/);
  assert.match(result.stdout, /Source: global/);
  assert.match(result.stdout, /Transport: streamable-http/);
  assert.match(result.stdout, /Connection: ok/);
  assert.match(result.stdout, /Protocol: legacy · \d{4}-\d{2}-\d{2}/);
  assert.match(result.stdout, /Tools: 1/);
  assert.match(result.stdout, /ready is ready\./);
});

void test("mcp test persists and reports auth-required with a concrete human next action", async (t) => {
  const unauthorized = createHttpServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": "Bearer" });
    response.end();
  });
  await listen(unauthorized);
  t.after(() => close(unauthorized));
  const context = createCliContext(t);
  const url = `http://127.0.0.1:${(unauthorized.address() as AddressInfo).port}/mcp`;
  writeJson(join(context.configDir, "mcp.json"), {
    servers: { secure: { transport: "streamable-http", url } },
  });

  const result = await runCli(["mcp", "test", "secure", "--global"], context.env, context.projectRoot);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Auth: oauth · auth required/);
  assert.match(result.stdout, /Connection: blocked by authentication/);
  assert.match(result.stdout, /Next: forgerelay mcp auth secure --global/);
  assert.match(result.stderr, /External MCP secure test failed/);
});

void test("mcp test distinguishes unreachable transport from tool discovery failure", async (t) => {
  const context = createCliContext(t);
  writeJson(join(context.configDir, "mcp.json"), {
    servers: { unreachable: { transport: "streamable-http", url: "http://127.0.0.1:1/mcp" } },
  });
  const unreachable = await runCli(["mcp", "test", "unreachable", "--global"], context.env, context.projectRoot);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /Connection: failed/);
  assert.match(unreachable.stdout, /Reason: (ECONNREFUSED|MCP connection or protocol handshake failed\.)/);
  assert.doesNotMatch(unreachable.stdout, /Tools: failed/);

  const fixture = await startMcpFixture(t, { failToolDiscovery: true });
  writeJson(join(context.configDir, "mcp.json"), {
    servers: { broken: { transport: "streamable-http", url: fixture.url } },
  });
  const broken = await runCli(["mcp", "test", "broken", "--global"], context.env, context.projectRoot);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /Connection: ok/);
  assert.match(broken.stdout, /Tools: failed/);
  assert.match(broken.stderr, /External MCP broken test failed/);
});

void test("doctor reports External MCP passively without starting configured stdio servers", async (t) => {
  const context = createCliContext(t);
  const marker = join(context.root, "doctor-started-stdio.txt");
  writeJson(join(context.configDir, "mcp.json"), {
    servers: {
      passive: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      },
    },
  });

  const result = await runCli(["doctor"], context.env, context.projectRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /External MCP:/);
  assert.match(result.stdout, /Effective servers: 1/);
  assert.match(result.stdout, /Hot reload: active/);
  assert.match(result.stdout, /Active checks: not run/);
  assert.equal(existsSync(marker), false, "doctor must not start an External MCP stdio process");
});

interface CliContext {
  root: string;
  configDir: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}

function createCliContext(t: TestContext): CliContext {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-mcp-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectRoot, ".forgerelay"), { recursive: true });
  writeJson(join(configDir, "config.json"), { allowedRoots: [projectRoot] });
  writeJson(join(configDir, "auth.json"), { ownerToken: "diagnostics-owner-token-0123456789" });
  const { FORGERELAY_WORKSPACE_ROOT: _workspaceRoot, ...baseEnv } = process.env;
  return {
    root,
    configDir,
    projectRoot,
    env: {
      ...baseEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_ALLOWED_ROOTS: projectRoot,
    },
  };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const repositoryRoot = process.cwd();
  const child = spawn(
    join(repositoryRoot, "node_modules", ".bin", "tsx"),
    [join(repositoryRoot, "src", "cli.ts"), ...args],
    {
      cwd,
      env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
  return { status, stdout, stderr };
}

interface McpFixture {
  url: string;
}

async function startMcpFixture(
  t: TestContext,
  options: { failToolDiscovery?: boolean } = {},
): Promise<McpFixture> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const mcpServers = new Set<Server>();
  const http = createHttpServer((request, response) => {
    void handleMcpRequest(request, response, sessions, mcpServers, options).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await listen(http);
  t.after(async () => {
    await Promise.all([...mcpServers].map((server) => server.close().catch(() => undefined)));
    await close(http);
  });
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp` };
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  servers: Set<Server>,
  options: { failToolDiscovery?: boolean },
): Promise<void> {
  const sessionHeader = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(request, response);
    return;
  }
  if (sessionId) {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(request)) as { method?: unknown };
  if (body.method !== "initialize") {
    response.writeHead(400).end();
    return;
  }

  const mcpServer = new Server(
    { name: "diagnostics-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    if (options.failToolDiscovery) throw new Error("fixture tools/list failure");
    return {
      tools: [{
        name: "fixture_tool",
        description: "fixture",
        inputSchema: { type: "object", properties: {} },
      }],
    };
  });
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
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function close(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
