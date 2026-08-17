import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createProductDebugEnvironment } from "./runtime.mjs";

async function withProductConfig(t) {
  const home = await mkdtemp(join(tmpdir(), "forgerelay-product-debug-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, ".forgerelay");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [home],
    publicBaseUrl: "https://forge.example.test",
  }) + "\n");
  await writeFile(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "product-owner-password-123456",
  }) + "\n");
  return { home, configDir };
}

test("interactive debug inherits product config and Owner password while isolating runtime state", async (t) => {
  const { home, configDir } = await withProductConfig(t);
  const stateDir = resolve(home, "debug-state");
  const worktreeRoot = resolve(home, "debug-worktrees");

  const result = createProductDebugEnvironment({
    env: {},
    home,
    stateDir,
    worktreeRoot,
  });

  assert.equal(result.ownerToken, "product-owner-password-123456");
  assert.equal(result.configDir, configDir);
  assert.equal(result.env.HOST, "127.0.0.1");
  assert.equal(result.env.PORT, "7677");
  assert.equal(result.env.FORGERELAY_CONFIG_DIR, configDir);
  assert.equal(result.env.FORGERELAY_STATE_DIR, stateDir);
  assert.equal(result.env.FORGERELAY_WORKTREE_ROOT, worktreeRoot);

  assert.equal(result.env.FORGERELAY_PUBLIC_BASE_URL, undefined);
  assert.equal(result.env.FORGERELAY_ALLOWED_ROOTS, undefined);
  assert.equal(result.env.FORGERELAY_TOOL_MODE, undefined);
  assert.equal(result.env.FORGERELAY_WIDGETS, undefined);
  assert.equal(result.env.FORGERELAY_OAUTH_OWNER_TOKEN, undefined);
});

test("interactive debug may override only explicit debug settings without replacing product config", async (t) => {
  const { home } = await withProductConfig(t);
  const result = createProductDebugEnvironment({
    env: {
      FORGERELAY_DEBUG_OWNER_TOKEN: "temporary-debug-password-123456",
      FORGERELAY_DEBUG_WIDGETS: "changes",
    },
    home,
  });

  assert.equal(result.ownerToken, "temporary-debug-password-123456");
  assert.equal(result.env.FORGERELAY_OAUTH_OWNER_TOKEN, "temporary-debug-password-123456");
  assert.equal(result.env.FORGERELAY_WIDGETS, "changes");
  assert.equal(result.env.FORGERELAY_PUBLIC_BASE_URL, undefined);
  assert.equal(result.env.FORGERELAY_ALLOWED_ROOTS, undefined);
});
