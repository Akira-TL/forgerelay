import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { debugRoot, repoRoot } from "../runtime.mjs";
import { assertPortFree, pass, stopServer, waitForHealth } from "./support.mjs";

const port = 7678;
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
const acceptanceRoot = resolve(debugRoot, "modern-http-acceptance");
const configDir = join(acceptanceRoot, "config");
const stateDir = join(acceptanceRoot, "state");
const worktreeRoot = join(acceptanceRoot, "worktrees");
const workspaceRoot = join(acceptanceRoot, "workspace");
const ownerToken = randomBytes(32).toString("base64url");

await assertPortFree(port);
rmSync(acceptanceRoot, { recursive: true, force: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(workspaceRoot, "README.md"), "modern MCP acceptance workspace\n");
writeFileSync(join(configDir, "config.json"), `${JSON.stringify({
  host: "127.0.0.1",
  port,
  allowedRoots: [workspaceRoot],
  publicBaseUrl: baseUrl,
  allowedHosts: ["localhost", "127.0.0.1", "::1"],
  stateDir,
  worktreeRoot,
}, null, 2)}\n`);
writeFileSync(join(configDir, "auth.json"), `${JSON.stringify({
  ownerToken,
  instanceId: "modern-http-acceptance-7678",
}, null, 2)}\n`, { mode: 0o600 });

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    name !== "HOST" && name !== "PORT" && !name.startsWith("FORGERELAY_")
  ),
);
const env = {
  ...cleanEnv,
  HOST: "127.0.0.1",
  PORT: String(port),
  FORGERELAY_CONFIG_DIR: configDir,
  FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
  FORGERELAY_PUBLIC_BASE_URL: baseUrl,
  FORGERELAY_TOOL_MODE: "full",
  FORGERELAY_WIDGETS: "off",
  FORGERELAY_LOG_LEVEL: "debug",
  FORGERELAY_LOG_FORMAT: "json",
};

let serverLogs = "";
const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (chunk) => { serverLogs += chunk.toString(); });
server.stderr?.on("data", (chunk) => { serverLogs += chunk.toString(); });

let client;
try {
  await waitForHealth(server, baseUrl);
  pass("modern HTTP health", baseUrl);

  const unauthorized = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /Bearer .*resource_metadata=/i);
  pass("modern HTTP bearer challenge", "unauthenticated MCP request advertises protected-resource metadata");

  const tokenResponse = await fetch(`${baseUrl}/auth/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_token: ownerToken }),
  });
  const tokenBody = await tokenResponse.text();
  assert.equal(tokenResponse.status, 200, tokenBody);
  const tokens = JSON.parse(tokenBody);
  assert.equal(tokens.token_type, "bearer");
  assert.ok(tokens.access_token);
  pass("modern HTTP auth", "real ForgeRelay bearer token issued on 7678");

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    },
  });
  client = new Client(
    { name: "forgerelay-modern-http-acceptance", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.equal(transport.sessionId, undefined);
  pass("modern protocol negotiation", "2026-07-28 connected without Mcp-Session-Id");

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "open_workspace"));
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot, context: "none" },
  });
  assert.notEqual(opened.isError, true);
  assert.match(String(opened.structuredContent?.workspaceId ?? ""), /^ws_/);
  pass("modern tools call", "tools/list and open_workspace completed over stateless HTTP");

  assert.equal(serverLogs.includes("\"protocolEra\":\"modern\""), true);
  pass("modern routing observability", "ForgeRelay classified the accepted request as modern");

  console.log("Modern HTTP acceptance passed.");
} catch (error) {
  if (serverLogs) process.stderr.write(`\n--- ForgeRelay 7678 logs ---\n${serverLogs}`);
  throw error;
} finally {
  try {
    await client?.close();
  } finally {
    await stopServer(server);
  }
}
