import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createInteractiveDebugEnvironment,
  interactiveDebugConfigDir,
  interactiveDebugUrls,
} from "./runtime.mjs";

async function withDebugConfig(t) {
  const home = await mkdtemp(join(tmpdir(), "forgerelay-interactive-debug-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, ".forgerelay", "debug");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7677,
    allowedRoots: [home],
    allowedHosts: ["localhost", "127.0.0.1", "::1", "debug.example.test"],
    publicBaseUrl: "https://debug.example.test/forgerelay/debug",
  }) + "\n");
  await writeFile(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "debug-owner-password-123456",
  }) + "\n");
  return { home, configDir };
}

test("interactive debug uses one dedicated persisted config under ~/.forgerelay/debug", async (t) => {
  const { home, configDir } = await withDebugConfig(t);
  const result = createInteractiveDebugEnvironment({
    env: {
      HOST: "0.0.0.0",
      PORT: "9999",
      FORGERELAY_CONFIG_DIR: "/wrong/product/config",
      FORGERELAY_PUBLIC_BASE_URL: "https://wrong.example.test",
      FORGERELAY_ALLOWED_HOSTS: "wrong.example.test",
      FORGERELAY_OAUTH_OWNER_TOKEN: "wrong-owner-password-123456",
      FORGERELAY_WIDGETS: "off",
      DEVSPACE_ALLOWED_ROOTS: "/wrong/root",
      FORGERELAY_LOG_LEVEL: "debug",
    },
    home,
  });

  assert.equal(interactiveDebugConfigDir({ env: {}, home }), configDir);
  assert.equal(result.ownerToken, "debug-owner-password-123456");
  assert.equal(result.configDir, configDir);
  assert.equal(result.env.FORGERELAY_CONFIG_DIR, configDir);
  assert.equal(result.baseUrl, "http://127.0.0.1:7677");
  assert.equal(result.mcpUrl, "http://127.0.0.1:7677/mcp");
  assert.deepEqual(interactiveDebugUrls(configDir), {
    baseUrl: "http://127.0.0.1:7677",
    mcpUrl: "http://127.0.0.1:7677/mcp",
  });
  assert.equal(result.env.HOST, undefined);
  assert.equal(result.env.PORT, undefined);
  assert.equal(result.env.FORGERELAY_PUBLIC_BASE_URL, undefined);
  assert.equal(result.env.FORGERELAY_ALLOWED_ROOTS, undefined);
  assert.equal(result.env.FORGERELAY_ALLOWED_HOSTS, undefined);
  assert.equal(result.env.FORGERELAY_OAUTH_OWNER_TOKEN, undefined);
  assert.equal(result.env.FORGERELAY_WIDGETS, undefined);
  assert.equal(result.env.DEVSPACE_ALLOWED_ROOTS, undefined);
  assert.equal(result.env.FORGERELAY_LOG_LEVEL, "debug");
});

test("interactive debug config directory may be explicitly relocated without falling back to product config", async (t) => {
  const { home } = await withDebugConfig(t);
  const customDir = join(home, "custom-debug-config");
  await mkdir(customDir, { recursive: true });
  await writeFile(join(customDir, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 6768 }) + "\n");
  await writeFile(join(customDir, "auth.json"), JSON.stringify({ ownerToken: "custom-debug-password-123456" }) + "\n");

  const result = createInteractiveDebugEnvironment({
    env: { FORGERELAY_DEBUG_CONFIG_DIR: customDir },
    home,
  });

  assert.equal(result.configDir, customDir);
  assert.equal(result.ownerToken, "custom-debug-password-123456");
  assert.equal(result.env.FORGERELAY_CONFIG_DIR, customDir);
  assert.equal(result.baseUrl, "http://127.0.0.1:6768");
  assert.equal(result.mcpUrl, "http://127.0.0.1:6768/mcp");
});
