#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pty from "node-pty";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Config v2 packaged acceptance must run through npm so npm_execpath is available");
}

const repoRoot = process.cwd();
const root = await mkdtemp(join(tmpdir(), "forgerelay-config-v2-product-"));

try {
  const artifactDir = join(root, "artifact");
  const prefix = join(root, "prefix");
  const home = join(root, "home");
  await Promise.all([
    mkdir(artifactDir, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  const tarball = packProduct(artifactDir);
  installProduct(prefix, tarball);
  const installedRoot = join(prefix, "node_modules", "@akira-tl", "forgerelay");
  const installedCli = join(installedRoot, "dist", "cli.js");
  assert.ok(existsSync(installedCli), `installed package is missing dist/cli.js: ${installedRoot}`);
  assert.ok(existsSync(join(installedRoot, "schemas", "v1", "config.user.schema.json")));
  assert.ok(existsSync(join(installedRoot, "templates", "instructions", "cmd.md")));
  assert.ok(existsSync(join(installedRoot, "capabilities", "lifecycle-hooks", "GUIDE.md")));

  const probePath = join(root, "config-v2-installed-probe.mjs");
  await writeFile(probePath, installedProbeSource(), "utf8");

  await acceptFreshInit({ installedCli, root, home });
  await acceptLegacyUpgradeAndMigration({ installedRoot, installedCli, probePath, root, home });
  await acceptRuntimeSemantics({ installedRoot, probePath, root, home });
  await acceptPackagedServe({ installedCli, root, home });

  console.log(
    `Config v2 packaged product acceptance passed on ${process.platform}/${process.arch}: fresh init, direct upgrade, diagnostics, migration equivalence, reload/LKG, Project Local, trust seam, and serve:7678.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function packProduct(artifactDir) {
  const result = runNpm(["pack", "--json", "--pack-destination", artifactDir], repoRoot, process.env, 120_000);
  const report = JSON.parse(result.stdout);
  const filename = report?.[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a package filename: ${result.stdout}`);
  const tarball = join(artifactDir, filename);
  assert.ok(existsSync(tarball), `packed artifact is missing: ${tarball}`);
  return tarball;
}

function installProduct(prefix, tarball) {
  runNpm(
    ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", tarball],
    repoRoot,
    process.env,
    180_000,
  );
}

async function acceptFreshInit({ installedCli, root, home }) {
  const projectRoot = join(root, "fresh-project");
  const configDir = join(root, "fresh-config");
  const stateDir = join(root, "fresh-state");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "fresh packaged config acceptance\n", "utf8");

  const env = acceptanceEnv({ configDir, home, stateDir });
  const child = pty.spawn(process.execPath, [installedCli, "init"], {
    name: "xterm-256color",
    cols: 110,
    rows: 40,
    cwd: projectRoot,
    env: stringEnvironment(env),
  });

  let output = "";
  let rootsAnswered = false;
  let modeAnswered = false;
  child.onData((data) => {
    output += data;
    if (!rootsAnswered && output.includes("Where are your projects located?")) {
      rootsAnswered = true;
      child.write("\r");
      return;
    }
    if (rootsAnswered && !modeAnswered && output.includes("How should clients reach this ForgeRelay instance?")) {
      modeAnswered = true;
      child.write("\r");
    }
  });

  const exitCode = await waitForPtyExit(child, 20_000);
  assert.equal(exitCode, 0, scrubTerminal(output));
  assert.equal(rootsAnswered, true, "packaged init did not ask for project roots");
  assert.equal(modeAnswered, true, "packaged init did not ask for connection mode");
  for (const unexpected of [
    "Which local port should ForgeRelay use?",
    "Which command shell should Agent commands and Hooks use?",
    "Runtime Shell Instructions for this command shell?",
    "Which Language Servers should ForgeRelay manage with npm?",
  ]) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(unexpected)));
  }

  const config = await readJson(join(configDir, "config.json"));
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "allowedRoots"]);
  assert.deepEqual(config.allowedRoots, [projectRoot]);
  assert.match(String(config.$schema), /schemas\/v1\/config\.user\.schema\.json$/);
  const auth = await readJson(join(configDir, "auth.json"));
  assert.equal(typeof auth.ownerToken, "string");
  assert.ok(auth.ownerToken.length >= 20);
  assert.match(output, /OAuth mode: Owner-password approval/);
  assert.match(output, /Client-facing MCP URL/);
  assert.match(output, /Run `forgerelay serve` to start the MCP server\./);

  const check = runInstalledCli(installedCli, ["config", "check", "--global", "--json"], env);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(JSON.parse(check.stdout).summary.errors, 0);
}

async function acceptLegacyUpgradeAndMigration({ installedRoot, installedCli, probePath, root, home }) {
  const configDir = join(root, "legacy-config");
  const projectRoot = join(root, "legacy-project");
  const stateDir = join(root, "legacy-state");
  await Promise.all([
    mkdir(join(configDir, "agents"), { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await writeFile(join(projectRoot, "README.md"), "legacy direct-upgrade acceptance\n", "utf8");
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      allowedRoots: [projectRoot],
      mcpServers: {
        legacy: {
          transport: "stdio",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
      languageServers: {
        custom: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          extensions: [".legacy"],
        },
      },
      hooks: {
        BeforeTool: [{
          name: "guard",
          matcher: { tool: "read" },
          command: "echo packaged-legacy-hook",
          report: true,
        }],
      },
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "description: Packaged legacy reviewer",
      "provider: codex",
      "---",
      "Review packaged migration behavior.",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = acceptanceEnv({ configDir, home, stateDir });
  const check = runInstalledCli(installedCli, ["config", "check", "--global", "--json"], env);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const checkJson = JSON.parse(check.stdout);
  assert.equal(checkJson.summary.errors, 0);
  assert.ok(checkJson.diagnostics.some((entry) => entry.code === "deprecated_source"));
  const untouched = await readJson(join(configDir, "config.json"));
  assert.ok(untouched.mcpServers, "direct upgrade check must not mutate legacy config");
  assert.ok(untouched.languageServers, "direct upgrade check must not mutate legacy config");
  assert.ok(untouched.hooks, "direct upgrade check must not mutate legacy config");

  const sources = runInstalledCli(installedCli, ["config", "sources", "--global", "--json"], env);
  assert.equal(sources.status, 0, sources.stderr || sources.stdout);
  const sourceJson = JSON.parse(sources.stdout);
  assert.ok(sourceJson.sources.some((entry) => entry.id === "legacy:user:mcpServers"));
  assert.ok(sourceJson.sources.some((entry) => entry.id === "legacy:user:languageServers"));
  assert.ok(sourceJson.sources.some((entry) => entry.id === "legacy:user:config-hooks"));

  const explain = runInstalledCli(
    installedCli,
    ["config", "explain", "mcp.servers.legacy", "--global", "--json"],
    env,
  );
  assert.equal(explain.status, 0, explain.stderr || explain.stdout);
  const explainJson = JSON.parse(explain.stdout);
  assert.equal(explainJson.effective.source.id, "legacy:user:mcpServers");
  assert.equal(explainJson.effective.executionEffect, "process");

  const dryRun = runInstalledCli(installedCli, ["config", "migrate", "--dry-run", "--global"], env);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.match(dryRun.stdout, /DRY RUN/i);
  assert.equal(existsSync(join(configDir, "mcp.json")), false);

  const before = runInstalledProbe({
    installedRoot,
    probePath,
    mode: "snapshot",
    configDir,
    projectRoot,
    outputPath: join(root, "legacy-before.json"),
    env,
  });

  const migration = runInstalledCli(installedCli, ["config", "migrate", "--global"], env);
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  assert.match(migration.stdout, /Migration complete/i);
  assert.ok(existsSync(join(configDir, "mcp.json")));
  assert.ok(existsSync(join(configDir, "language-servers.json")));
  assert.ok(existsSync(join(configDir, "hooks", "guard.json")));
  assert.ok(existsSync(join(configDir, "subagents", "reviewer.md")));
  const migrated = await readJson(join(configDir, "config.json"));
  assert.equal("mcpServers" in migrated, false);
  assert.equal("languageServers" in migrated, false);
  assert.equal("hooks" in migrated, false);
  const backupEntries = await readdir(join(configDir, "migration-backups"));
  assert.equal(backupEntries.length, 1);

  const after = runInstalledProbe({
    installedRoot,
    probePath,
    mode: "snapshot",
    configDir,
    projectRoot,
    outputPath: join(root, "legacy-after.json"),
    env,
  });
  assert.deepEqual(after, before, "explicit migration changed effective Config v2 behavior");
}

async function acceptRuntimeSemantics({ installedRoot, probePath, root, home }) {
  const configDir = join(root, "runtime-config");
  const projectRoot = join(root, "runtime-project");
  const stateDir = join(root, "runtime-state");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  const env = acceptanceEnv({ configDir, home, stateDir });
  const result = runInstalledProbe({
    installedRoot,
    probePath,
    mode: "runtime",
    configDir,
    projectRoot,
    outputPath: join(root, "runtime-result.json"),
    env,
  });
  assert.match(result.projectId, /^proj_[a-f0-9]{20}$/);
  assert.equal(result.projectIdentityStable, true);
  assert.equal(result.projectLocalWinner, "local");
  assert.equal(result.lastKnownGoodRetained, true);
  assert.equal(result.deletionCleared, true);
  assert.equal(result.trustCalls, 1);
  assert.equal(result.trustProjectId, result.projectId);
  assert.equal(result.trustDisplay, "trust");
  assert.equal(result.trustDeniedBeforeSpawn, true);
}

async function acceptPackagedServe({ installedCli, root, home }) {
  const configDir = join(root, "serve-config");
  const projectRoot = join(root, "serve-project");
  const stateDir = join(root, "serve-state");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 7678,
      publicBaseUrl: "http://127.0.0.1:7678",
      allowedRoots: [projectRoot],
      stateDir,
      shellInstructions: false,
      subagents: false,
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(configDir, "auth.json"),
    JSON.stringify({
      ownerToken: "config-v2-packaged-owner-token-long-enough",
      instanceId: "forge-config-v2-packaged",
    }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  await assertPortAvailable(7678);
  const env = acceptanceEnv({ configDir, home, stateDir });
  const child = spawn(process.execPath, [installedCli, "serve", "--allow-elevated"], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });

  try {
    await waitForCondition(
      () => output.includes("forgerelay listening on http://127.0.0.1:7678/mcp"),
      20_000,
      () => `packaged serve did not start on isolated port 7678:\n${output}`,
    );
    const response = await fetch("http://127.0.0.1:7678/.well-known/oauth-protected-resource/mcp");
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.match(String(metadata.resource), /^http:\/\/127\.0\.0\.1:7678\/mcp$/);
  } finally {
    await terminateChild(child);
  }
}

function runInstalledCli(installedCli, args, env) {
  return spawnSync(process.execPath, [installedCli, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
}

function runInstalledProbe({ installedRoot, probePath, mode, configDir, projectRoot, outputPath, env }) {
  const result = spawnSync(
    process.execPath,
    [probePath, installedRoot, mode, configDir, projectRoot, outputPath],
    {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 30_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Installed Config v2 probe failed (${mode}): ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`,
    );
  }
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

function runNpm(args, cwd, env, timeout) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`);
  }
  return result;
}

function acceptanceEnv({ configDir, home, stateDir }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      value !== undefined
      && !name.startsWith("FORGERELAY_")
      && name !== "PORT"
      && name !== "HOST"
    ),
  );
  delete env.npm_lifecycle_event;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
  };
}

function stringEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function waitForPtyExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for packaged interactive init to exit."));
    }, timeoutMs);
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function waitForCondition(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message());
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function scrubTerminal(value) {
  return value
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/Owner password:\s*[^\r\n]+/g, "Owner password: <redacted>");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installedProbeSource() {
  return String.raw`
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installedRoot, mode, configDir, projectRoot, outputPath] = process.argv.slice(2);
const importInstalled = (relativePath) => import(pathToFileURL(join(installedRoot, relativePath)).href);

if (mode === "snapshot") {
  const [
    { ExternalMcpConfigRegistry },
    { resolveLanguageServersConfig, effectiveLanguageServerEntries },
    { resolveHooksConfig, effectiveHookConfigEntries },
    { ConfigSourceRuntime },
    { resolveSubagentProfilesConfigSources },
  ] = await Promise.all([
    importInstalled("dist/runtime/config/external-mcp-registry.js"),
    importInstalled("dist/runtime/config/resolution/language-servers.js"),
    importInstalled("dist/runtime/config/resolution/hooks.js"),
    importInstalled("dist/runtime/config/runtime/source-refresh.js"),
    importInstalled("dist/subagents/profiles.js"),
  ]);
  const sourceRuntime = new ConfigSourceRuntime();
  const mcp = new ExternalMcpConfigRegistry({ configDir, sourceRuntime }).resolveGlobal();
  const lsp = await resolveLanguageServersConfig({ configDir, sourceRuntime });
  const hooks = await resolveHooksConfig({ configDir, sourceRuntime });
  const profiles = resolveSubagentProfilesConfigSources({ configDir, sourceRuntime });
  const snapshot = normalize({
    mcp: Object.fromEntries(Object.entries(mcp.servers).map(([name, server]) => [name, {
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
    }])),
    languageServers: Object.fromEntries(effectiveLanguageServerEntries(lsp).map((entry) => [entry.id, {
      command: entry.value.command,
      ...(entry.value.args ? { args: entry.value.args } : {}),
      ...(entry.value.extensions ? { extensions: entry.value.extensions } : {}),
    }])),
    hooks: effectiveHookConfigEntries(hooks).flatMap((entry) =>
      entry.entries.map((hook) => ({ name: entry.name, event: hook.event, command: hook.command, matcher: hook.matcher ?? null }))
    ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    profiles: profiles.values.profiles ?? {},
  });
  await writeFile(outputPath, JSON.stringify(snapshot), "utf8");
} else if (mode === "runtime") {
  const [
    { ProjectContextResolver },
    { ConfigSourceRuntime },
    { resolveHooksConfig, effectiveHookConfigEntries },
    { HookRunner },
  ] = await Promise.all([
    importInstalled("dist/workspaces/state/project-context.js"),
    importInstalled("dist/runtime/config/runtime/source-refresh.js"),
    importInstalled("dist/runtime/config/resolution/hooks.js"),
    importInstalled("dist/mcp/hooks/hooks.js"),
  ]);

  const sourceRuntime = new ConfigSourceRuntime();
  await mkdir(join(configDir, "hooks"), { recursive: true });
  await mkdir(join(projectRoot, ".forgerelay", "hooks"), { recursive: true });
  const identity = new ProjectContextResolver(configDir);
  const project = await identity.resolve(projectRoot);
  const again = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(join(project.localConfigDir, "hooks"), { recursive: true });

  await writeFile(join(configDir, "hooks", "shared.json"), JSON.stringify({ event: "AfterTool", command: "echo user" }), "utf8");
  await writeFile(join(project.sharedConfigDir, "hooks", "shared.json"), JSON.stringify({ event: "AfterTool", command: "echo project" }), "utf8");
  await writeFile(join(project.localConfigDir, "hooks", "shared.json"), JSON.stringify({ event: "AfterTool", command: "echo local" }), "utf8");
  await writeFile(join(project.sharedConfigDir, "hooks", "trust.json"), JSON.stringify({ event: "BeforeTool", command: "forgerelay-packaged-trust-must-not-spawn" }), "utf8");

  const projectResolution = await resolveHooksConfig({ configDir, project, sourceRuntime });
  const shared = effectiveHookConfigEntries(projectResolution).find((entry) => entry.name === "shared");
  assert.equal(shared?.scope, "project-local");
  assert.equal(shared?.entries[0]?.command, "echo local");

  const lkgPath = join(configDir, "hooks", "lkg.json");
  await writeFile(lkgPath, JSON.stringify({ event: "AfterTool", command: "echo first" }), "utf8");
  const first = await resolveHooksConfig({ configDir, project, sourceRuntime });
  assert.equal(effectiveHookConfigEntries(first).find((entry) => entry.name === "lkg")?.entries[0]?.command, "echo first");
  await writeFile(lkgPath, "{ invalid json\n", "utf8");
  const invalid = await resolveHooksConfig({ configDir, project, sourceRuntime });
  const retained = effectiveHookConfigEntries(invalid).find((entry) => entry.name === "lkg")?.entries[0]?.command === "echo first";
  assert.equal(invalid.diagnostics.some((entry) => entry.usingLastKnownGood === true), true);
  await rm(lkgPath, { force: true });
  const deleted = await resolveHooksConfig({ configDir, project, sourceRuntime });
  const deletionCleared = effectiveHookConfigEntries(deleted).every((entry) => entry.name !== "lkg");

  const trustRequirements = [];
  const denyPolicy = {
    async authorize(requirement) {
      trustRequirements.push(requirement);
      throw new Error("PACKAGED_TRUST_DENIED");
    },
  };
  const logging = {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  };
  const commandShellRuntime = process.platform === "win32"
    ? { family: "cmd", executable: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", source: "compatibility-default", capabilities: [] }
    : { family: "bash", executable: "/bin/bash", source: "compatibility-default", capabilities: [] };
  const runner = new HookRunner(
    {},
    logging,
    process.env,
    undefined,
    commandShellRuntime,
    configDir,
    sourceRuntime,
    denyPolicy,
  );
  let trustDeniedBeforeSpawn = false;
  try {
    await runner.run("BeforeTool", {
      workspaceRoot: projectRoot,
      cwd: projectRoot,
      payload: { tool: "read" },
    });
  } catch (error) {
    trustDeniedBeforeSpawn = String(error?.message ?? error).includes("PACKAGED_TRUST_DENIED");
  }
  assert.equal(trustRequirements.length, 1);
  assert.equal(trustDeniedBeforeSpawn, true);

  const requirement = trustRequirements[0];
  await writeFile(outputPath, JSON.stringify({
    projectId: project.id,
    projectIdentityStable: project.id === again.id,
    projectLocalWinner: shared?.entries[0]?.command.replace("echo ", ""),
    lastKnownGoodRetained: retained,
    deletionCleared,
    trustCalls: trustRequirements.length,
    trustProjectId: requirement.projectId,
    trustDisplay: requirement.display.name,
    trustDeniedBeforeSpawn,
  }), "utf8");
} else {
  throw new Error("Unknown installed Config v2 probe mode: " + mode);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}
`;
}
