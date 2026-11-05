import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../../src/server.js";
import { createHttpServer } from "../../src/mcp/server/transport/http-server.js";
import { loadConfig } from "../../src/runtime/config/config.js";
import type { CodeIntelligenceManager } from "../../src/lsp/runtime/manager.js";

// A disposable dev HTTP instance; never reuse installed configuration or state.
const base = "http://127.0.0.1:7677";
const debugRoot = resolve(".forgerelay-debug");
await mkdir(debugRoot, { recursive: true });
const root = await mkdtemp(join(debugRoot, "mutation-soak-"));
const configDir = join(root, "config");
const project = join(root, "project");
await mkdir(configDir);
await mkdir(join(project, ".forgerelay"), { recursive: true });
// Prevent discovery from inheriting the enclosing ForgeRelay Git project.
await promisify(execFile)("git", ["init", "--quiet", project]);
await writeFile(join(configDir, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: 7677, publicBaseUrl: base,
  allowedRoots: [root], stateDir: join(root, "state"), worktreeRoot: join(root, "worktrees"),
  agentDir: join(root, "agent"), subagents: false,
}));
const ownerToken = randomBytes(32).toString("base64url");
const config = loadConfig({
  PATH: process.env.PATH,
  FORGERELAY_CONFIG_DIR: configDir,
  FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
  FORGERELAY_TOOL_MODE: "full",
  FORGERELAY_WIDGETS: "off",
  FORGERELAY_SKILLS: "0",
  FORGERELAY_LOG_SHELL_COMMANDS: "0",
});
assert.equal(config.port, 7677);
assert.equal(config.stateDir, join(root, "state"));
let manager: CodeIntelligenceManager | undefined;
const diagnostics = new Map<string, number>();
const runtime = createHttpServer(config, {}, (...args) => {
  if (!manager) {
    manager = args[6];
    const run = manager.run.bind(manager);
    manager.run = async (...input) => {
      const result = await run(...input);
      if (result.operation === "diagnostics") {
        diagnostics.set(result.selectedServer, (diagnostics.get(result.selectedServer) ?? 0) + 1);
      }
      return result;
    };
  }
  return createMcpServer(...args);
});
const http = runtime.app.listen(7677, "127.0.0.1");
// EADDRINUSE fails the run; this script never stops an existing listener.
await once(http, "listening");
const client = new Client({ name: "mutation-soak", version: "1" }, {
  versionNegotiation: { mode: "legacy" },
});
type ToolInput =
  | { path: string; context?: "full" }
  | { workspaceId: string; path: string; content: string }
  | { workspaceId: string; path: string; edits: Array<{ oldText: string; newText: string }> };
let mutations = 0;
try {
  const auth = await fetch(`${base}/auth/cli`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_token: ownerToken }),
  });
  assert.equal(auth.status, 200);
  const tokens = await auth.json() as { access_token: string };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  }));
  const call = async (name: string, input: ToolInput, signal?: AbortSignal) => {
    const result = await client.callTool({
      name, arguments: input, _meta: { "openai/session": "mutation-soak" },
    }, { signal, timeout: 30_000 });
    assert.notEqual(result.isError, true, `${name} failed`);
    return result;
  };
  const opened = await call("open_workspace", { path: project, context: "full" });
  const workspaceId = (opened.structuredContent as { workspaceId: string }).workspaceId;
  assert.ok(manager);
  const cleanup = () => (manager as unknown as { closeIdle(now: number): Promise<void> })
    .closeIdle(Date.now() + 3_600_000);
  const pyright = join(homedir(), ".forgerelay/language-servers/node_modules/.bin/pyright-langserver");
  const fake = resolve("src/lsp/test-fixtures/fake-lsp-server.mjs");
  const cancellationLog = join(root, "cancellation-lsp.jsonl");
  const languageConfig = (generation: number) => ({
    pyright: {
      command: pyright, args: ["--stdio"],
      languages: ["python"], extensions: [".py"], projectMarkers: ["pyrightconfig.json"],
      env: { FORGERELAY_SOAK_GENERATION: String(generation) },
    },
    capacity: {
      command: process.execPath, args: [fake],
      languages: ["typescript"], extensions: [".cap"], projectMarkers: ["capacity.project"],
      env: { FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull" },
    },
    cancellation: {
      command: process.execPath, args: [fake],
      languages: ["typescript"], extensions: [".cancel"], projectMarkers: [],
      env: {
        FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
        FORGERELAY_FAKE_LSP_DIAGNOSTIC_DELAY_MS: "1000",
        FORGERELAY_FAKE_LSP_LOG: cancellationLog,
      },
    },
  });
  const definitions = join(project, ".forgerelay/language-servers.json");
  await writeFile(definitions, JSON.stringify(languageConfig(0)));
  for (let i = 0; i < 3; i++) {
    await mkdir(join(project, `python-${i}`));
    await writeFile(join(project, `python-${i}/pyrightconfig.json`), "{}");
  }
  const verify = async (result: Awaited<ReturnType<typeof call>>, diagnostic: RegExp) => {
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    if (diagnostic.source !== "pyright") assert.match(text, diagnostic);
    assert.doesNotMatch(text, /diagnostics warning|SIGTERM|start_failed|server_crashed|failed internally/i);
    mutations++;
  };
  for (let round = 0; round < 30; round++) {
    await Promise.all([0, 1, 2].map(async i => {
      const path = `python-${i}/main.py`;
      const oldText = `value: int = "round-${round}"`;
      await verify(await call("write", { workspaceId, path, content: `${oldText}\n` }), /pyright/);
      await verify(await call("edit", {
        workspaceId, path, edits: [{ oldText, newText: `value: int = "edited-${round}"` }],
      }), /pyright/);
    }));
    if (round % 5 === 4) {
      await writeFile(definitions, JSON.stringify(languageConfig(round)));
      await cleanup();
    }
    assert.equal(diagnostics.get("pyright"), mutations, "each Python mutation must finish real diagnostics");
    if (round % 10 === 9) console.log(`PASS real Pyright: ${round + 1} rounds, ${mutations} mutations`);
  }
  assert.equal(diagnostics.get("pyright"), 180, "every Python mutation must complete real Pyright diagnostics");
  // Default capacity is sixteen services. Distinct project roots force eviction.
  for (let i = 0; i < 18; i++) {
    await mkdir(join(project, `capacity-${i}`));
    await writeFile(join(project, `capacity-${i}/capacity.project`), "");
    await verify(await call("write", {
      workspaceId, path: `capacity-${i}/main.cap`, content: "const value = 1;\n",
    }), /pulled diagnostic/);
  }
  assert.ok(manager.stats().servicesTotal <= 16);
  assert.equal(diagnostics.get("capacity"), 18);
  await verify(await call("write", {
    workspaceId, path: "main.cancel", content: "const value = 1;\n",
  }), /pulled diagnostic/);
  const controller = new AbortController();
  const pendingEdit = call("edit", {
    workspaceId, path: "main.cancel", edits: [{ oldText: "1", newText: "2" }],
  }, controller.signal);
  const cancelled = assert.rejects(pendingEdit, /abort|cancel/i);
  const deadline = Date.now() + 10_000;
  while (true) {
    const log = await readFile(cancellationLog, "utf8");
    if (log.split('"method":"textDocument/diagnostic"').length >= 3) break;
    assert.ok(Date.now() < deadline, "cancelled edit must reach automatic diagnostics");
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  controller.abort();
  await cancelled;
  assert.match(await readFile(join(project, "main.cancel"), "utf8"), /value = 2/);
  await verify(await call("edit", {
    workspaceId, path: "main.cancel", edits: [{ oldText: "2", newText: "3" }],
  }), /pulled diagnostic/);
  await cleanup();
  assert.equal(manager.stats().servicesTotal, 0);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  console.log(`PASS dev HTTP/MCP soak: ${mutations} verified mutations + cancellation; state ${root}`);
  await writeFile(join(root, "result.json"), JSON.stringify({ mutations, passed: true }));
} finally {
  await client.close();
  await runtime.close();
  await new Promise<void>((resolveClose, reject) => http.close(error => error ? reject(error) : resolveClose()));
}
