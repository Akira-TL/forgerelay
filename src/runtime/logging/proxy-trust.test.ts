import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config/config.js";
import { createServer } from "../../server.js";

test("routed public proxies trust loopback sources without exposing undeclared root routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-proxy-test-"));
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: join(root, ".config"),
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_STATE_DIR: join(root, ".state"),
    FORGERELAY_WORKTREE_ROOT: join(root, ".worktrees"),
    FORGERELAY_OAUTH_OWNER_TOKEN: "proxy-test-owner-token-that-is-long-enough",
    FORGERELAY_PUBLIC_BASE_URL: "https://forge.example.com/forgerelay/debug,https://forge-alt.example.com/relay",
    FORGERELAY_WIDGETS: "off",
    HOST: "127.0.0.1",
    PORT: "7676",
  });
  const running = createServer(config);
  const httpServer = running.app.listen(0, "127.0.0.1");
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    await once(httpServer, "listening");
    assert.equal(config.logging.trustProxy, true);
    assert.deepEqual(config.proxyTrust, ["loopback"]);
    assert.deepEqual(running.app.get("trust proxy"), ["loopback"]);

    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/forgerelay/debug/authorize?client_id=probe&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcb&response_type=code&code_challenge=x&code_challenge_method=S256`,
      { headers: { "x-forwarded-for": "203.0.113.42" } },
    );

    assert.equal(response.status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/authorize`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/mcp`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/forgerelay/debug/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/relay/healthz`)).status, 200);
    assert.equal(
      (await fetch(
        `http://127.0.0.1:${address.port}/relay/authorize?client_id=probe&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcb&response_type=code&code_challenge=x&code_challenge_method=S256`,
      )).status,
      400,
    );
    const errorText = consoleErrors.flat().map(String).join("\n");
    assert.doesNotMatch(errorText, /ERR_ERL_(?:UNEXPECTED_X_FORWARDED_FOR|PERMISSIVE_TRUST_PROXY)/);
  } finally {
    console.error = originalConsoleError;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
