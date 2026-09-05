#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { loadConfig } from "./runtime/config/config.js";
import { acquireRuntimeLease } from "./runtime/state/runtime-lease.js";
import { runInit } from "./cli/init.js";
import { runMaintenanceCommand } from "./cli/maintenance.js";
import { runHooksCommand } from "./mcp/hooks/hook-cli.js";
import { executeSubagentSession } from "./subagents/sessions/execution.js";
import { SubagentDeliveryMailbox } from "./subagents/sessions/delivery-mailbox.js";
import { SubagentSessionManager } from "./subagents/sessions/manager.js";
import { formatSubagentProviderAvailabilitySummary } from "./subagents/providers/availability.js";
import { parseSubagentRunArgs } from "./subagents/cli-target.js";
import type { SubagentSession } from "./subagents/sessions/store.js";
import {
  ensureForgeRelayInstanceId,
  loadForgeRelayFiles,
  removeForgeRelayRemote,
  renameForgeRelayRemote,
  writeForgeRelayConfig,
  writeForgeRelayRemote,
} from "./runtime/config/user-config.js";
import { shutdownHttpServer } from "./mcp/server/transport/server-shutdown.js";
import { publicEndpointUrl } from "./mcp/oauth/public-url.js";
import {
  assertRuntimePrivilegeAllowed,
  detectRuntimePrivilege,
  elevatedRuntimeWarning,
  formatRuntimePrivilege,
  type RuntimePrivilegeState,
} from "./runtime/security/runtime-privilege.js";
import {
  authenticateRemote,
  defaultRemoteAlias,
  isRemoteMcpUnauthorized,
  normalizeRemoteServiceTarget,
  refreshRemoteAuthentication,
  verifyRemoteMcp,
} from "./workspaces/relay/auth/remote-auth.js";
import {
  defaultSshRouteAlias,
  parseSshRoute,
  readRemoteOwnerToken,
  withRemoteServiceEndpoint,
} from "./workspaces/relay/transport/remote-transport.js";
import {
  assertSupportedNode,
  checkBashShell,
  checkGitAvailable,
  checkSqliteNative,
  nodeVersionStatus,
  normalizeOptionalPublicBaseUrl,
} from "./cli/setup-support.js";


type Command = "serve" | "init" | "doctor" | "config" | "hooks" | "agents" | "auth" | "maintenance" | "help" | "version";
const require = createRequire(import.meta.url);

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...rest] = argv;
  const defaultServeFlag = rawCommand === "--allow-elevated";
  const command = defaultServeFlag ? "serve" : normalizeCommand(rawCommand);
  const args = defaultServeFlag ? argv : rest;

  switch (command) {
    case "serve": {
      const serveOptions = parseServeCommandArgs(args);
      const runtimePrivilege = detectRuntimePrivilege();
      assertRuntimePrivilegeAllowed(runtimePrivilege, serveOptions.allowElevated);
      if (serveOptions.allowElevated) console.warn(elevatedRuntimeWarning(runtimePrivilege));
      await ensureConfigured();
      await serve(runtimePrivilege);
      return;
    }
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "hooks":
      await runHooksCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "auth":
      await runAuthCommand(args);
      return;
    case "maintenance":
      runMaintenanceCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "config" || command === "hooks" || command === "agents" || command === "auth" || command === "maintenance") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

interface ServeCommandOptions {
  allowElevated: boolean;
}

function parseServeCommandArgs(args: string[]): ServeCommandOptions {
  let allowElevated = false;
  for (const arg of args) {
    if (arg === "--allow-elevated") {
      if (allowElevated) throw new Error("--allow-elevated may only be supplied once.");
      allowElevated = true;
      continue;
    }
    throw new Error(`Unknown serve option: ${arg}`);
  }
  return { allowElevated };
}

async function ensureConfigured(): Promise<void> {
  const files = loadForgeRelayFiles();
  if (files.configExists && files.authExists) {
    await ensureForgeRelayInstanceId();
    return;
  }
  if (process.env.FORGERELAY_OAUTH_OWNER_TOKEN) {
    await ensureForgeRelayInstanceId();
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "ForgeRelay is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  forgerelay init",
        "",
        "Or provide FORGERELAY_OAUTH_OWNER_TOKEN and FORGERELAY_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function serve(runtimePrivilege: RuntimePrivilegeState): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  config.runtimePrivilege = runtimePrivilege;
  const runtimeLease = acquireRuntimeLease(config.stateDir);
  let server: ReturnType<typeof createServer>;
  try {
    server = createServer(config);
  } catch (error) {
    runtimeLease.release();
    throw error;
  }
  const { app, close, subagentProviders } = server;
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `forgerelay listening on http://${config.host}:${config.port}${publicEndpointUrl(config.publicBaseUrl, "mcp").pathname}`,
    );
    console.log(`client-facing base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because FORGERELAY_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`runtime privilege: ${formatRuntimePrivilege(runtimePrivilege)}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatSubagentProviderAvailabilitySummary(subagentProviders)}`);
    }
  });

  let shuttingDown = false;
  const releaseRuntimeLease = () => runtimeLease.release();
  process.once("exit", releaseRuntimeLease);
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdownHttpServer(httpServer, close);
    } finally {
      process.removeListener("exit", releaseRuntimeLease);
      runtimeLease.release();
    }
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("forgerelay shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}


interface AuthCommandArgs {
  target: string;
  alias?: string;
  ownerToken?: string;
  sshRoute?: string[];
  sshAuth: boolean;
}

function parseAuthCommandArgs(args: string[]): AuthCommandArgs {
  let target: string | undefined;
  let alias: string | undefined;
  let ownerToken: string | undefined;
  let sshRoute: string[] | undefined;
  let sshAuth = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--alias") {
      alias = args[++index];
      if (!alias) throw new Error("Missing value for --alias.");
      continue;
    }
    if (arg === "--token") {
      ownerToken = args[++index];
      if (!ownerToken) throw new Error("Missing value for --token.");
      continue;
    }
    if (arg === "-J") {
      const route = args[++index];
      if (!route) throw new Error("Missing value for -J.");
      sshRoute = parseSshRoute(route);
      continue;
    }
    if (arg === "--ssh-auth") {
      sshAuth = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown auth option: ${arg}`);
    if (target) throw new Error(`Unexpected auth argument: ${arg}`);
    target = arg;
  }

  if (!target) throw new Error("Missing remote service target.");
  if (sshAuth && !sshRoute) throw new Error("--ssh-auth requires -J <ssh-route>.");
  if (sshAuth && ownerToken) throw new Error("--ssh-auth and --token cannot be used together.");
  return { target, alias, ownerToken, sshRoute, sshAuth };
}

async function resolveAuthOwnerToken(ownerToken: string | undefined): Promise<string> {
  if (ownerToken) return ownerToken;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Missing owner token. Pass --token, use --ssh-auth with -J, or run in an interactive terminal.");
  }
  const result = await prompts.password({
    message: "Remote ForgeRelay owner token",
    validate: (value) => value?.trim() ? undefined : "Enter the remote owner token.",
  });
  if (prompts.isCancel(result)) throw new Error("Remote authentication cancelled.");
  return String(result);
}

function localOwnerToken(): string {
  const token = process.env.FORGERELAY_OAUTH_OWNER_TOKEN
    ?? loadForgeRelayFiles().auth.ownerToken;
  if (!token) throw new Error("ForgeRelay owner token is not configured on this machine.");
  return token;
}

async function runAuthCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "__owner-token") {
    if (rest.length > 0) throw new Error("Internal owner-token command does not accept arguments.");
    process.stdout.write(`${localOwnerToken()}\n`);
    return;
  }
  if (subcommand === "list") {
    if (rest.length > 0) throw new Error("forgerelay auth list does not accept additional arguments.");
    const remotes = loadForgeRelayFiles().auth.remotes ?? {};
    if (Object.keys(remotes).length === 0) {
      console.log("No remote ForgeRelay instances registered.");
      return;
    }
    for (const [alias, remote] of Object.entries(remotes).sort(([left], [right]) => left.localeCompare(right))) {
      console.log(`${alias}\t${remote.target}\t${remote.instanceId}`);
    }
    return;
  }
  if (subcommand === "rename") {
    const [fromAlias, toAlias, ...extra] = rest;
    if (!fromAlias || !toAlias || extra.length > 0) {
      throw new Error("Usage: forgerelay auth rename <old-alias> <new-alias>");
    }
    await renameForgeRelayRemote(fromAlias, toAlias);
    console.log(`Renamed remote ${fromAlias} to ${toAlias}.`);
    return;
  }
  if (subcommand === "remove") {
    const [alias, ...extra] = rest;
    if (!alias || extra.length > 0) throw new Error("Usage: forgerelay auth remove <alias>");
    await removeForgeRelayRemote(alias);
    console.log(`Removed remote ${alias}.`);
    return;
  }
  if (subcommand === "test") {
    const [alias, ...extra] = rest;
    if (!alias || extra.length > 0) throw new Error("Usage: forgerelay auth test <alias>");
    const files = loadForgeRelayFiles();
    const storedRemote = files.auth.remotes?.[alias];
    if (!storedRemote) throw new Error(`Unknown remote alias: ${alias}`);
    let remote = storedRemote;

    await withRemoteServiceEndpoint(remote.target, remote.sshRoute, async (endpoint) => {
      let refreshed = false;
      if (remote.accessTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
        remote = await refreshRemoteAuthentication(remote, endpoint);
        await writeForgeRelayRemote(alias, remote);
        refreshed = true;
      }

      try {
        await verifyRemoteMcp(remote, endpoint);
      } catch (error) {
        if (refreshed || !isRemoteMcpUnauthorized(error)) throw error;
        remote = await refreshRemoteAuthentication(remote, endpoint);
        await writeForgeRelayRemote(alias, remote);
        await verifyRemoteMcp(remote, endpoint);
      }
    });
    console.log(`${alias}\tok\t${remote.instanceId}`);
    return;
  }

  const parsed = parseAuthCommandArgs(args);
  const target = normalizeRemoteServiceTarget(parsed.target);
  const authenticated = await withRemoteServiceEndpoint(
    target,
    parsed.sshRoute,
    async (endpoint) => {
      const ownerToken = parsed.sshAuth
        ? await readRemoteOwnerToken(parsed.sshRoute ?? [])
        : await resolveAuthOwnerToken(parsed.ownerToken);
      return authenticateRemote(endpoint, ownerToken);
    },
  );
  const remote = {
    ...authenticated,
    target,
    ...(parsed.sshRoute ? { sshRoute: parsed.sshRoute } : {}),
  };
  const files = loadForgeRelayFiles();
  const existingAlias = Object.entries(files.auth.remotes ?? {}).find(
    ([, record]) => record.instanceId === remote.instanceId,
  )?.[0];
  const defaultAlias = parsed.sshRoute
    ? defaultSshRouteAlias(parsed.sshRoute)
    : defaultRemoteAlias(remote.target);
  const alias = parsed.alias?.trim() || existingAlias || defaultAlias;
  if (!files.auth.instanceId) {
    await ensureForgeRelayInstanceId();
  }
  await writeForgeRelayRemote(alias, remote);
  console.log(`Authenticated remote ${alias} (${remote.instanceId}).`);
}

async function runDoctor(): Promise<void> {
  const files = loadForgeRelayFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Runtime privilege: ${formatRuntimePrivilege(detectRuntimePrivilege())}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(
      `Bind MCP URL: http://${config.host}:${config.port}${publicEndpointUrl(config.publicBaseUrl, "mcp").pathname}`,
    );
    console.log(`Client-facing base URLs: ${config.publicBaseUrls.join(", ")}`);
    console.log(`Client-facing base URL: ${config.publicBaseUrl}`);
    console.log(`Client-facing MCP URL: ${publicEndpointUrl(config.publicBaseUrl, "mcp").toString()}`);
    console.log(`Tool mode: ${config.toolMode}`);
    console.log(`Widgets: ${config.widgets}`);
    console.log(`Trust proxy: ${config.proxyTrust === false ? "off" : config.proxyTrust.join(", ")}`);
    console.log(`Artifacts: ${config.artifactsEnabled ? "enabled" : "disabled"}`);
    console.log(`Subagents: ${config.subagents ? "enabled" : "disabled"}`);
    console.log(`Skills: ${config.skillsEnabled ? "enabled" : "disabled"}`);
    console.log(`Agent-managed Language Server install: ${config.allowAgentLanguageServerInstall ? "enabled" : "disabled"}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadForgeRelayFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `forgerelay config set publicBaseUrl <url[,url...]|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) throw new Error("Missing publicBaseUrl value.");

  writeForgeRelayConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "ForgeRelay",
      "",
      "Usage:",
      "  forgerelay                 Run first-time setup if needed, then start the server",
      "  forgerelay serve           Start the server",
      "  forgerelay serve --allow-elevated",
      "                            Explicitly allow this invocation to run with elevated/unknown OS privilege",
      "  forgerelay init            Create or update ~/.forgerelay/config.json and auth.json",
      "  forgerelay doctor          Show config, runtime, and native dependency status",
      "  forgerelay config get      Print persisted config",
      "  forgerelay config set publicBaseUrl <url[,url...]|null>",
      "  forgerelay hooks list [--project <path>]",
      "  forgerelay hooks check [--project <path>]",
      "  forgerelay agents ls       List subagent sessions",
      "  forgerelay agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
      "  forgerelay agents show <id>",
      "  forgerelay auth <target> [--alias <name>] [--token <owner-token>]",
      "  forgerelay auth -J <ssh-route> <target> [--alias <name>] [--token <owner-token>|--ssh-auth]",
      "  forgerelay auth list",
      "  forgerelay auth test <alias>",
      "  forgerelay auth rename <old-alias> <new-alias>",
      "  forgerelay auth remove <alias>",
      "  forgerelay maintenance inspect [--json]",
      "  forgerelay -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  FORGERELAY_PUBLIC_BASE_URL=https://example.trycloudflare.com/forgerelay/debug forgerelay serve",
    ].join("\n"),
  );
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList();
      return;
    case "run":
      await runAgentsRun(rest);
      return;
    case "show":
      await runAgentsShow(rest);
      return;
    case "__worker":
      await runAgentsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsList(): Promise<void> {
  const manager = createCliSubagentSessionManager();
  try {
    const agents = manager.list(resolveCurrentWorkspaceScope());
    if (agents.length === 0) {
      console.log("No subagent sessions found for this workspace.");
      return;
    }

    for (const agent of agents) {
      console.log(formatAgentLine(agent));
    }
  } finally {
    manager.close();
  }
}

async function runAgentsRun(args: string[]): Promise<void> {
  const parsed = parseSubagentRunArgs(args);
  const workspaceRoot = resolveCurrentWorkspaceRoot();
  const manager = createCliSubagentSessionManager();
  try {
    const existing = manager.get(parsed.target);
    if (existing && (parsed.model || parsed.thinking)) throw new Error("Existing Subagent Sessions cannot override model or thinking.");
    const started = existing
      ? manager.resume({ sessionId: existing.id, prompt: parsed.prompt })
      : await manager.start({
          workspaceId: process.env.FORGERELAY_WORKSPACE_ID,
          workspaceRoot,
          target: parsed.target,
          prompt: parsed.prompt,
          model: parsed.model,
          thinking: parsed.thinking,
        });
    console.log(formatAgentLine(started.session));
  } finally {
    manager.close();
  }
}

async function runAgentsShow(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: forgerelay agents show <id>");

  const config = loadConfig();
  const manager = createCliSubagentSessionManager(config);
  try {
    let record = manager.get(id);
    if (!record) throw new Error(`Unknown subagent id: ${id}`);

    const deadline = Date.now() + 15_000;
    while (record.status === "running" && Date.now() < deadline) {
      await sleep(500);
      record = manager.get(id) ?? record;
    }

    console.log(formatAgentLine(record));
    if (record.workspaceId) {
      const deliveries = new SubagentDeliveryMailbox(config.stateDir).claimSession(record.workspaceId, record.id);
      for (const delivery of deliveries) {
        const text = delivery.outcome === "succeeded" ? delivery.finalResponse : delivery.error;
        if (text) console.log(text);
      }
      if (deliveries.length > 0) return;
    }
    if (record.latestRun) console.log(`Latest run ${record.latestRun.id}: ${record.latestRun.status}`);
    if (record.status === "running") {
      console.log(`No final response yet. Call \`forgerelay agents show ${record.id}\` again later.`);
    }
  } finally {
    manager.close();
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile] = args;
  if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
    throw new Error("Usage: forgerelay agents __worker <id> --prompt-file <path>");
  }
  const config = loadConfig();
  const prompt = await readFile(promptFile, "utf8");
  await rm(promptFile, { force: true });
  await executeSubagentSession(config, id, prompt);
}
function createCliSubagentSessionManager(config = loadConfig()): SubagentSessionManager {
  return new SubagentSessionManager(config, {
    launch(request) {
      const promptFile = writeSubagentPromptFile(request.prompt);
      const pid = spawnSubagentWorker(request.sessionId, promptFile);
      return pid === undefined ? undefined : { id: `subagent-worker-${request.runId}`, pid };
    },
  });
}
function spawnSubagentWorker(sessionId: string, promptFile: string): number | undefined {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "agents",
    "__worker",
    sessionId,
    "--prompt-file",
    promptFile,
  ], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function writeSubagentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "forgerelay-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function resolveCurrentWorkspaceRoot(): string {
  return resolve(process.env.FORGERELAY_WORKSPACE_ROOT ?? process.cwd());
}

function resolveCurrentWorkspaceScope(): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.FORGERELAY_WORKSPACE_ID,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
  };
}

function formatAgentLine(agent: Pick<
  SubagentSession,
  "id" | "status" | "profileName" | "provider" | "model" | "thinking"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "ForgeRelay agents",
      "",
      "Usage:",
      "  forgerelay agents ls",
      "  forgerelay agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
      "  forgerelay agents show <id>",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read ForgeRelay package version.");
  }

  console.log(packageJson.version);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
