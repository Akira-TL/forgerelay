import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type ServerConfig } from "../../runtime/config/config.js";
import {
  ExternalMcpCredentialStore,
  externalMcpCredentialIdentity,
  type ExternalMcpOAuthCredentialRecord,
} from "../../runtime/config/external-mcp-auth-store.js";
import {
  ExternalMcpConfigRegistry,
  type ExternalMcpConfigSource,
  type ExternalMcpConfigSourceStatus,
  type ExternalMcpRegistrySnapshot,
} from "../../runtime/config/external-mcp-registry.js";
import type { ExternalMcpServerConfig } from "../../runtime/config/external-mcp-config.js";

export type ExternalMcpCliScopeMode = "project" | "global";

export interface ExternalMcpScopeRequest {
  projectRoot?: string;
  global?: boolean;
}

export interface ExternalMcpScopeDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExternalMcpResolvedScope {
  mode: ExternalMcpCliScopeMode;
  projectRoot: string;
  projectSelection: "explicit" | "workspace-env" | "ancestor-config" | "cwd" | "global";
  config: ServerConfig;
  registry: ExternalMcpConfigRegistry;
  snapshot: ExternalMcpRegistrySnapshot;
  store: ExternalMcpCredentialStore;
}

export type ExternalMcpAuthKind = "oauth" | "static" | "config-managed" | "none-detected";
export type ExternalMcpAuthState =
  | "authenticated"
  | "auth-required"
  | "reauth-required"
  | "configured"
  | "not-detected";

export interface ExternalMcpServerStatus {
  name: string;
  source: ExternalMcpConfigSource;
  enabled: boolean;
  transport?: ExternalMcpServerConfig["transport"];
  authKind?: ExternalMcpAuthKind;
  authState?: ExternalMcpAuthState;
}

export interface ExternalMcpStatusSnapshot {
  scope: ExternalMcpResolvedScope;
  servers: ExternalMcpServerStatus[];
  configIssues: number;
  credentialStore: "missing" | "ok" | "invalid";
  credentialStoreMessage?: string;
}

export function resolveExternalMcpScope(
  request: ExternalMcpScopeRequest,
  dependencies: ExternalMcpScopeDependencies = {},
): ExternalMcpResolvedScope {
  if (request.global && request.projectRoot) {
    throw new Error("--global and --project cannot be used together.");
  }
  const env = dependencies.env ?? process.env;
  const config = loadConfig(env);
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const registry = new ExternalMcpConfigRegistry({
    configDir: config.configDir,
    legacyServers: config.mcpServers,
  });
  const store = new ExternalMcpCredentialStore({ configDir: config.configDir });

  if (request.global) {
    return {
      mode: "global",
      projectRoot: cwd,
      projectSelection: "global",
      config,
      registry,
      snapshot: registry.resolveGlobal(),
      store,
    };
  }

  const selected = selectProjectRoot(request.projectRoot, cwd, env);
  return {
    mode: "project",
    projectRoot: selected.root,
    projectSelection: selected.selection,
    config,
    registry,
    snapshot: registry.resolve(selected.root),
    store,
  };
}

export function inspectExternalMcpStatus(scope: ExternalMcpResolvedScope): ExternalMcpStatusSnapshot {
  let credentialStore: ExternalMcpStatusSnapshot["credentialStore"] = "missing";
  let credentialStoreMessage: string | undefined;
  try {
    credentialStore = scope.store.inspect().exists ? "ok" : "missing";
  } catch (error) {
    credentialStore = "invalid";
    credentialStoreMessage = boundedStatusMessage(error);
  }

  const effective = Object.entries(scope.snapshot.servers).map(([name, config]) => {
    const source = scope.snapshot.origins[name];
    return serverStatus(scope, name, source, config, credentialStore === "invalid");
  });
  const disabled = Object.entries(scope.snapshot.masked).map(([name, source]) => ({
    name,
    source,
    enabled: false,
  } satisfies ExternalMcpServerStatus));
  const servers = [...effective, ...disabled].sort((left, right) => left.name.localeCompare(right.name));

  return {
    scope,
    servers,
    configIssues: scope.snapshot.sources.filter((source) => source.state === "invalid").length
      + (credentialStore === "invalid" ? 1 : 0),
    credentialStore,
    ...(credentialStoreMessage ? { credentialStoreMessage } : {}),
  };
}

export function findExternalMcpServerStatus(
  status: ExternalMcpStatusSnapshot,
  name: string,
): ExternalMcpServerStatus | undefined {
  return status.servers.find((server) => server.name === name);
}

export function formatExternalMcpList(status: ExternalMcpStatusSnapshot): string {
  const lines = ["External MCP", ""];
  if (status.scope.mode === "global") {
    lines.push("Scope: global");
  } else {
    lines.push("Scope: project", `Project: ${status.scope.projectRoot}`);
  }
  lines.push("", "Config:");
  for (const source of status.scope.snapshot.sources) {
    lines.push(`  ${source.source.padEnd(7)} ${source.path} · ${formatConfigSourceState(source, status)}`);
  }
  if (status.credentialStore === "invalid") {
    lines.push(`  auth    ${status.scope.store.filePath} · invalid`);
    if (status.credentialStoreMessage) lines.push(`          ${status.credentialStoreMessage}`);
  } else {
    lines.push(`  auth    ${status.scope.store.filePath} · ${status.credentialStore}`);
  }

  lines.push("", "Servers:");
  if (status.servers.length === 0) {
    lines.push("  none");
  } else {
    for (const server of status.servers) {
      lines.push(`  ${server.name}`);
      lines.push(`    source: ${server.source}`);
      if (!server.enabled) {
        lines.push("    status: disabled");
        continue;
      }
      lines.push(`    transport: ${server.transport}`);
      lines.push(`    auth: ${formatAuth(server)}`);
      lines.push("    status: configured");
    }
  }

  if (status.scope.snapshot.diagnostics.length > 0) {
    lines.push("", "Config issues:");
    for (const diagnostic of status.scope.snapshot.diagnostics) {
      const source = status.scope.snapshot.sources.find((candidate) => candidate.source === diagnostic.source);
      lines.push(`  ${diagnostic.source}: ${diagnostic.message}`);
      if (source?.usingLastKnownGood) {
        lines.push("    Using this process's last-known-good configuration.");
      } else {
        lines.push("    Existing ForgeRelay runtimes that loaded a valid version may continue using last-known-good configuration.");
      }
    }
  }
  return lines.join("\n");
}

export function formatExternalMcpDoctor(status: ExternalMcpStatusSnapshot): string {
  const enabled = status.servers.filter((server) => server.enabled);
  const disabled = status.servers.length - enabled.length;
  const authenticated = enabled.filter((server) => server.authState === "authenticated").length;
  const authRequired = enabled.filter((server) => server.authState === "auth-required").length;
  const reauthRequired = enabled.filter((server) => server.authState === "reauth-required").length;
  const sourceSummary = status.scope.snapshot.sources
    .map((source) => `${source.source}=${compactSourceState(source, status)}`)
    .join(" · ");
  return [
    "External MCP:",
    `  Scope: ${status.scope.mode}${status.scope.mode === "project" ? ` (${status.scope.projectRoot})` : ""}`,
    `  Config: ${sourceSummary}`,
    `  Effective servers: ${enabled.length}`,
    `  Disabled: ${disabled}`,
    `  OAuth authenticated: ${authenticated}`,
    `  Auth required: ${authRequired}`,
    `  Reauthorization required: ${reauthRequired}`,
    `  Credential store: ${status.credentialStore}`,
    `  Config issues: ${status.configIssues}`,
    "  Hot reload: active",
    "  Active checks: not run (use `forgerelay mcp test <server>`)",
  ].join("\n");
}

export function formatAuth(status: ExternalMcpServerStatus): string {
  switch (status.authKind) {
    case "oauth":
      if (status.authState === "authenticated") return "oauth · authenticated";
      if (status.authState === "auth-required") return "oauth · auth required";
      if (status.authState === "reauth-required") return "oauth · reauthorization required";
      return "oauth · not authenticated";
    case "static":
      return "static · configured";
    case "config-managed":
      return "config-managed";
    case "none-detected":
    default:
      return "none detected";
  }
}

function serverStatus(
  scope: ExternalMcpResolvedScope,
  name: string,
  source: ExternalMcpConfigSource,
  config: ExternalMcpServerConfig,
  credentialStoreInvalid: boolean,
): ExternalMcpServerStatus {
  if (config.transport === "stdio") {
    return {
      name,
      source,
      enabled: true,
      transport: config.transport,
      authKind: "config-managed",
      authState: "configured",
    };
  }
  if (hasStaticAuthorizationHeader(config.headers)) {
    return {
      name,
      source,
      enabled: true,
      transport: config.transport,
      authKind: "static",
      authState: "configured",
    };
  }
  if (credentialStoreInvalid) {
    return {
      name,
      source,
      enabled: true,
      transport: config.transport,
      authKind: config.oauth ? "oauth" : "none-detected",
      authState: "not-detected",
    };
  }

  const identity = externalMcpCredentialIdentity(source, name, scope.projectRoot);
  let record: ExternalMcpOAuthCredentialRecord | undefined;
  try {
    record = scope.store.read(identity);
  } catch {
    record = undefined;
  }
  const bindingMismatch = record ? !credentialBindingMatches(record, config.url) : false;
  const authState: ExternalMcpAuthState = bindingMismatch
    ? "reauth-required"
    : record?.reauthorization?.reason === "authorization_required" && !record.tokens?.access_token
      ? "auth-required"
      : record?.reauthorization
        ? "reauth-required"
        : record?.tokens?.access_token
          ? "authenticated"
          : "not-detected";
  const authKind: ExternalMcpAuthKind = record || config.oauth ? "oauth" : "none-detected";
  return {
    name,
    source,
    enabled: true,
    transport: config.transport,
    authKind,
    authState,
  };
}

function credentialBindingMatches(record: ExternalMcpOAuthCredentialRecord, serverUrl: string): boolean {
  try {
    if (new URL(record.serverUrl).toString() !== new URL(serverUrl).toString()) return false;
  } catch {
    return false;
  }
  const expectedIssuer = record.discoveryState?.authorizationServerMetadata?.issuer
    ?? record.authorizationServerUrl
    ?? record.discoveryState?.authorizationServerUrl;
  if (!expectedIssuer) return true;
  for (const candidate of [record.tokens?.issuer, record.clientInformation?.issuer]) {
    if (candidate && candidate !== expectedIssuer) return false;
  }
  return true;
}

function selectProjectRoot(
  explicit: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { root: string; selection: ExternalMcpResolvedScope["projectSelection"] } {
  if (explicit) return { root: resolve(explicit), selection: "explicit" };
  if (env.FORGERELAY_WORKSPACE_ROOT) {
    return { root: resolve(env.FORGERELAY_WORKSPACE_ROOT), selection: "workspace-env" };
  }
  const ancestor = findNearestProjectConfig(cwd);
  if (ancestor) return { root: ancestor, selection: "ancestor-config" };
  return { root: cwd, selection: "cwd" };
}

function findNearestProjectConfig(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".forgerelay", "mcp.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function hasStaticAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function formatConfigSourceState(
  source: ExternalMcpConfigSourceStatus,
  status: ExternalMcpStatusSnapshot,
): string {
  if (source.source === "legacy") {
    const legacyCount = status.servers.filter((server) => server.enabled && server.source === "legacy").length;
    return legacyCount > 0 ? `compatibility · ${legacyCount} server${legacyCount === 1 ? "" : "s"}` : "compatibility · none";
  }
  if (source.state === "valid") return "ok";
  if (source.state === "missing") return "missing";
  return source.usingLastKnownGood ? "invalid · using last-known-good" : "invalid";
}

function compactSourceState(
  source: ExternalMcpConfigSourceStatus,
  status: ExternalMcpStatusSnapshot,
): string {
  if (source.source === "legacy") {
    return status.servers.some((server) => server.enabled && server.source === "legacy") ? "compat" : "none";
  }
  if (source.state === "valid") return "ok";
  if (source.state === "missing") return "missing";
  return source.usingLastKnownGood ? "invalid/lkg" : "invalid";
}

function boundedStatusMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim() || "External MCP status unavailable.";
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 317)}...`;
}
