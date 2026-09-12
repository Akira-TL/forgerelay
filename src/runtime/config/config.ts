import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "../../mcp/filesystem/roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "../logging/logger.js";
import type { OAuthConfig } from "../../mcp/oauth/oauth-provider.js";
import { mergeHookConfigs, parseHookConfig, type HookConfig } from "../../mcp/hooks/hooks.js";
import {
  forgerelaySkillsDir,
  generateInstanceId,
  loadForgeRelayFiles,
  type ForgeRelayUserConfig,
} from "./user-config.js";
import type { LanguageServerConfigInput } from "../../lsp/language-server-config.js";
import type { RuntimePrivilegeState } from "../security/runtime-privilege.js";
import {
  parseExternalMcpServers,
  type ExternalMcpServersConfig,
} from "./external-mcp-config.js";
import { DEFAULT_MEDIA_MAX_BYTES } from "../../mcp/operations/media-content.js";
import { shellInstructionPath } from "../instructions/shell-instructions.js";
import {
  resolveConfiguredCommandShellRuntime,
  type CommandShellRuntime,
} from "../shell/command-shell-runtime.js";
import { generalConfigDefinition } from "./definition/general-config.js";
import { resolveGeneralConfig } from "./resolution/general.js";
import { assertConfigResolutionValid } from "./resolution/resolver.js";
import { ConfigRuntime, type ConfigAppliedDomainState } from "./runtime/config-runtime.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
export type ProxyTrust = false | string[];
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TASK_REMINDER_INTERVAL = 30;

export interface LoadConfigOptions {
  runtimeOverrides?: Record<string, unknown>;
  projectConfig?: unknown;
  projectConfigPath?: string;
  projectLocalConfig?: unknown;
  projectLocalConfigPath?: string;
}

export interface LiveGeneralConfigState {
  applied: ConfigAppliedDomainState;
  source?: {
    state: "invalid";
    usingLastKnownGood: boolean;
    message: string;
  };
}

export interface ServerConfig {
  /** In-process Config v2 refresh/LKG and startup-applied state. Never persisted. */
  configRuntime: ConfigRuntime;
  instanceId: string;
  configDir: string;
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  /** Canonical public base URL; this is publicBaseUrls[0]. */
  publicBaseUrl: string;
  /** All configured public base URLs, each of which may include a route prefix. */
  publicBaseUrls: string[];
  /** Exact proxy source addresses/CIDRs Express may trust for forwarded client metadata. */
  proxyTrust: ProxyTrust;
  toolMode: ToolMode;
  workflowInstructions: string | false | undefined;
  appendInstructions: string | undefined;
  widgets: WidgetMode;
  activityPanelExpanded: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  mediaMaxBytes: number;
  taskReminderInterval: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  configSkillsDir: string;
  subagents: boolean;
  languageServers: LanguageServerConfigInput;
  allowAgentLanguageServerInstall: boolean;
  mcpServers: ExternalMcpServersConfig;
  agentDir: string;
  systemInstructionsPath: string;
  hooks: HookConfig;
  logging: LoggingConfig;
  commandShellRuntime: CommandShellRuntime;
  shellInstructionsEnabled: boolean;
  shellInstructionPath?: string;
  /** Runtime-only privilege state. Never persisted in config.json. */
  runtimePrivilege?: RuntimePrivilegeState;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function productEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`FORGERELAY_${suffix}`];
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = productEnv(env, "TOOL_MODE");
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid FORGERELAY_TOOL_MODE: ${mode}`);

  const minimalTools = productEnv(env, "MINIMAL_TOOLS");
  if (minimalTools !== undefined) {
    return parseBoolean(minimalTools) ? "minimal" : "full";
  }
  return "minimal";
}

function parseWorkflowInstructions(
  value: string | undefined,
  fallback: string | false | undefined,
): string | false | undefined {
  const resolved = value !== undefined ? value : fallback;
  if (resolved === false || resolved === undefined) return resolved;

  const instructions = resolved.trim();
  return instructions.length > 0 ? instructions : false;
}

function parseAppendInstructions(
  value: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const instructions = (value ?? fallback)?.trim();
  return instructions ? instructions : undefined;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid FORGERELAY_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "pretty") return "pretty";
  if (value === "json") return "json";

  throw new Error(`Invalid FORGERELAY_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv, trustProxy: boolean): LoggingConfig {
  const format = parseLogFormat(productEnv(env, "LOG_FORMAT"));
  const requests = productEnv(env, "LOG_REQUESTS");
  const toolCalls = productEnv(env, "LOG_TOOL_CALLS");
  const shellCommands = productEnv(env, "LOG_SHELL_COMMANDS");
  return {
    level: parseLogLevel(productEnv(env, "LOG_LEVEL")),
    format,
    requests: requests === undefined ? format === "json" : parseBoolean(requests),
    assets: parseBoolean(productEnv(env, "LOG_ASSETS")),
    toolCalls: toolCalls === undefined ? true : parseBoolean(toolCalls),
    shellCommands: shellCommands === undefined ? format === "pretty" : parseBoolean(shellCommands),
    trustProxy,
  };
}

function resolveProxyTrust(
  env: NodeJS.ProcessEnv,
  config: Pick<ForgeRelayUserConfig, "trustedProxies">,
  host: string,
  publicBaseUrl: string,
): ProxyTrust {
  const legacyTrustProxy = productEnv(env, "TRUST_PROXY");
  if (legacyTrustProxy !== undefined) {
    if (!parseBoolean(legacyTrustProxy)) return false;
    if (!isLoopbackHost(host)) {
      throw new Error(
        "FORGERELAY_TRUST_PROXY=1 is only safe with a loopback bind. Use FORGERELAY_TRUSTED_PROXIES with explicit proxy IP addresses or CIDRs for LAN binds.",
      );
    }
    return ["loopback"];
  }

  const explicitTrustedProxies = parseTrustedProxies(config.trustedProxies);
  if (explicitTrustedProxies !== undefined) return explicitTrustedProxies;

  return isLoopbackHost(host) && !isLoopbackHost(new URL(publicBaseUrl).hostname)
    ? ["loopback"]
    : false;
}

function parseTrustedProxies(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = (Array.isArray(value) ? value : value.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  if (entries.some((entry) => !isTrustedProxyAddress(entry))) {
    throw new Error(
      "FORGERELAY_TRUSTED_PROXIES must list trusted proxy IP addresses or CIDRs; only the internal `loopback` alias is also accepted.",
    );
  }
  return Array.from(new Set(entries));
}

function isTrustedProxyAddress(value: string): boolean {
  if (value === "loopback") return true;
  if (value === "*" || value === "0.0.0.0/0" || value === "::/0") return false;
  if (isIP(value) !== 0) return true;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return false;
  const address = value.slice(0, slashIndex);
  const prefixText = value.slice(slashIndex + 1);
  const family = isIP(address);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  return family === 4 ? prefix <= 32 : family === 6 ? prefix <= 128 : false;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid FORGERELAY_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for ForgeRelay OAuth. Run: forgerelay init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(productEnv(env, "OAUTH_OWNER_TOKEN") ?? ownerToken, "FORGERELAY_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      productEnv(env, "OAUTH_ACCESS_TOKEN_TTL_SECONDS"),
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      productEnv(env, "OAUTH_REFRESH_TOKEN_TTL_SECONDS"),
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "FORGERELAY_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(productEnv(env, "OAUTH_SCOPES"), ["forgerelay"]),
    allowedRedirectHosts: parseStringList(productEnv(env, "OAUTH_ALLOWED_REDIRECT_HOSTS"), [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "forgerelay");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".forgerelay", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

function defaultSystemInstructionsPath(): string {
  return join(homedir(), ".agents", "AGENTS.md");
}

function parseSystemInstructionsPath(value: unknown): string {
  if (value === undefined) return resolve(defaultSystemInstructionsPath());
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("FORGERELAY_SYSTEM_INSTRUCTIONS_PATH must be one non-empty path");
  }
  return resolve(expandHomePath(value.trim()));
}

interface PublicDeploymentConfig {
  baseUrls: string[];
  canonicalBaseUrl: string;
}

function parsePublicBaseUrls(
  value: string | string[] | null | undefined,
  fallback: string[],
): string[] {
  if (value === null) return fallback;
  const raw = Array.isArray(value)
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (value !== undefined && (!raw || raw.length === 0)) {
    throw new Error("FORGERELAY_PUBLIC_BASE_URL must contain at least one public base URL.");
  }
  const normalized = (raw ?? fallback).map((entry) => parsePublicBaseUrl(entry));
  return Array.from(new Set(normalized));
}

function resolvePublicDeployment(
  configuredValue: ForgeRelayUserConfig["publicBaseUrl"],
  host: string,
  port: number,
): PublicDeploymentConfig {
  const localBaseUrls = [parsePublicBaseUrl(localPublicBaseUrl(host, port))];
  const baseUrls = parsePublicBaseUrls(configuredValue, localBaseUrls);
  return {
    baseUrls,
    canonicalBaseUrl: baseUrls[0],
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): ServerConfig {
  const configRuntime = new ConfigRuntime();
  const runtimeEnvironment = generalConfigRuntimeEnvironment(env);
  configRuntime.captureResolutionInputs(generalConfigDefinition.domain, {
    environment: runtimeEnvironment,
    ...(options.runtimeOverrides ? { cli: options.runtimeOverrides } : {}),
  });
  const files = loadForgeRelayFiles(env);
  const generalResolution = resolveGeneralConfig({
    env,
    ...(options.runtimeOverrides ? { cli: options.runtimeOverrides } : {}),
    ...(files.configExists ? { user: files.config, userSourcePath: files.configPath } : {}),
    ...(options.projectConfig !== undefined
      ? { project: options.projectConfig, projectSourcePath: options.projectConfigPath }
      : {}),
    ...(options.projectLocalConfig !== undefined
      ? { projectLocal: options.projectLocalConfig, projectLocalSourcePath: options.projectLocalConfigPath }
      : {}),
  });
  assertConfigResolutionValid(generalResolution);
  const config = generalResolution.values as ForgeRelayUserConfig;
  refreshGeneralUserConfigSource(configRuntime, files.configPath, runtimeEnvironment);
  const instanceId = files.auth.instanceId?.trim() || generateInstanceId();
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 7676;
  const publicDeployment = resolvePublicDeployment(config.publicBaseUrl, host, port);
  const publicBaseUrl = publicDeployment.canonicalBaseUrl;
  const proxyTrust = resolveProxyTrust(env, config, host, publicBaseUrl);
  const commandShellRuntime = resolveConfiguredCommandShellRuntime(config.commandShell, process.platform, env);
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    ...publicDeployment.baseUrls.map((baseUrl) => new URL(baseUrl).hostname),
    ...(config.allowedHosts ?? []),
  ];

  const serverConfig: ServerConfig = {
    configRuntime,
    instanceId,
    configDir: files.dir,
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(config.allowedRoots),
    allowedHosts: parseAllowedHosts(config.allowedHosts, derivedAllowedHosts),
    publicBaseUrl,
    publicBaseUrls: publicDeployment.baseUrls,
    proxyTrust,
    toolMode: parseToolMode(env),
    workflowInstructions: parseWorkflowInstructions(undefined, config.workflowInstructions),
    appendInstructions: parseAppendInstructions(undefined, config.appendInstructions),
    widgets: parseWidgetMode(productEnv(env, "WIDGETS")),
    activityPanelExpanded: config.activityPanelExpanded === true,
    stateDir: resolve(expandHomePath(config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled: config.artifactsEnabled === true,
    artifactMaxFileBytes: config.artifactMaxFileBytes ?? DEFAULT_ARTIFACT_MAX_FILE_BYTES,
    mediaMaxBytes: config.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES,
    taskReminderInterval: config.taskReminderInterval ?? DEFAULT_TASK_REMINDER_INTERVAL,
    skillsEnabled: productEnv(env, "SKILLS") === undefined ? true : parseBoolean(productEnv(env, "SKILLS")),
    skillPaths: parsePathList(productEnv(env, "SKILL_PATHS")),
    configSkillsDir: forgerelaySkillsDir(env),
    subagents: config.subagents === true,
    languageServers: config.languageServers ?? {},
    allowAgentLanguageServerInstall: config.allowAgentLanguageServerInstall === true,
    mcpServers: parseExternalMcpServers(config.mcpServers),
    agentDir: resolve(expandHomePath(config.agentDir ?? defaultAgentDir())),
    systemInstructionsPath: parseSystemInstructionsPath(config.systemInstructionsPath),
    hooks: mergeHookConfigs(
      parseHookConfig(config.hooks),
      parseHookConfig(files.hooks),
    ),
    logging: parseLoggingConfig(env, proxyTrust !== false),
    commandShellRuntime,
    shellInstructionsEnabled: config.shellInstructions !== false,
    shellInstructionPath: shellInstructionPath(files.dir, commandShellRuntime.family),
  };
  configRuntime.captureApplied(
    generalConfigDefinition,
    restartRequiredGeneralValues(config, runtimeEnvironment),
  );
  return serverConfig;
}

export function liveGeneralConfigState(config: ServerConfig): LiveGeneralConfigState {
  const inputs = config.configRuntime.resolutionInputsFor(generalConfigDefinition.domain);
  const configPath = join(config.configDir, "config.json");
  const refreshed = refreshGeneralUserConfigSource(
    config.configRuntime,
    configPath,
    inputs.environment,
  );
  const resolution = resolveGeneralConfig({
    env: inputs.environment,
    ...(inputs.cli ? { cli: inputs.cli } : {}),
    ...(refreshed.value !== undefined
      ? { user: refreshed.value, userSourcePath: configPath }
      : {}),
  });
  const configured = resolution.values as ForgeRelayUserConfig;
  return {
    applied: config.configRuntime.snapshotApplied(
      generalConfigDefinition,
      restartRequiredGeneralValues(configured, inputs.environment),
    ),
    ...(refreshed.status.state === "invalid" && refreshed.issue
      ? {
          source: {
            state: "invalid" as const,
            usingLastKnownGood: refreshed.status.usingLastKnownGood,
            message: refreshed.issue.message,
          },
        }
      : {}),
  };
}

function refreshGeneralUserConfigSource(
  runtime: ConfigRuntime,
  configPath: string,
  environment: NodeJS.ProcessEnv,
) {
  return runtime.sources.refreshFile<ForgeRelayUserConfig>({
    key: `general:user:${configPath}`,
    path: configPath,
    parse: (raw) => JSON.parse(raw) as ForgeRelayUserConfig,
    parseIssue: {
      code: "invalid_source",
      message: "General configuration is not valid JSON.",
    },
    readIssue: {
      code: "invalid_source",
      message: "General configuration could not be read.",
    },
    validate: (value) => {
      const validation = resolveGeneralConfig({
        env: environment,
        user: value,
        userSourcePath: configPath,
      });
      const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      return error
        ? { code: error.code === "missing_environment" ? "missing_environment" : "invalid_source", message: error.message }
        : undefined;
    },
  });
}

function generalConfigRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set<string>(["FORGERELAY_TRUST_PROXY"]);
  for (const field of Object.values(generalConfigDefinition.fields)) {
    const configured = field.runtimeOverride?.env;
    if (!configured) continue;
    for (const name of Array.isArray(configured) ? configured : [configured]) names.add(name);
  }
  return Object.fromEntries(
    [...names].flatMap((name) => env[name] === undefined ? [] : [[name, env[name]]]),
  );
}

function restartRequiredGeneralValues(
  configured: ForgeRelayUserConfig,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const host = configured.host ?? "127.0.0.1";
  const port = configured.port ?? 7676;
  const publicDeployment = resolvePublicDeployment(configured.publicBaseUrl, host, port);
  const proxyTrust = resolveProxyTrust(env, configured, host, publicDeployment.canonicalBaseUrl);
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    ...publicDeployment.baseUrls.map((baseUrl) => new URL(baseUrl).hostname),
    ...(configured.allowedHosts ?? []),
  ];
  return {
    host,
    port,
    allowedRoots: parseAllowedRoots(configured.allowedRoots),
    publicBaseUrl: publicDeployment.baseUrls,
    allowedHosts: parseAllowedHosts(configured.allowedHosts, derivedAllowedHosts),
    trustedProxies: proxyTrust === false ? [] : proxyTrust,
    stateDir: resolve(expandHomePath(configured.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(configured.worktreeRoot ?? defaultWorktreeRoot())),
    agentDir: resolve(expandHomePath(configured.agentDir ?? defaultAgentDir())),
    commandShell: configured.commandShell,
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
