import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("FORGERELAY_") && !name.startsWith("DEVSPACE_")
  ),
) as NodeJS.ProcessEnv;

const ownerToken = "ssh-owner-token-that-must-stay-secret";
const sshProcessTest = process.platform === "win32" ? test.skip : test;

void sshProcessTest("forgerelay auth uses an SSH route for token retrieval and port forwarding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-ssh-auth-"));
  const configDir = join(root, "config");
  const remoteConfigDir = join(root, "remote-config");
  const remoteStateDir = join(root, "remote-state");
  const remoteWorkspace = join(root, "remote-workspace");
  const fakeBin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  await mkdir(configDir, { recursive: true });
  await mkdir(remoteConfigDir, { recursive: true });
  await mkdir(remoteWorkspace, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(remoteConfigDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [remoteWorkspace],
    publicBaseUrl: "http://127.0.0.1:7676",
    stateDir: remoteStateDir,
  }));
  await writeFile(join(remoteConfigDir, "auth.json"), JSON.stringify({
    ownerToken,
    instanceId: "forge-ssh-remote-test",
  }), { mode: 0o600 });
  const remoteEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: remoteConfigDir,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
  const running = createServer(loadConfig(remoteEnv));
  const server = running.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
  });
  const remotePort = (server.address() as AddressInfo).port;

  const fakeSshPath = join(fakeBin, "ssh");
  await writeFile(fakeSshPath, fakeSshSource(), { mode: 0o755 });
  await chmod(fakeSshPath, 0o755);

  const result = await runCli(
    [
      "auth",
      "-J",
      "jump@example.test,target@example.test",
      `remote-only.invalid:${remotePort}`,
      "--ssh-auth",
      "--alias",
      "workstation",
    ],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TEST_SSH_LOG: sshLog,
      TEST_REMOTE_OWNER_TOKEN: ownerToken,
      TEST_REMOTE_SERVICE_PORT: String(remotePort),
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(ownerToken));

  const authText = await readFile(join(configDir, "auth.json"), "utf8");
  assert.doesNotMatch(authText, new RegExp(ownerToken));
  const auth = JSON.parse(authText) as {
    remotes?: Record<string, {
      instanceId: string;
      target: string;
      sshRoute?: string[];
      accessToken: string;
    }>;
  };
  const remote = auth.remotes?.workstation;
  assert.ok(remote);
  assert.equal(remote.instanceId, "forge-ssh-remote-test");
  assert.equal(remote.target, `http://remote-only.invalid:${remotePort}`);
  assert.deepEqual(remote.sshRoute, ["jump@example.test", "target@example.test"]);
  assert.doesNotMatch(authText, /localPort|127\.0\.0\.1:\d+.*remote-only\.invalid/);
  assert.ok(remote.accessToken);

  const invocations = (await readFile(sshLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(invocations.length, 2);

  const tokenInvocation = invocations.find((args) => args.includes("__owner-token"));
  assert.ok(tokenInvocation);
  assert.deepEqual(tokenInvocation.slice(0, 2), ["-J", "jump@example.test"]);
  assert.ok(tokenInvocation.includes("target@example.test"));
  assert.doesNotMatch(JSON.stringify(tokenInvocation), new RegExp(ownerToken));

  const tunnelInvocation = invocations.find((args) => args.includes("-L"));
  assert.ok(tunnelInvocation);
  assert.deepEqual(tunnelInvocation.slice(0, 2), ["-J", "jump@example.test"]);
  assert.ok(tunnelInvocation.includes("target@example.test"));
  const forward = tunnelInvocation[tunnelInvocation.indexOf("-L") + 1];
  assert.match(forward, new RegExp(`^127\\.0\\.0\\.1:(\\d+):remote-only\\.invalid:${remotePort}$`));
  const localPort = Number(forward.match(/^127\.0\.0\.1:(\d+):/)?.[1]);
  assert.ok(Number.isInteger(localPort) && localPort >= 1024 && localPort <= 65535);

  await writeFile(sshLog, "");
  const checked = await runCli(
    ["auth", "test", "workstation"],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TEST_SSH_LOG: sshLog,
      TEST_REMOTE_OWNER_TOKEN: ownerToken,
      TEST_REMOTE_SERVICE_PORT: String(remotePort),
    },
  );
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /workstation\s+ok\s+forge-ssh-remote-test/i);
  const testInvocations = (await readFile(sshLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(testInvocations.length, 1);
  assert.ok(testInvocations[0].includes("-L"));
  assert.doesNotMatch(JSON.stringify(testInvocations), new RegExp(ownerToken));
});

void sshProcessTest("SSH auth parameter constraints fail before any SSH process starts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-ssh-args-"));
  const configDir = join(root, "config");
  const fakeBin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeSshPath = join(fakeBin, "ssh");
  await writeFile(fakeSshPath, fakeSshSource(), { mode: 0o755 });
  await chmod(fakeSshPath, 0o755);
  const env = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    TEST_SSH_LOG: sshLog,
    TEST_REMOTE_OWNER_TOKEN: ownerToken,
    TEST_REMOTE_SERVICE_PORT: "1",
  };

  const missingRoute = await runCli(
    ["auth", "127.0.0.1:7676", "--ssh-auth"],
    env,
  );
  assert.equal(missingRoute.status, 1);
  assert.match(missingRoute.stderr, /--ssh-auth requires -J/i);

  const conflictingCredential = await runCli(
    [
      "auth",
      "-J",
      "target@example.test",
      "127.0.0.1:7676",
      "--ssh-auth",
      "--token",
      "explicit-secret",
    ],
    env,
  );
  assert.equal(conflictingCredential.status, 1);
  assert.match(conflictingCredential.stderr, /cannot be used together/i);
  await assert.rejects(readFile(sshLog, "utf8"), /ENOENT/);
});

void sshProcessTest("a single SSH target does not synthesize ProxyJump arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-ssh-single-"));
  const configDir = join(root, "config");
  const remoteConfigDir = join(root, "remote-config");
  const remoteStateDir = join(root, "remote-state");
  const remoteWorkspace = join(root, "remote-workspace");
  const fakeBin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  await mkdir(configDir, { recursive: true });
  await mkdir(remoteConfigDir, { recursive: true });
  await mkdir(remoteWorkspace, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(remoteConfigDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [remoteWorkspace],
    publicBaseUrl: "http://127.0.0.1:7676",
    stateDir: remoteStateDir,
  }));
  await writeFile(join(remoteConfigDir, "auth.json"), JSON.stringify({
    ownerToken,
    instanceId: "forge-ssh-single-test",
  }), { mode: 0o600 });
  const remoteEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: remoteConfigDir,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
  const running = createServer(loadConfig(remoteEnv));
  const server = running.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
  });
  const remotePort = (server.address() as AddressInfo).port;

  const fakeSshPath = join(fakeBin, "ssh");
  await writeFile(fakeSshPath, fakeSshSource(), { mode: 0o755 });
  await chmod(fakeSshPath, 0o755);
  const result = await runCli(
    [
      "auth",
      "-J",
      "target@example.test",
      `remote-only.invalid:${remotePort}`,
      "--ssh-auth",
      "--alias",
      "single",
    ],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TEST_SSH_LOG: sshLog,
      TEST_REMOTE_OWNER_TOKEN: ownerToken,
      TEST_REMOTE_SERVICE_PORT: String(remotePort),
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const invocations = (await readFile(sshLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(invocations.length, 2);
  for (const args of invocations) {
    assert.equal(args.includes("-J"), false);
    assert.ok(args.includes("target@example.test"));
  }
});

void sshProcessTest("direct auth never starts SSH when -J is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-no-ssh-"));
  const configDir = join(root, "config");
  const fakeBin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeSshPath = join(fakeBin, "ssh");
  await writeFile(fakeSshPath, fakeSshSource(), { mode: 0o755 });
  await chmod(fakeSshPath, 0o755);
  const result = await runCli(
    ["auth", "127.0.0.1:1", "--token", "direct-owner-token"],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TEST_SSH_LOG: sshLog,
      TEST_REMOTE_OWNER_TOKEN: ownerToken,
      TEST_REMOTE_SERVICE_PORT: "1",
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /SSH command|SSH tunnel/i);
  await assert.rejects(readFile(sshLog, "utf8"), /ENOENT/);
});

void sshProcessTest("SSH command and tunnel failures are explicit and never fall back to direct access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-ssh-failure-"));
  const configDir = join(root, "config");
  const fakeBin = join(root, "bin");
  const sshLog = join(root, "ssh.log");
  await mkdir(configDir, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const fakeSshPath = join(fakeBin, "ssh");
  await writeFile(fakeSshPath, fakeSshSource(), { mode: 0o755 });
  await chmod(fakeSshPath, 0o755);
  const baseEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    TEST_SSH_LOG: sshLog,
    TEST_REMOTE_OWNER_TOKEN: ownerToken,
    TEST_REMOTE_SERVICE_PORT: "1",
  };

  const tokenFailure = await runCli(
    ["auth", "-J", "target@example.test", "remote-only.invalid:7676", "--ssh-auth"],
    { ...baseEnv, TEST_SSH_FAIL_OWNER_TOKEN: "1" },
  );
  assert.equal(tokenFailure.status, 1);
  assert.match(tokenFailure.stderr, /SSH command failed.*simulated owner-token failure/i);
  assert.doesNotMatch(tokenFailure.stderr, /fetch failed/i);

  await writeFile(sshLog, "");
  const tunnelFailure = await runCli(
    [
      "auth",
      "-J",
      "target@example.test",
      "remote-only.invalid:7676",
      "--token",
      "explicit-owner-token",
    ],
    { ...baseEnv, TEST_SSH_FAIL_TUNNEL: "1" },
  );
  assert.equal(tunnelFailure.status, 1);
  assert.match(tunnelFailure.stderr, /SSH tunnel exited before forwarding was ready.*simulated tunnel failure/i);
  assert.doesNotMatch(tunnelFailure.stderr, /fetch failed/i);

  await writeFile(sshLog, "");
  const serviceFailure = await runCli(
    [
      "auth",
      "-J",
      "target@example.test",
      "remote-only.invalid:7676",
      "--token",
      "explicit-owner-token",
    ],
    baseEnv,
  );
  assert.equal(serviceFailure.status, 1);
  assert.match(serviceFailure.stderr, /Remote service request through SSH tunnel failed: fetch failed/i);

  await writeFile(sshLog, "");
  const httpsRejected = await runCli(
    [
      "auth",
      "-J",
      "target@example.test",
      "https://remote-only.invalid:7676",
      "--token",
      "explicit-owner-token",
    ],
    baseEnv,
  );
  assert.equal(httpsRejected.status, 1);
  assert.match(httpsRejected.stderr, /SSH-routed HTTPS service targets are not supported/i);
  assert.equal((await readFile(sshLog, "utf8")).trim(), "");
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const [status] = await once(child, "close") as [number | null];
  return { status, stdout, stderr };
}

function fakeSshSource(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_SSH_LOG, JSON.stringify(args) + "\\n");
if (args.includes("__owner-token")) {
  if (process.env.TEST_SSH_FAIL_OWNER_TOKEN === "1") {
    process.stderr.write("simulated owner-token failure\\n");
    process.exit(41);
  }
  process.stdout.write(process.env.TEST_REMOTE_OWNER_TOKEN + "\\n");
  process.exit(0);
}
if (process.env.TEST_SSH_FAIL_TUNNEL === "1") {
  process.stderr.write("simulated tunnel failure\\n");
  process.exit(42);
}
const forwardIndex = args.indexOf("-L");
if (forwardIndex < 0) {
  process.stderr.write("fake ssh: missing -L or owner-token command\\n");
  process.exit(23);
}
const forward = args[forwardIndex + 1];
const match = /^127\\.0\\.0\\.1:(\\d+):(.+):(\\d+)$/.exec(forward);
if (!match) {
  process.stderr.write("fake ssh: invalid forward " + forward + "\\n");
  process.exit(24);
}
const localPort = Number(match[1]);
const servicePort = Number(process.env.TEST_REMOTE_SERVICE_PORT);
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  const upstream = net.connect(servicePort, "127.0.0.1");
  socket.pipe(upstream);
  upstream.pipe(socket);
  const close = () => {
    sockets.delete(socket);
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", close);
  socket.on("close", close);
  upstream.on("error", close);
  upstream.on("close", close);
});
server.on("error", (error) => {
  process.stderr.write(String(error) + "\\n");
  process.exit(25);
});
server.listen(localPort, "127.0.0.1", () => {
  process.stderr.write("debug1: Local forwarding listening on 127.0.0.1 port " + localPort + ".\\n");
});
const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}
