import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), "forgerelay-system-status-test-"));
try {
  const uninitializedConfigDir = join(root, "uninitialized-config");
  const uninitializedStateDir = join(root, "uninitialized-state");
  const uninitialized = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "system", "status"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: uninitializedConfigDir,
        FORGERELAY_STATE_DIR: uninitializedStateDir,
      },
    },
  );
  assert.equal(uninitialized.status, 0, uninitialized.stderr);
  assert.match(uninitialized.stdout, /Instance: not initialized/);
  assert.match(uninitialized.stdout, /Runtime: not running/);
  assert.match(uninitialized.stdout, new RegExp(`State dir: ${escapeRegExp(uninitializedStateDir)}`));
  assert.equal(existsSync(uninitializedConfigDir), false, "system status must not initialize config/auth state");
  assert.equal(existsSync(uninitializedStateDir), false, "system status must not initialize runtime state");

  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  const authPath = join(configDir, "auth.json");
  const configText = JSON.stringify({
    host: "127.0.0.1",
    port: 7788,
    stateDir,
    publicBaseUrl: "https://forge.example.test/relay",
  }, null, 2) + "\n";
  const authText = JSON.stringify({
    instanceId: "forge-status-test",
    ownerToken: "status-test-owner-token-that-is-long-enough",
  }, null, 2) + "\n";
  writeFileSync(configPath, configText);
  writeFileSync(authPath, authText, { mode: 0o600 });

  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "system", "status"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Instance: forge-status-test/);
  assert.match(result.stdout, /Runtime: not running/);
  assert.match(result.stdout, new RegExp(`State dir: ${escapeRegExp(stateDir)}`));
  assert.match(result.stdout, /Configured bind: 127\.0\.0\.1:7788/);
  assert.match(result.stdout, /Configured public URL: https:\/\/forge\.example\.test\/relay/);
  assert.equal(readFileSync(configPath, "utf8"), configText);
  assert.equal(readFileSync(authPath, "utf8"), authText);
  assert.equal(existsSync(stateDir), false, "system status must not create state for an absent runtime");

  mkdirSync(stateDir, { recursive: true });
  const leasePath = join(stateDir, "forgerelay-runtime.lock");
  const activeLease = JSON.stringify({
    pid: process.pid,
    token: "system-status-active-token-00000000",
    startedAt: "2026-09-17T00:00:00.000Z",
  }) + "\n";
  writeFileSync(leasePath, activeLease, { mode: 0o600 });
  const running = runStatus(configDir);
  assert.equal(running.status, 0, running.stderr);
  assert.match(running.stdout, /Runtime: running/);
  assert.match(running.stdout, new RegExp(`PID: ${process.pid}`));
  assert.equal(readFileSync(leasePath, "utf8"), activeLease);

  const staleLease = JSON.stringify({
    pid: 2_147_483_647,
    token: "system-status-stale-token-00000000",
    startedAt: "2026-09-17T00:00:00.000Z",
  }) + "\n";
  writeFileSync(leasePath, staleLease, { mode: 0o600 });
  const stale = runStatus(configDir);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Runtime: not running \(stale runtime lease present\)/);
  assert.match(stale.stdout, /PID: 2147483647/);
  assert.equal(readFileSync(leasePath, "utf8"), staleLease, "system status must not clean a stale lease");

  const malformedLease = "not-json\n";
  writeFileSync(leasePath, malformedLease, { mode: 0o600 });
  const malformed = runStatus(configDir);
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.match(malformed.stdout, /Runtime: unknown \(malformed runtime lease\)/);
  assert.doesNotMatch(malformed.stdout, /PID:/);
  assert.equal(readFileSync(leasePath, "utf8"), malformedLease, "system status must not mutate a malformed lease");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runStatus(configDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "system", "status"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
