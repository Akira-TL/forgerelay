import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfigSource } from "../../../runtime/config/definition/definition.js";
import { externalMcpConfigDefinition } from "../../../runtime/config/definition/external-mcp.js";
import { hooksConfigDefinition } from "../../../mcp/hooks/config.js";
import { languageServersConfigDefinition } from "../../../runtime/config/definition/language-servers.js";
import type { ConfigDomainDefinition, ConfigFileScope } from "../../../runtime/config/definition/types.js";
import { ExternalMcpConfigRegistry } from "../../../runtime/config/external-mcp-registry.js";
import { resolveHooksConfig } from "../../../runtime/config/resolution/hooks.js";
import { resolveLanguageServersConfig } from "../../../runtime/config/resolution/language-servers.js";
import { assertConfigResolutionValid } from "../../../runtime/config/resolution/resolver.js";
import type { ResolvedConfigDomain } from "../../../runtime/config/resolution/types.js";
import { ConfigSourceRuntime } from "../../../runtime/config/runtime/source-refresh.js";
import { forgerelayConfigDir, writeConfigJsonFile, writeConfigTextFile } from "../../../runtime/config/user-config.js";
import { ProjectContextResolver } from "../../../workspaces/state/project-context.js";
import {
  canonicalSubagentProfileDocument,
  canonicalSubagentProfileValueFromDocument,
  resolveSubagentProfilesConfigSources,
} from "../../../subagents/profiles.js";
import { runConfigInspection } from "../inspect.js";
import { parseConfigScopeArgs, type ConfigCliScope } from "../scope.js";

interface JsonDomainAdapter {
  cliName: "mcp" | "lsp";
  resolutionDomain: "mcp" | "language-servers";
  definition: ConfigDomainDefinition;
  fileName: string;
  rootField: string;
  diskShape: "object" | "keyed-root";
  resolve: (scope: ConfigCliScope) => Promise<ResolvedConfigDomain>;
}

const JSON_DOMAIN_ADAPTERS: Record<string, JsonDomainAdapter> = {
  mcp: {
    cliName: "mcp",
    resolutionDomain: "mcp",
    definition: externalMcpConfigDefinition,
    fileName: "mcp.json",
    rootField: "servers",
    diskShape: "object",
    resolve: resolveMcpConfiguration,
  },
  lsp: {
    cliName: "lsp",
    resolutionDomain: "language-servers",
    definition: languageServersConfigDefinition,
    fileName: "language-servers.json",
    rootField: "servers",
    diskShape: "keyed-root",
    resolve: resolveLanguageServerConfiguration,
  },
};

export async function runConfigDomainCommand(domain: string, args: readonly string[]): Promise<boolean> {
  const adapter = JSON_DOMAIN_ADAPTERS[domain];
  if (adapter) {
    await runJsonDomainCommand(adapter, args);
    return true;
  }
  if (domain === "hooks") {
    if (args[0] === "list" || args[0] === "help" || args[0] === "--help" || args[0] === "-h" || args[0] === undefined) {
      return false;
    }
    await runHookDomainCommand(args);
    return true;
  }
  if (domain === "subagents") {
    await runSubagentDomainCommand(args);
    return true;
  }
  return false;
}

async function runHookDomainCommand(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "check" || command === "sources" || command === "explain") {
    process.exitCode = await runDomainInspection("hooks", "hooks", command, rest);
    return;
  }
  if (command === "get") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config hooks get hooks.<name> [scope]");
    const resolution = await resolveHookConfiguration(parsed.scope);
    printConfiguredEntry(resolution, normalizeDomainLogicalPath("hooks", "hooks", parsed.rest[0]!));
    return;
  }
  if (command === "set") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length < 2) throw new Error("Usage: forgerelay config hooks set hooks.<name>[.<field>] <value> [scope]");
    const [logicalPath, ...valueParts] = parsed.rest;
    const segments = domainLogicalSegments("hooks", "hooks", logicalPath!);
    const name = safeResourceName(segments[1] ?? "");
    const target = await domainWriteTarget(parsed.scope, join("hooks", `${name}.json`));
    const rawValue = valueParts.join(" ").trim();
    if (!rawValue) throw new Error(`Missing value for ${logicalPath}.`);
    const candidate = segments.length === 2
      ? coerceConfigValue(rawValue)
      : mutateExistingJson(target.path, segments.slice(2), coerceConfigValue(rawValue), "set");
    if (!isRecord(candidate)) throw new Error(`hooks.${name} must be a JSON object.`);
    writeHookTarget(target, name, candidate);
    return;
  }
  if (command === "unset") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config hooks unset hooks.<name>.<field> [scope]");
    const segments = domainLogicalSegments("hooks", "hooks", parsed.rest[0]!);
    if (segments.length < 3) throw new Error("Use `config hooks remove <name>` to delete a complete Hook.");
    const name = safeResourceName(segments[1]!);
    const target = await domainWriteTarget(parsed.scope, join("hooks", `${name}.json`));
    const candidate = mutateExistingJson(target.path, segments.slice(2), undefined, "unset");
    writeHookTarget(target, name, candidate);
    return;
  }
  if (command === "remove") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config hooks remove <name> [scope]");
    const name = safeResourceName(parsed.rest[0]!);
    const target = await domainWriteTarget(parsed.scope, join("hooks", `${name}.json`));
    rmSync(target.path, { force: true });
    console.log(`Removed ${target.path}`);
    return;
  }
  throw new Error(`Unknown config hooks command: ${command ?? ""}`);
}

async function runSubagentDomainCommand(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "check" || command === "sources" || command === "explain") {
    process.exitCode = await runDomainInspection("subagents", "profiles", command, rest);
    return;
  }
  if (command === "get") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config subagents get profiles.<name> [scope]");
    const resolution = await resolveSubagentConfiguration(parsed.scope);
    printConfiguredEntry(resolution, normalizeDomainLogicalPath("subagents", "profiles", parsed.rest[0]!));
    return;
  }
  if (command === "set") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length < 2) throw new Error("Usage: forgerelay config subagents set profiles.<name>[.<field>] <value> [scope]");
    const [logicalPath, ...valueParts] = parsed.rest;
    const segments = domainLogicalSegments("subagents", "profiles", logicalPath!);
    const name = safeResourceName(segments[1] ?? "");
    const target = await domainWriteTarget(parsed.scope, join("subagents", `${name}.md`));
    const rawValue = valueParts.join(" ").trim();
    if (!rawValue) throw new Error(`Missing value for ${logicalPath}.`);
    const candidate = segments.length === 2
      ? coerceConfigValue(rawValue)
      : mutateExistingSubagent(target.path, segments.slice(2), coerceConfigValue(rawValue), "set");
    writeSubagentTarget(target, name, candidate);
    return;
  }
  if (command === "unset") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config subagents unset profiles.<name>.<field> [scope]");
    const segments = domainLogicalSegments("subagents", "profiles", parsed.rest[0]!);
    if (segments.length < 3) throw new Error("Use `config subagents remove <name>` to delete a complete profile.");
    const name = safeResourceName(segments[1]!);
    const target = await domainWriteTarget(parsed.scope, join("subagents", `${name}.md`));
    const candidate = mutateExistingSubagent(target.path, segments.slice(2), undefined, "unset");
    writeSubagentTarget(target, name, candidate);
    return;
  }
  if (command === "remove") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) throw new Error("Usage: forgerelay config subagents remove <name> [scope]");
    const name = safeResourceName(parsed.rest[0]!);
    const target = await domainWriteTarget(parsed.scope, join("subagents", `${name}.md`));
    rmSync(target.path, { force: true });
    console.log(`Removed ${target.path}`);
    return;
  }
  throw new Error(`Unknown config subagents command: ${command ?? ""}`);
}

async function runJsonDomainCommand(adapter: JsonDomainAdapter, args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "check" || command === "sources" || command === "explain") {
    process.exitCode = await runDomainInspection(
      adapter.resolutionDomain,
      adapter.rootField,
      command,
      rest,
    );
    return;
  }
  if (command === "get") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) {
      throw new Error(`Usage: forgerelay config ${adapter.cliName} get <logical-path> [--project <path>|--global]`);
    }
    const logicalPath = normalizeDomainLogicalPath(adapter.resolutionDomain, adapter.rootField, parsed.rest[0]!);
    const resolution = await adapter.resolve(parsed.scope);
    printConfiguredEntry(resolution, logicalPath);
    return;
  }
  if (command === "set") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length < 2) {
      throw new Error(`Usage: forgerelay config ${adapter.cliName} set <logical-path> <value> [--project <path>|--global]`);
    }
    const [logicalPath, ...valueParts] = parsed.rest;
    const path = storagePathSegments(adapter, logicalPath!);
    const rawValue = valueParts.join(" ").trim();
    if (!rawValue) throw new Error(`Missing value for ${logicalPath}.`);
    const target = await domainWriteTarget(parsed.scope, adapter.fileName);
    const next = readJsonObject(target.path, domainFallback(adapter));
    setNestedValue(next, path, coerceConfigValue(rawValue));
    writeJsonDomainTarget(adapter, target, next);
    return;
  }
  if (command === "unset") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) {
      throw new Error(`Usage: forgerelay config ${adapter.cliName} unset <logical-path> [--project <path>|--global]`);
    }
    const target = await domainWriteTarget(parsed.scope, adapter.fileName);
    const next = readJsonObject(target.path, domainFallback(adapter));
    deleteNestedValue(next, storagePathSegments(adapter, parsed.rest[0]!));
    writeJsonDomainTarget(adapter, target, next);
    return;
  }
  if (command === "remove") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) {
      throw new Error(`Usage: forgerelay config ${adapter.cliName} remove <name> [--project <path>|--global]`);
    }
    const target = await domainWriteTarget(parsed.scope, adapter.fileName);
    const next = readJsonObject(target.path, domainFallback(adapter));
    const resourcePath = adapter.diskShape === "keyed-root"
      ? [parsed.rest[0]!]
      : [adapter.rootField, parsed.rest[0]!];
    deleteNestedValue(next, resourcePath);
    writeJsonDomainTarget(adapter, target, next);
    return;
  }
  throw new Error(`Unknown config ${adapter.cliName} command: ${command ?? ""}`);
}

async function runDomainInspection(
  domain: string,
  rootField: string,
  command: "check" | "sources" | "explain",
  args: readonly string[],
): Promise<number> {
  const inspectionArgs = command === "explain"
    ? [command, ...normalizeDomainExplainArgs(domain, rootField, args)]
    : [command, ...args];
  return runConfigInspection(inspectionArgs, domain);
}

function printConfiguredEntry(resolution: ResolvedConfigDomain, logicalPath: string): void {
  assertConfigResolutionValid(resolution);
  const entry = Object.values(resolution.entries).find((candidate) => candidate.logicalPath === logicalPath);
  if (!entry || entry.tombstone) throw new Error(`Unknown configuration logical path: ${logicalPath}.`);
  console.log(JSON.stringify(entry.effective.configuredValue, null, 2));
}

async function resolveMcpConfiguration(scope: ConfigCliScope): Promise<ResolvedConfigDomain> {
  const configDir = forgerelayConfigDir();
  const registry = new ExternalMcpConfigRegistry({ configDir, environment: process.env });
  if (scope.mode === "global") return registry.resolveConfiguration();
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return registry.resolveConfiguration({
    projectSharedConfigDir: project.sharedConfigDir,
    ...(project.localConfigDir ? { projectLocalConfigDir: project.localConfigDir } : {}),
  });
}

async function resolveHookConfiguration(scope: ConfigCliScope): Promise<ResolvedConfigDomain> {
  const configDir = forgerelayConfigDir();
  if (scope.mode === "global") return resolveHooksConfig({ configDir });
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return resolveHooksConfig({
    configDir,
    ...(project.localConfigDir
      ? { project: { sharedConfigDir: project.sharedConfigDir, localConfigDir: project.localConfigDir } }
      : { projectSharedConfigDir: project.sharedConfigDir }),
  });
}

async function resolveSubagentConfiguration(scope: ConfigCliScope): Promise<ResolvedConfigDomain> {
  const configDir = forgerelayConfigDir();
  const sourceRuntime = new ConfigSourceRuntime();
  if (scope.mode === "global") {
    return resolveSubagentProfilesConfigSources({ configDir, sourceRuntime });
  }
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return resolveSubagentProfilesConfigSources({
    configDir,
    sourceRuntime,
    projectSharedConfigDir: project.sharedConfigDir,
    ...(project.localConfigDir ? { projectLocalConfigDir: project.localConfigDir } : {}),
  });
}

async function resolveLanguageServerConfiguration(scope: ConfigCliScope): Promise<ResolvedConfigDomain> {
  const configDir = forgerelayConfigDir();
  if (scope.mode === "global") {
    return resolveLanguageServersConfig({ configDir, environment: process.env });
  }
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return resolveLanguageServersConfig({
    configDir,
    environment: process.env,
    ...(project.localConfigDir
      ? { project: { sharedConfigDir: project.sharedConfigDir, localConfigDir: project.localConfigDir } }
      : { projectSharedConfigDir: project.sharedConfigDir }),
  });
}

function writeJsonDomainTarget(
  adapter: JsonDomainAdapter,
  target: DomainWriteTarget,
  value: Record<string, unknown>,
): void {
  const validated = parseConfigSource(adapter.definition, target.scope, value);
  const diskValue = adapter.diskShape === "keyed-root" ? value : validated;
  mkdirSync(dirname(target.path), { recursive: true });
  writeConfigJsonFile(target.path, diskValue, 0o600);
  console.log(`Updated ${target.path}`);
}

function writeHookTarget(target: DomainWriteTarget, name: string, value: Record<string, unknown>): void {
  parseConfigSource(hooksConfigDefinition, target.scope, value, name);
  mkdirSync(dirname(target.path), { recursive: true });
  writeConfigJsonFile(target.path, value, 0o600);
  console.log(`Updated ${target.path}`);
}

function writeSubagentTarget(target: DomainWriteTarget, name: string, value: unknown): void {
  const document = canonicalSubagentProfileDocument(name, value);
  mkdirSync(dirname(target.path), { recursive: true });
  writeConfigTextFile(target.path, document, 0o600);
  console.log(`Updated ${target.path}`);
}

function mutateExistingJson(
  path: string,
  nestedPath: readonly string[],
  value: unknown,
  action: "set" | "unset",
): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`Configuration resource does not exist: ${path}`);
  const next = readJsonObject(path, {});
  if (action === "set") setNestedValue(next, nestedPath, value);
  else deleteNestedValue(next, nestedPath);
  return next;
}

function mutateExistingSubagent(
  path: string,
  nestedPath: readonly string[],
  value: unknown,
  action: "set" | "unset",
): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`Subagent Profile does not exist: ${path}`);
  const current = canonicalSubagentProfileValueFromDocument(readFileSync(path, "utf8"), path);
  if (!isRecord(current)) throw new Error(`Subagent Profile is not editable: ${path}`);
  const next = structuredClone(current);
  if (action === "set") setNestedValue(next, nestedPath, value);
  else deleteNestedValue(next, nestedPath);
  return next;
}

interface DomainWriteTarget {
  scope: Extract<ConfigFileScope, "user" | "project">;
  path: string;
}

async function domainWriteTarget(scope: ConfigCliScope, fileName: string): Promise<DomainWriteTarget> {
  const configDir = forgerelayConfigDir();
  if (scope.mode === "global") return { scope: "user", path: join(configDir, fileName) };
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return { scope: "project", path: join(project.sharedConfigDir, fileName) };
}

function domainFallback(adapter: JsonDomainAdapter): Record<string, unknown> {
  return adapter.diskShape === "keyed-root" ? {} : { [adapter.rootField]: {} };
}

function readJsonObject(path: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!existsSync(path)) return structuredClone(fallback);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`Configuration source must be a JSON object: ${path}`);
  return structuredClone(parsed);
}

function safeResourceName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid configuration resource name: ${value}.`);
  }
  return name;
}

function storagePathSegments(adapter: JsonDomainAdapter, logicalPath: string): string[] {
  const segments = domainLogicalSegments(adapter.resolutionDomain, adapter.rootField, logicalPath);
  if (segments[0] !== adapter.rootField || segments.length < 2) {
    throw new Error(`${adapter.cliName} logical paths must start with ${adapter.rootField}.<name>.`);
  }
  return adapter.diskShape === "keyed-root" ? segments.slice(1) : segments;
}

function domainLogicalSegments(domain: string, rootField: string, logicalPath: string): string[] {
  const normalized = normalizeDomainLogicalPath(domain, rootField, logicalPath);
  return normalized.slice(`${domain}.`.length).split(".").filter(Boolean);
}

function normalizeDomainLogicalPath(domain: string, rootField: string, logicalPath: string): string {
  const normalized = logicalPath.trim();
  if (!normalized) throw new Error(`Invalid ${domain} logical path: ${logicalPath}.`);
  const fullyQualifiedRoot = `${domain}.${rootField}`;
  if (normalized === fullyQualifiedRoot || normalized.startsWith(`${fullyQualifiedRoot}.`)) return normalized;
  return `${domain}.${normalized}`;
}

function normalizeDomainExplainArgs(domain: string, rootField: string, args: readonly string[]): string[] {
  const normalized: string[] = [];
  let logicalPathSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--project") {
      normalized.push(arg);
      const project = args[index + 1];
      if (project !== undefined) {
        normalized.push(project);
        index += 1;
      }
      continue;
    }
    if (arg === "--global" || arg === "--json") {
      normalized.push(arg);
      continue;
    }
    if (!logicalPathSeen) {
      normalized.push(normalizeDomainLogicalPath(domain, rootField, arg));
      logicalPathSeen = true;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function coerceConfigValue(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    return rawValue;
  }
}

function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error(`Cannot set ${path.join(".")}: ${segment} is not an object.`);
    }
    const next = existing ?? {};
    current[segment] = next;
    current = next as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function deleteNestedValue(target: Record<string, unknown>, path: readonly string[]): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) return;
    current = existing;
  }
  delete current[path[path.length - 1]!];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
