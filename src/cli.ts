#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./runtime/config/config.js";
import { acquireRuntimeLease } from "./runtime/state/runtime-lease.js";
import { runInit } from "./cli/init.js";
import { runConfigMigration } from "./cli/config/migrate.js";
import { runConfigInspection } from "./cli/config/inspect.js";
import { renderGeneralConfigHelp, runGeneralConfigGet, runGeneralConfigSet, runGeneralConfigUnset } from "./cli/config/general.js";
import { runConfigDomainCommand } from "./cli/config/domains/domain-cli.js";
import { runMaintenanceCommand } from "./cli/maintenance.js";
import { runExternalMcpCommand } from "./cli/mcp/external-mcp.js";
import {
  formatExternalMcpDoctor,
  inspectExternalMcpStatus,
  resolveExternalMcpScope,
} from "./cli/mcp/status.js";
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
import { formatCommandShellRuntime } from "./runtime/shell/command-shell-runtime.js";
import { commandShellCompatibilityWarning } from "./cli/shell/setup.js";
import {
  renderCliRootHelp,
  renderServeHelp,
  resolveCliRootRoute,
  routeArguments,
  type CliCompatibilityHandler,
} from "./cli/core/command-tree.js";
import { parseServeCommandArgs } from "./cli/core/serve-options.js";
import { runRelayCommand } from "./cli/connect/relay.js";
import { runSystemStatus } from "./cli/system/status.js";
import {
  assertSupportedNode,
  checkGitAvailable,
  checkSqliteNative,
  nodeVersionStatus,
} from "./cli/setup-support.js";


const require = createRequire(import.meta.url);

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...rest] = argv;
  const route = resolveCliRootRoute(rawCommand);
  const args = routeArguments(route, rest);
  if (route.compatibilityHandler) {
    await runCompatibilityRootCommand(route.compatibilityHandler, args);
    return;
  }

  switch (route.handler) {
    case "serve":
      await runServeCommand(args);
      return;
    case "init":
      await runInitCommand(args);
      return;
    case "config":
      await runConfigRootCommand(args);
      return;
    case "connect":
      await runConnectCommand(args);
      return;
    case "system":
      await runSystemCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

async function runCompatibilityRootCommand(
  handler: CliCompatibilityHandler,
  args: string[],
): Promise<void> {
  switch (handler) {
    case "agents":
      await runAgentsCommand(args);
      return;
  }
}

async function runServeCommand(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
    console.log(renderServeHelp());
    return;
  }
  const serveOptions = parseServeCommandArgs(args);
  const runtimePrivilege = detectRuntimePrivilege();
  assertRuntimePrivilegeAllowed(runtimePrivilege, serveOptions.allowElevated);
  if (serveOptions.allowElevated) console.warn(elevatedRuntimeWarning(runtimePrivilege));
  await ensureConfigured();
  await serve(runtimePrivilege, serveOptions.runtimeOverrides);
}

async function runInitCommand(args: string[]): Promise<void> {
  const initOptions = parseInitCommandArgs(args);
  await runInit({ ...initOptions, version: installedForgeRelayVersion() });
}

async function runConfigRootCommand(args: string[]): Promise<void> {
  const [domain, ...rest] = args;
  if (domain === "hooks" && rest[0] === "--compat") {
    await runHooksCommand(rest.slice(1));
    return;
  }
  if (domain && await runConfigDomainCommand(domain, rest)) return;
  if (domain === "hooks") {
    await runHooksCommand(rest);
    return;
  }
  await runConfigCommand(args);
}

async function runConnectCommand(args: string[]): Promise<void> {
  const [domain, ...rest] = args;
  if (domain === "relay") {
    await runRelayCommand(rest);
    return;
  }
  if (domain === "mcp") {
    await runExternalMcpCommand(rest);
    return;
  }
  if (!domain || domain === "help" || domain === "--help" || domain === "-h") {
    printConnectHelp();
    return;
  }
  throw new Error(`Unknown connect command: ${domain}`);
}

async function runSystemCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "doctor") {
    if (rest.length > 0) throw new Error("forgerelay system doctor does not accept additional arguments.");
    await runDoctor();
    return;
  }
  if (subcommand === "status") {
    if (rest.length > 0) throw new Error("forgerelay system status does not accept additional arguments.");
    runSystemStatus();
    return;
  }
  if (subcommand === "inspect" || subcommand === "prune") {
    runMaintenanceCommand([subcommand, ...rest]);
    return;
  }
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printSystemHelp();
    return;
  }
  throw new Error(`Unknown system command: ${subcommand}`);
}

interface InitCommandOptions {
  force: boolean;
  advanced: boolean;
}

function parseInitCommandArgs(args: string[]): InitCommandOptions {
  let force = false;
  let advanced = false;
  for (const arg of args) {
    if (arg === "--force" && !force) force = true;
    else if (arg === "--advanced" && !advanced) advanced = true;
    else if (arg === "--force" || arg === "--advanced") throw new Error(`${arg} may only be supplied once.`);
    else throw new Error(`Unknown init option: ${arg}`);
  }
  return { force, advanced };
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

  await runInit({ force: false, advanced: false, version: installedForgeRelayVersion() });
}

async function serve(
  runtimePrivilege: RuntimePrivilegeState,
  runtimeOverrides: Record<string, unknown> = {},
): Promise<void> {
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
  const config = loadConfig(process.env, { runtimeOverrides });
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
    console.log(`command shell: ${formatCommandShellRuntime(config.commandShellRuntime)}`);
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
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(
      `Bind MCP URL: http://${config.host}:${config.port}${publicEndpointUrl(config.publicBaseUrl, "mcp").pathname}`,
    );
    console.log(`Client-facing base URLs: ${config.publicBaseUrls.join(", ")}`);
    console.log(`Client-facing base URL: ${config.publicBaseUrl}`);
    console.log(`Client-facing MCP URL: ${publicEndpointUrl(config.publicBaseUrl, "mcp").toString()}`);
    console.log(`Command shell: ${formatCommandShellRuntime(config.commandShellRuntime)}`);
    console.log(`Command shell executable: ${config.commandShellRuntime.executable}`);
    console.log(`Command shell source: ${config.commandShellRuntime.source}`);
    const shellCompatibilityWarning = commandShellCompatibilityWarning(config.commandShellRuntime.family);
    console.log(`Command shell compatibility: ${shellCompatibilityWarning ?? "native supported runtime"}`);
    console.log(
      `Shell Instructions: ${config.shellInstructionsEnabled ? "enabled" : "disabled"}` +
      (config.shellInstructionPath
        ? ` (${config.shellInstructionPath}; ${existsSync(config.shellInstructionPath) ? "available" : "unavailable"})`
        : " (not applicable)"),
    );
    console.log(`Tool mode: ${config.toolMode}`);
    console.log(`Widgets: ${config.widgets}`);
    console.log(`Trust proxy: ${config.proxyTrust === false ? "off" : config.proxyTrust.join(", ")}`);
    console.log(`Artifacts: ${config.artifactsEnabled ? "enabled" : "disabled"}`);
    console.log(`Subagents: ${config.subagents ? "enabled" : "disabled"}`);
    console.log(`Skills: ${config.skillsEnabled ? "enabled" : "disabled"}`);
    console.log(`Agent-managed Language Server install: ${config.allowAgentLanguageServerInstall ? "enabled" : "disabled"}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(formatExternalMcpDoctor(inspectExternalMcpStatus(await resolveExternalMcpScope({}, {
      env: process.env,
      cwd: process.cwd(),
    }))));
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runConfigCommand(args: string[]): Promise<void> {
  const [subcommand] = args;
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(renderGeneralConfigHelp());
    return;
  }
  if (subcommand === "migrate") {
    await runConfigMigration(args.slice(1));
    return;
  }
  if (subcommand === "check" || subcommand === "sources" || subcommand === "explain") {
    process.exitCode = await runConfigInspection(args);
    return;
  }
  if (!subcommand || subcommand === "get") {
    await runGeneralConfigGet(subcommand ? args.slice(1) : []);
    return;
  }

  if (subcommand === "set") {
    await runGeneralConfigSet(args.slice(1));
    return;
  }
  if (subcommand === "unset") {
    await runGeneralConfigUnset(args.slice(1));
    return;
  }
  throw new Error(`Unknown config command: ${subcommand}`);
}

function printHelp(): void {
  console.log(renderCliRootHelp());
}

function printConnectHelp(): void {
  console.log([
    "ForgeRelay connect",
    "",
    "Usage:",
    "  forgerelay connect relay ...",
    "  forgerelay connect mcp ...",
  ].join("\n"));
}

function printSystemHelp(): void {
  console.log([
    "ForgeRelay system",
    "",
    "Usage:",
    "  forgerelay system doctor",
    "  forgerelay system status",
    "  forgerelay system inspect [--json]",
    "  forgerelay system prune [--json]",
  ].join("\n"));
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

function installedForgeRelayVersion(): string {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read ForgeRelay package version.");
  }
  return packageJson.version;
}

function printVersion(): void {
  console.log(installedForgeRelayVersion());
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
