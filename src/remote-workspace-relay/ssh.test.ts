import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authenticateRemote, withRemoteMcpClient } from "../remote-auth.js";
import {
  installFakeSsh,
  resultText,
  setupGitRepository,
  startForge,
  startGatewayClient,
  structuredContent,
} from "./test-support.js";

void test("ssh-routed relayed workspace rebuilds fresh tunnels across gateway instances", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-ssh-restart-"));

  const sshLog = join(root, "ssh.log");
  await installFakeSsh(t, root, sshLog);

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  const gatewayStateDir = join(root, "gateway", "state");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "ssh-restart.txt"), "ssh-route-survived\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  remoteRecord.sshRoute = ["jump@example.test", "target@example.test"];
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const firstClient = await startGatewayClient(t, {
    root: join(root, "gateway-first"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const opened = await firstClient.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.match(workspaceId, /^rws_/);

  const firstRead = await firstClient.callTool({
    name: "read",
    arguments: { workspaceId, path: "ssh-restart.txt" },
  });
  assert.equal(firstRead.isError, undefined, resultText(firstRead));
  const routeStateText = await readFile(
    join(gatewayStateDir, "remote-workspace-routes.json"),
    "utf8",
  );
  assert.match(routeStateText, new RegExp(remoteRecord.instanceId));
  assert.doesNotMatch(routeStateText, /workstation|jump@example\.test|target@example\.test/);
  assert.doesNotMatch(routeStateText, new RegExp(remote.endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-ssh-restart-owner-token-long-enough",
    instanceId: "forge-relay-ssh-restart-gateway",
    remotes: { renamed: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const restartedClient = await startGatewayClient(t, {
    root: join(root, "gateway-second"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
    stateDir: gatewayStateDir,
  });
  const restartedRead = await restartedClient.callTool({
    name: "read",
    arguments: { workspaceId, path: "ssh-restart.txt" },
  });
  assert.equal(restartedRead.isError, undefined, resultText(restartedRead));
  assert.match(resultText(restartedRead), /ssh-route-survived/);

  const sshCalls = (await readFile(sshLog, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const forwardPorts = sshCalls.flatMap((args) => {
    const index = args.indexOf("-L");
    if (index < 0 || !args[index + 1]) return [];
    const match = /^127\.0\.0\.1:(\d+):/.exec(args[index + 1]!);
    return match ? [Number(match[1])] : [];
  });
  assert.equal(forwardPorts.length, 2, JSON.stringify(sshCalls));
  assert.equal(new Set(forwardPorts).size, forwardPorts.length);
  assert.ok(sshCalls.every((args) => args.includes("jump@example.test") && args.includes("target@example.test")));

  const closed = await restartedClient.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));
  t.after(() => rm(root, { recursive: true, force: true }));
});
void test("single-target SSH relay executes a remote workspace without ProxyJump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-ssh-single-"));

  const sshLog = join(root, "ssh.log");
  await installFakeSsh(t, root, sshLog);

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(remoteRoot, "single-ssh.txt"), "single-target-ssh-workspace\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-single-ssh-owner-token-long-enough",
    instanceId: "forge-relay-single-ssh-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  remoteRecord.sshRoute = ["target@example.test"];
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-single-ssh-owner-token-long-enough",
    instanceId: "forge-relay-single-ssh-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });

  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });
  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const workspaceId = String(structuredContent(opened).workspaceId);

  const read = await client.callTool({
    name: "read",
    arguments: { workspaceId, path: "single-ssh.txt" },
  });
  assert.equal(read.isError, undefined, resultText(read));
  assert.match(resultText(read), /single-target-ssh-workspace/);

  const closed = await client.callTool({ name: "close_workspace", arguments: { workspaceId } });
  assert.equal(closed.isError, undefined, resultText(closed));

  const sshCalls = (await readFile(sshLog, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const forwardCalls = sshCalls.filter((args) => args.includes("-L"));
  assert.equal(forwardCalls.length, 1, JSON.stringify(sshCalls));
  assert.ok(forwardCalls.every((args) => args.includes("target@example.test")));
  assert.ok(forwardCalls.every((args) => !args.includes("-J")), JSON.stringify(sshCalls));
  t.after(() => rm(root, { recursive: true, force: true }));
});
void test("relayed open failures are explicit and never fall back to the gateway filesystem", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-errors-"));

  const gatewayRoot = join(root, "gateway-root");
  const remoteRoot = join(root, "remote-root");
  const rejectedRoot = join(root, "remote-rejected");
  await mkdir(gatewayRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(rejectedRoot, { recursive: true });
  await writeFile(join(gatewayRoot, "sentinel.txt"), "gateway-fallback-must-not-run\n");

  const remote = await startForge(t, {
    root: join(root, "remote"),
    allowedRoot: remoteRoot,
    ownerToken: "remote-error-owner-token-long-enough",
    instanceId: "forge-relay-error-remote",
  });
  const validRemote = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-error-owner-token-long-enough",
    instanceId: "forge-relay-error-gateway",
    remotes: {
      workstation: {
        ...validRemote,
        accessToken: "invalid-access-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      "bad-auth": {
        ...validRemote,
        instanceId: "forge-bad-auth-record",
        accessToken: "invalid-access-token",
        refreshToken: "invalid-refresh-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      offline: {
        instanceId: "forge-offline-test",
        target: "http://127.0.0.1:9",
        accessToken: "offline-access-token",
        refreshToken: "offline-refresh-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "forgerelay",
      },
    },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });

  const unknown = await client.callTool({
    name: "open_workspace",
    arguments: { path: gatewayRoot, relay: "missing", context: "none" },
  });
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /unknown remote relay alias: missing/i);

  const rejected = await client.callTool({
    name: "open_workspace",
    arguments: { path: rejectedRoot, relay: "workstation", context: "none" },
  });
  assert.equal(rejected.isError, true);
  assert.match(resultText(rejected), /remote forgerelay workstation open_workspace failed/i);
  assert.match(resultText(rejected), /outside allowed roots/i);
  assert.doesNotMatch(resultText(rejected), /gateway-fallback-must-not-run/);

  const badAuth = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "bad-auth", context: "none" },
  });
  assert.equal(badAuth.isError, true);
  assert.match(resultText(badAuth), /authentication|unauthorized|invalid|remote forgerelay/i);

  const offline = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRoot, relay: "offline", context: "none" },
  });
  assert.equal(offline.isError, true);
  assert.match(resultText(offline), /remote forgerelay offline request failed/i);
  assert.doesNotMatch(resultText(offline), /gateway-fallback-must-not-run/);
  t.after(() => rm(root, { recursive: true, force: true }));
});
