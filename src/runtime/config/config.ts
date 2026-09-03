import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "../../mcp/filesystem/roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "../logging/logger.js";
import type { OAuthConfig } from "../../mcp/oauth/oauth-provider.js";
import { mergeHookConfigs, parseHookConfig, type HookConfig } from "../../mcp/hooks/hooks.js";
import {
  forgerelayAgentsDir,
  forgerelaySkillsDir,
  generateInstanceId,
  loadForgeRelayFiles,
  type ForgeRelayUserConfig,
} from "./user-config.js";
import type { LanguageServerConfigInput } from "../../lsp/language-server-config.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TASK_REMINDER_INTERVAL = 30;

export interface ServerConfig {
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
  toolMode: ToolMode;
  workflowInstructions: string | false | undefined;
  appendInstructions: string | undefined;
  widgets: WidgetMode;
  activityPanelExpanded: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  taskReminderInterval: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  configSkillsDir: string;
  configAgentsDir: string;
  subagents: boolean;
  languageServers: LanguageServerConfigInput;
  agentDir: string;
  systemInstructionsPath: string;
  hooks: HookConfig;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
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

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseLoggingConfig(env: NodeJS.ProcessEnv, trustProxyDefault: boolean): LoggingConfig {
  const format = parseLogFormat(productEnv(env, "LOG_FORMAT"));
  const requests = productEnv(env, "LOG_REQUESTS");
  const toolCalls = productEnv(env, "LOG_TOOL_CALLS");
  const shellCommands = productEnv(env, "LOG_SHELL_COMMANDS");
  const trustProxy = productEnv(env, "TRUST_PROXY");
  return {
    level: parseLogLevel(productEnv(env, "LOG_LEVEL")),
    format,
    requests: requests === undefined ? format === "json" : parseBoolean(requests),
    assets: parseBoolean(productEnv(env, "LOG_ASSETS")),
    toolCalls: toolCalls === undefined ? true : parseBoolean(toolCalls),
    shellCommands: shellCommands === undefined ? format === "pretty" : parseBoolean(shellCommands),
    trustProxy: trustProxy === undefined ? trustProxyDefault : parseBoolean(trustProxy),
  };
}

function shouldTrustOneProxyByDefault(host: string, publicBaseUrl: string): boolean {
  return isLoopbackHost(host) && !isLoopbackHost(new URL(publicBaseUrl).hostname);
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
  env: NodeJS.ProcessEnv,
  fileConfig: ForgeRelayUserConfig,
  host: string,
  port: number,
): PublicDeploymentConfig {
  const localBaseUrls = [parsePublicBaseUrl(localPublicBaseUrl(host, port))];
  const envBaseUrl = productEnv(env, "PUBLIC_BASE_URL");
  const baseUrls = envBaseUrl !== undefined
    ? parsePublicBaseUrls(envBaseUrl, localBaseUrls)
    : parsePublicBaseUrls(fileConfig.publicBaseUrl, localBaseUrls);
  return {
    baseUrls,
    canonicalBaseUrl: baseUrls[0],
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadForgeRelayFiles(env);
  const instanceId = files.auth.instanceId?.trim() || generateInstanceId();
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicDeployment = resolvePublicDeployment(env, files.config, host, port);
  const publicBaseUrl = publicDeployment.canonicalBaseUrl;
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    ...publicDeployment.baseUrls.map((baseUrl) => new URL(baseUrl).hostname),
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    instanceId,
    configDir: files.dir,
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(productEnv(env, "ALLOWED_ROOTS") ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(productEnv(env, "ALLOWED_HOSTS"), derivedAllowedHosts),
    publicBaseUrl,
    publicBaseUrls: publicDeployment.baseUrls,
    toolMode: parseToolMode(env),
    workflowInstructions: parseWorkflowInstructions(
      productEnv(env, "WORKFLOW_INSTRUCTIONS"),
      files.config.workflowInstructions,
    ),
    appendInstructions: parseAppendInstructions(
      productEnv(env, "APPEND_INSTRUCTIONS"),
      files.config.appendInstructions,
    ),
    widgets: parseWidgetMode(productEnv(env, "WIDGETS")),
    activityPanelExpanded:
      productEnv(env, "ACTIVITY_PANEL_EXPANDED") === undefined
        ? files.config.activityPanelExpanded === true
        : parseBoolean(productEnv(env, "ACTIVITY_PANEL_EXPANDED")),
    stateDir: resolve(expandHomePath(productEnv(env, "STATE_DIR") ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(productEnv(env, "WORKTREE_ROOT") ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    artifactsEnabled:
      productEnv(env, "ARTIFACTS") === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(productEnv(env, "ARTIFACTS")),
    artifactMaxFileBytes: parsePositiveInteger(
      productEnv(env, "ARTIFACT_MAX_FILE_BYTES") ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "FORGERELAY_ARTIFACT_MAX_FILE_BYTES",
    ),
    taskReminderInterval: parseNonNegativeInteger(
      productEnv(env, "TASK_REMINDER_INTERVAL") ?? numberConfigValue(files.config.taskReminderInterval),
      DEFAULT_TASK_REMINDER_INTERVAL,
      "FORGERELAY_TASK_REMINDER_INTERVAL",
    ),
    skillsEnabled: productEnv(env, "SKILLS") === undefined ? true : parseBoolean(productEnv(env, "SKILLS")),
    skillPaths: parsePathList(productEnv(env, "SKILL_PATHS")),
    configSkillsDir: forgerelaySkillsDir(env),
    configAgentsDir: forgerelayAgentsDir(env),
    subagents:
      productEnv(env, "SUBAGENTS") === undefined
        ? files.config.subagents === true
        : parseBoolean(productEnv(env, "SUBAGENTS")),
    languageServers: files.config.languageServers ?? {},
    agentDir: resolve(expandHomePath(productEnv(env, "AGENT_DIR") ?? files.config.agentDir ?? defaultAgentDir())),
    systemInstructionsPath: parseSystemInstructionsPath(
      productEnv(env, "SYSTEM_INSTRUCTIONS_PATH") ?? files.config.systemInstructionsPath,
    ),
    hooks: mergeHookConfigs(
      parseHookConfig(files.config.hooks),
      parseHookConfig(files.hooks),
      files.hookFiles,
    ),
    logging: parseLoggingConfig(env, shouldTrustOneProxyByDefault(host, publicBaseUrl)),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
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
