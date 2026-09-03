import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { loadConfig } from "../../../runtime/config/config.js";
import { SingleUserOAuthProvider } from "../../../mcp/oauth/oauth-provider.js";
import { createForgeRelayAuthRouter } from "../../../mcp/oauth/router.js";
import { createServer } from "../../../server.js";

const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("FORGERELAY_") && !name.startsWith("FORGERELAY_")
  ),
) as NodeJS.ProcessEnv;

const ownerToken = "test-owner-token-that-is-long-enough";

void test("forgerelay auth directly authenticates and persists a remote instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-auth-cli-"));
  const localConfigDir = join(root, "local-config");
  const remoteStateDir = join(root, "remote-state");
  await mkdir(localConfigDir, { recursive: true });
  await writeFile(
    join(localConfigDir, "auth.json"),
    JSON.stringify({ ownerToken: "existing-local-owner-token" }),
    { mode: 0o600 },
  );

  const remoteResourceUrl = new URL("https://remote.example.test/mcp");
  const provider = new SingleUserOAuthProvider(
    {
      ownerToken,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
      scopes: ["forgerelay"],
      allowedRedirectHosts: ["chatgpt.com"],
    },
    remoteResourceUrl,
    remoteStateDir,
  );
  t.after(() => provider.close());

  const app = express();
  app.use(createForgeRelayAuthRouter({
    provider,
    cliAuthenticationProvider: provider,
    instanceId: "forge-remote-test",
    issuerUrl: new URL("https://remote.example.test"),
    resourceServerUrl: remoteResourceUrl,
    scopesSupported: ["forgerelay"],
    resourceName: "ForgeRelay",
  } as Parameters<typeof createForgeRelayAuthRouter>[0] & { instanceId: string }));

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const result = await runCli(
    [
      "auth",
      `127.0.0.1:${port}`,
      "--token",
      ownerToken,
      "--alias",
      "workstation",
    ],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: localConfigDir,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const auth = JSON.parse(await readFile(join(localConfigDir, "auth.json"), "utf8")) as {
    instanceId?: string;
    ownerToken?: string;
    remotes?: Record<string, {
      instanceId: string;
      target: string;
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
      scope?: string;
    }>;
  };
  assert.match(auth.instanceId ?? "", /^forge-/);
  assert.equal(auth.ownerToken, "existing-local-owner-token");
  const remote = auth.remotes?.workstation;
  assert.ok(remote);
  assert.equal(remote.instanceId, "forge-remote-test");
  assert.equal(remote.target, `http://127.0.0.1:${port}`);
  assert.notEqual(remote.accessToken, ownerToken);
  assert.ok(remote.refreshToken);
  assert.ok(remote.accessTokenExpiresAt > Math.floor(Date.now() / 1000));
  assert.equal(remote.scope, "forgerelay");

  const verified = await provider.verifyAccessToken(remote.accessToken);
  assert.equal(verified.clientId, "forgerelay-cli");
  assert.equal(verified.resource?.href, remoteResourceUrl.href);

  if (process.platform !== "win32") {
    const interactiveConfigDir = join(root, "interactive-config");
    await mkdir(interactiveConfigDir, { recursive: true });
    const interactive = await runCliWithPseudoTerminal(
      ["auth", `127.0.0.1:${port}`, "--alias", "interactive"],
      {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: interactiveConfigDir,
      },
      ownerToken,
    );
    assert.equal(interactive.status, 0, interactive.output);
    const normalizedTerminalOutput = interactive.output
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\s/g, "");
    assert.match(normalizedTerminalOutput, /RemoteForgeRelayownertoken/);
    assert.doesNotMatch(normalizedTerminalOutput, new RegExp(ownerToken));
    const interactiveAuth = JSON.parse(
      await readFile(join(interactiveConfigDir, "auth.json"), "utf8"),
    ) as { remotes?: Record<string, { instanceId: string }> };
    assert.equal(interactiveAuth.remotes?.interactive?.instanceId, "forge-remote-test");
  }

  const movedServer = app.listen(0, "127.0.0.1");
  t.after(() => movedServer.close());
  await once(movedServer, "listening");
  const movedPort = (movedServer.address() as AddressInfo).port;
  const reauthenticated = await runCli(
    ["auth", `127.0.0.1:${movedPort}`, "--token", ownerToken],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: localConfigDir,
    },
  );
  assert.equal(reauthenticated.status, 0, reauthenticated.stderr || reauthenticated.stdout);
  const authPath = join(localConfigDir, "auth.json");
  const afterReauthentication = JSON.parse(
    await readFile(authPath, "utf8"),
  ) as {
    instanceId?: string;
    remotes?: Record<string, { instanceId: string } & Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(afterReauthentication.remotes ?? {}), ["workstation"]);
  assert.equal(
    (afterReauthentication.remotes?.workstation as { target?: string } | undefined)?.target,
    `http://127.0.0.1:${movedPort}`,
  );

  assert.ok(afterReauthentication.remotes?.workstation);
  afterReauthentication.remotes.workstation.instanceId = "forge-different-instance";
  await writeFile(authPath, JSON.stringify(afterReauthentication, null, 2));
  const conflicting = await runCli(
    ["auth", `127.0.0.1:${port}`, "--token", ownerToken, "--alias", "workstation"],
    {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: localConfigDir,
    },
  );
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /already belongs to another ForgeRelay instance/i);
  t.after(() => rm(root, { recursive: true, force: true }));
});

void test("concurrent remote authentication preserves both remote records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-auth-concurrent-"));
  const localConfigDir = join(root, "local-config");
  await mkdir(localConfigDir, { recursive: true });
  await writeFile(
    join(localConfigDir, "auth.json"),
    JSON.stringify({ ownerToken: "existing-local-owner-token" }),
    { mode: 0o600 },
  );
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const startRemote = async (name: string, instanceId: string) => {
    const provider = new SingleUserOAuthProvider(
      {
        ownerToken,
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
        scopes: ["forgerelay"],
        allowedRedirectHosts: ["chatgpt.com"],
      },
      new URL(`https://${name}.example.test/mcp`),
      join(root, `${name}-state`),
    );
    t.after(() => provider.close());
    const app = express();
    app.use(async (req, _res, next) => {
      if (req.path === "/auth/cli") {
        arrivals += 1;
        if (arrivals === 2) releaseBarrier();
        await barrier;
      }
      next();
    });
    app.use(createForgeRelayAuthRouter({
      provider,
      cliAuthenticationProvider: provider,
      instanceId,
      issuerUrl: new URL(`https://${name}.example.test`),
      resourceServerUrl: new URL(`https://${name}.example.test/mcp`),
      scopesSupported: ["forgerelay"],
      resourceName: "ForgeRelay",
    } as Parameters<typeof createForgeRelayAuthRouter>[0] & { instanceId: string }));
    const server = app.listen(0, "127.0.0.1");
    t.after(() => server.close());
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  };

  const [alphaPort, betaPort] = await Promise.all([
    startRemote("alpha", "forge-concurrent-alpha"),
    startRemote("beta", "forge-concurrent-beta"),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: localConfigDir };
  const [alpha, beta] = await Promise.all([
    runCli(["auth", `127.0.0.1:${alphaPort}`, "--token", ownerToken, "--alias", "alpha"], env),
    runCli(["auth", `127.0.0.1:${betaPort}`, "--token", ownerToken, "--alias", "beta"], env),
  ]);
  assert.equal(alpha.status, 0, alpha.stderr || alpha.stdout);
  assert.equal(beta.status, 0, beta.stderr || beta.stdout);

  const auth = JSON.parse(await readFile(join(localConfigDir, "auth.json"), "utf8")) as {
    ownerToken?: string;
    instanceId?: string;
    remotes?: Record<string, { instanceId?: string }>;
  };
  assert.equal(auth.ownerToken, "existing-local-owner-token");
  assert.match(auth.instanceId ?? "", /^forge-/);
  assert.deepEqual(Object.keys(auth.remotes ?? {}).sort(), ["alpha", "beta"]);
  assert.equal(auth.remotes?.alpha?.instanceId, "forge-concurrent-alpha");
  assert.equal(auth.remotes?.beta?.instanceId, "forge-concurrent-beta");
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

async function runCliWithPseudoTerminal(
  args: string[],
  env: NodeJS.ProcessEnv,
  password: string,
): Promise<{ status: number | null; output: string }> {
  const nodePty = await import("node-pty");
  const ptyEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = nodePty.spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: ptyEnv,
      name: "xterm-256color",
      cols: 80,
      rows: 24,
    },
  );
  let terminalOutput = "";
  let sent = false;
  let passwordTimer: NodeJS.Timeout | undefined;
  const dataDisposable = child.onData((chunk) => {
    terminalOutput += chunk;
    if (!sent && !passwordTimer) {
      passwordTimer = setTimeout(() => {
        sent = true;
        child.write(`${password}\r`);
      }, 200);
    }
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  const status = await new Promise<number | null>((resolve) => {
    child.onExit(({ exitCode }) => resolve(exitCode));
  });
  clearTimeout(timer);
  dataDisposable.dispose();
  if (passwordTimer) clearTimeout(passwordTimer);
  return { status, output: terminalOutput };
}

void test("forgerelay auth management commands do not expose stored secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-auth-manage-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const authPath = join(configDir, "auth.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(
    authPath,
    JSON.stringify({
      instanceId: "forge-local-test",
      remotes: {
        workstation: {
          instanceId: "forge-remote-test",
          target: "http://10.11.12.13:7676",
          accessToken: "access-secret-value",
          refreshToken: "refresh-secret-value",
          accessTokenExpiresAt: 4_102_444_800,
          scope: "forgerelay",
        },
      },
    }, null, 2),
    { mode: 0o600 },
  ));

  const env = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir };
  const listed = await runCli(["auth", "list"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /workstation/);
  assert.match(listed.stdout, /10\.11\.12\.13:7676/);
  assert.match(listed.stdout, /forge-remote-test/);
  assert.doesNotMatch(listed.stdout, /access-secret-value|refresh-secret-value/);

  const renamed = await runCli(["auth", "rename", "workstation", "desktop"], env);
  assert.equal(renamed.status, 0, renamed.stderr);
  const afterRename = JSON.parse(await readFile(authPath, "utf8")) as {
    remotes?: Record<string, unknown>;
  };
  assert.equal(afterRename.remotes?.workstation, undefined);
  assert.ok(afterRename.remotes?.desktop);

  const removed = await runCli(["auth", "remove", "desktop"], env);
  assert.equal(removed.status, 0, removed.stderr);
  const afterRemove = JSON.parse(await readFile(authPath, "utf8")) as {
    remotes?: Record<string, unknown>;
  };
  assert.deepEqual(afterRemove.remotes, {});
});

void test("forgerelay auth fails before network access when a non-interactive caller omits the owner token", async () => {
  const result = await runCli(
    ["auth", "127.0.0.1:1", "--alias", "unreachable"],
    cleanProductEnv,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner token/i);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/i);
});


void test("forgerelay auth test persists rotated credentials before MCP verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-auth-refresh-persist-"));
  const localConfigDir = join(root, "local-config");
  const remoteStateDir = join(root, "remote-state");
  await mkdir(localConfigDir, { recursive: true });

  const remoteResourceUrl = new URL("https://remote.example.test/mcp");
  const provider = new SingleUserOAuthProvider(
    {
      ownerToken,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
      scopes: ["forgerelay"],
      allowedRedirectHosts: ["chatgpt.com"],
    },
    remoteResourceUrl,
    remoteStateDir,
  );
  t.after(() => provider.close());

  const app = express();
  app.use(createForgeRelayAuthRouter({
    provider,
    cliAuthenticationProvider: provider,
    instanceId: "forge-refresh-persist-test",
    issuerUrl: new URL("https://remote.example.test"),
    resourceServerUrl: remoteResourceUrl,
    scopesSupported: ["forgerelay"],
    resourceName: "ForgeRelay",
  } as Parameters<typeof createForgeRelayAuthRouter>[0] & { instanceId: string }));
  app.all("/mcp", (_req, res) => res.status(503).json({ error: "offline" }));

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const localEnv = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: localConfigDir };
  const authenticated = await runCli(
    ["auth", `127.0.0.1:${port}`, "--token", ownerToken, "--alias", "workstation"],
    localEnv,
  );
  assert.equal(authenticated.status, 0, authenticated.stderr || authenticated.stdout);

  const authPath = join(localConfigDir, "auth.json");
  const before = JSON.parse(await readFile(authPath, "utf8")) as {
    remotes: Record<string, {
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
    }>;
  };
  const oldRefreshToken = before.remotes.workstation.refreshToken;
  before.remotes.workstation.accessToken = "expired-access-token";
  before.remotes.workstation.accessTokenExpiresAt = 0;
  await writeFile(authPath, JSON.stringify(before, null, 2));

  const checked = await runCli(["auth", "test", "workstation"], localEnv);
  assert.equal(checked.status, 1);

  const after = JSON.parse(await readFile(authPath, "utf8")) as typeof before;
  assert.notEqual(after.remotes.workstation.accessToken, "expired-access-token");
  assert.notEqual(after.remotes.workstation.refreshToken, oldRefreshToken);
});

void test("forgerelay auth test refreshes an expired access token and verifies MCP connectivity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-remote-auth-test-"));
  const remoteConfigDir = join(root, "remote-config");
  const remoteStateDir = join(root, "remote-state");
  const remoteWorkspace = join(root, "remote-workspace");
  const localConfigDir = join(root, "local-config");
  await mkdir(remoteConfigDir, { recursive: true });
  await mkdir(remoteWorkspace, { recursive: true });
  await mkdir(localConfigDir, { recursive: true });

  await writeFile(join(remoteConfigDir, "config.json"), JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [remoteWorkspace],
    publicBaseUrl: "http://127.0.0.1:7676",
    stateDir: remoteStateDir,
  }));
  await writeFile(join(remoteConfigDir, "auth.json"), JSON.stringify({
    ownerToken,
    instanceId: "forge-remote-live-test",
  }));

  const remoteEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: remoteConfigDir,
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
  const running = createServer(loadConfig(remoteEnv));
  const httpServer = running.app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { port } = httpServer.address() as AddressInfo;
  const target = `127.0.0.1:${port}`;
  const localEnv = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: localConfigDir };

  const authenticated = await runCli(
    ["auth", target, "--token", ownerToken, "--alias", "workstation"],
    localEnv,
  );
  assert.equal(authenticated.status, 0, authenticated.stderr || authenticated.stdout);

  const authPath = join(localConfigDir, "auth.json");
  const before = JSON.parse(await readFile(authPath, "utf8")) as {
    remotes: Record<string, {
      instanceId: string;
      target: string;
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
      scope?: string;
    }>;
  };
  const oldRefreshToken = before.remotes.workstation.refreshToken;
  before.remotes.workstation.accessToken = "expired-access-token";
  before.remotes.workstation.accessTokenExpiresAt = 0;
  await writeFile(authPath, JSON.stringify(before, null, 2));

  const checked = await runCli(["auth", "test", "workstation"], localEnv);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /workstation.*ok/i);

  const after = JSON.parse(await readFile(authPath, "utf8")) as typeof before;
  assert.notEqual(after.remotes.workstation.accessToken, "expired-access-token");
  assert.notEqual(after.remotes.workstation.refreshToken, oldRefreshToken);
  assert.equal(after.remotes.workstation.instanceId, "forge-remote-live-test");
});
