import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../../runtime/config/config.js";
import { createServer } from "../../../server.js";

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "origin-test", version: "1" },
  },
});

interface OriginRequestOptions {
  host: string;
  origin?: string;
  path: string;
}

async function withTestServer(
  publicBaseUrl: string | undefined,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-origin-test-"));
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_STATE_DIR: join(root, ".state"),
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_OAUTH_OWNER_TOKEN: "origin-test-owner-token-long-enough",
    ...(publicBaseUrl ? { FORGERELAY_PUBLIC_BASE_URL: publicBaseUrl } : {}),
    FORGERELAY_WIDGETS: "off",
    HOST: "127.0.0.1",
    PORT: "7677",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");

  try {
    await once(httpServer, "listening");
    const { port } = httpServer.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function requestMcp(
  endpoint: string,
  options: OriginRequestOptions,
): Promise<{ body: string; response: Response }> {
  const headers: Record<string, string> = {
    host: options.host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (options.origin !== undefined) headers.origin = options.origin;

  const response = await fetch(`${endpoint}${options.path}`, {
    method: "POST",
    headers,
    body: initializeBody,
  });
  return { response, body: await response.text() };
}

test("routed public MCP enforces the canonical public Origin before OAuth", async (t) => {
  await withTestServer("https://babelbeast.com/forgerelay/main", async (endpoint) => {
    await t.test("accepts the hostname without treating the path prefix as Origin identity", async () => {
      const { response, body } = await requestMcp(endpoint, {
        host: "babelbeast.com",
        origin: "https://babelbeast.com",
        path: "/forgerelay/main/mcp",
      });
      assert.equal(response.status, 401, body);
      assert.match(body, /Missing Authorization header/);
    });

    await t.test("rejects a foreign origin", async () => {
      const { response, body } = await requestMcp(endpoint, {
        host: "babelbeast.com",
        origin: "https://evil.example",
        path: "/forgerelay/main/mcp",
      });
      assert.equal(response.status, 403, body);
      assert.match(body, /Invalid Origin: evil\.example/);
    });

    await t.test("accepts native clients without an Origin header", async () => {
      const { response, body } = await requestMcp(endpoint, {
        host: "babelbeast.com",
        path: "/forgerelay/main/mcp",
      });
      assert.equal(response.status, 401, body);
      assert.match(body, /Missing Authorization header/);
    });

    await t.test("rejects invalid Origin syntax", async () => {
      const { response, body } = await requestMcp(endpoint, {
        host: "babelbeast.com",
        origin: "babelbeast.com",
        path: "/forgerelay/main/mcp",
      });
      assert.equal(response.status, 403, body);
      assert.match(body, /Invalid Origin header: babelbeast\.com/);
    });
  });
});

test("public MCP App assets accept ChatGPT sandbox origins without broadening MCP Origin access", async () => {
  await withTestServer("https://babelbeast.com/forgerelay/main", async (endpoint) => {
    const sandboxOrigin = "https://babelbeast-com.web-sandbox.oaiusercontent.com";
    const assetResponse = await fetch(
      `${endpoint}/forgerelay/main/mcp-app-assets/assets/activity-panel-app.js`,
      {
        method: "OPTIONS",
        headers: {
          host: "babelbeast.com",
          origin: sandboxOrigin,
          "access-control-request-method": "GET",
        },
      },
    );
    assert.equal(assetResponse.status, 204);
    assert.equal(assetResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(assetResponse.headers.get("cross-origin-resource-policy"), "cross-origin");

    const { response, body } = await requestMcp(endpoint, {
      host: "babelbeast.com",
      origin: sandboxOrigin,
      path: "/forgerelay/main/mcp",
    });
    assert.equal(response.status, 403, body);
    assert.match(body, /Invalid Origin: babelbeast-com\.web-sandbox\.oaiusercontent\.com/);
  });
});

test("local-only MCP keeps localhost browser origins compatible", async () => {
  await withTestServer(undefined, async (endpoint) => {
    const { response, body } = await requestMcp(endpoint, {
      host: "localhost",
      origin: "http://localhost:9412",
      path: "/mcp",
    });
    assert.equal(response.status, 401, body);
    assert.match(body, /Missing Authorization header/);
  });
});
