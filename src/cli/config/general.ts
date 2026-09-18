import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  forgerelayConfigDir,
  loadForgeRelayFiles,
  writeConfigJsonFile,
  writeForgeRelayConfig,
  type ForgeRelayUserConfig,
} from "../../runtime/config/user-config.js";
import { parseConfigSource } from "../../runtime/config/definition/definition.js";
import { generalConfigDefinition } from "../../runtime/config/definition/general-config.js";
import { resolveGeneralConfig } from "../../runtime/config/resolution/general.js";
import { readJsonConfigSource } from "../../runtime/config/resolution/project-sources.js";
import { assertConfigResolutionValid } from "../../runtime/config/resolution/resolver.js";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";
import { normalizeOptionalPublicBaseUrl } from "../setup-support.js";
import { parseConfigScopeArgs, type ConfigCliScope } from "./scope.js";
import type { ResolvedConfigDomain } from "../../runtime/config/resolution/types.js";

export function renderGeneralConfigHelp(): string {
  return [
    "ForgeRelay config",
    "",
    "Usage:",
    "  forgerelay config get [--project <path>|--global]",
    "  forgerelay config set <logical-path> <value> [--project <path>|--global]",
    "  forgerelay config unset <logical-path> [--project <path>|--global]",
    "  forgerelay config check [--project <path>|--global] [--json]",
    "  forgerelay config sources [--project <path>|--global] [--json]",
    "  forgerelay config explain <logical-path> [--project <path>|--global] [--json]",
    "  forgerelay config migrate [--dry-run] [--project <path>|--global]",
    "  forgerelay config context <get|set|unset|check|sources|explain> ...",
    "  forgerelay config <mcp|hooks|lsp|subagents> <get|set|unset|remove|check|sources|explain> ...",
  ].join("\n");
}

export async function runGeneralConfigGet(args: readonly string[]): Promise<void> {
  const parsed = parseConfigScopeArgs(args);
  if (parsed.rest.length > 0) throw new Error(`Unknown config get option: ${parsed.rest[0]}`);
  const resolution = await resolveGeneralConfigForScope(parsed.scope);
  assertConfigResolutionValid(resolution);
  console.log(JSON.stringify(resolution.values, null, 2));
}

export async function resolveGeneralConfigForScope(scope: ConfigCliScope): Promise<ResolvedConfigDomain> {
  const configDir = forgerelayConfigDir();
  const userSource = await readJsonConfigSource({
    id: "user:config",
    scope: "user",
    location: join(configDir, "config.json"),
  });
  const project = scope.mode === "project"
    ? await new ProjectContextResolver(configDir).inspect(scope.projectRoot)
    : undefined;
  const projectSource = project
    ? await readJsonConfigSource({
        id: "project:config",
        scope: "project",
        location: join(project.sharedConfigDir, "config.json"),
      })
    : undefined;
  const projectLocalSource = project?.localConfigDir
    ? await readJsonConfigSource({
        id: "project-local:config",
        scope: "project-local",
        location: join(project.localConfigDir, "config.json"),
      })
    : undefined;
  return resolveGeneralConfig({
    env: process.env,
    ...(userSource ? { userSource } : {}),
    ...(projectSource ? { projectSource } : {}),
    ...(projectLocalSource ? { projectLocalSource } : {}),
  });
}

export async function runGeneralConfigSet(args: readonly string[]): Promise<void> {
  const parsed = parseConfigScopeArgs(args);
  if (parsed.rest.length < 2) {
    throw new Error("Usage: forgerelay config set <logical-path> <value> [--project <path>|--global]");
  }
  const [logicalPath, ...valueParts] = parsed.rest;
  const path = generalPathSegments(logicalPath!);
  const rawValue = valueParts.join(" ").trim();
  if (!rawValue) throw new Error(`Missing value for ${logicalPath}.`);
  const target = await generalConfigWriteTarget(parsed.scope);
  const next = readGeneralConfigTarget(target);
  setNestedValue(next, path, coerceConfigValue(path, rawValue));
  console.log(`Updated ${writeGeneralConfigTarget(target, next)}`);
}

export async function runGeneralConfigUnset(args: readonly string[]): Promise<void> {
  const parsed = parseConfigScopeArgs(args);
  if (parsed.rest.length !== 1) {
    throw new Error("Usage: forgerelay config unset <logical-path> [--project <path>|--global]");
  }
  const path = generalPathSegments(parsed.rest[0]!);
  const target = await generalConfigWriteTarget(parsed.scope);
  const next = readGeneralConfigTarget(target);
  deleteNestedValue(next, path);
  console.log(`Updated ${writeGeneralConfigTarget(target, next)}`);
}

interface GeneralConfigWriteTarget {
  scope: "user" | "project";
  path: string;
}

async function generalConfigWriteTarget(scope: ReturnType<typeof parseConfigScopeArgs>["scope"]): Promise<GeneralConfigWriteTarget> {
  const configDir = forgerelayConfigDir();
  if (scope.mode === "global") {
    return { scope: "user", path: join(configDir, "config.json") };
  }
  const project = await new ProjectContextResolver(configDir).inspect(scope.projectRoot);
  return { scope: "project", path: join(project.sharedConfigDir, "config.json") };
}

function readGeneralConfigTarget(target: GeneralConfigWriteTarget): Record<string, unknown> {
  if (target.scope === "user") {
    return structuredClone(loadForgeRelayFiles().config) as Record<string, unknown>;
  }
  if (!existsSync(target.path)) return {};
  const parsed = JSON.parse(readFileSync(target.path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`General configuration must be a JSON object: ${target.path}`);
  return structuredClone(parsed);
}

function writeGeneralConfigTarget(target: GeneralConfigWriteTarget, value: Record<string, unknown>): string {
  if (target.scope === "user") {
    return writeForgeRelayConfig(value as ForgeRelayUserConfig);
  }
  const validated = parseConfigSource(
    generalConfigDefinition,
    "project",
    value,
  ) as Record<string, unknown>;
  mkdirSync(dirname(target.path), { recursive: true });
  writeConfigJsonFile(target.path, validated, 0o600);
  return target.path;
}

function generalPathSegments(logicalPath: string): string[] {
  const normalized = logicalPath.trim();
  const path = normalized.startsWith("config.") ? normalized.slice("config.".length) : normalized;
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error(`Invalid General Config logical path: ${logicalPath}.`);
  return segments;
}

function coerceConfigValue(path: readonly string[], rawValue: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(rawValue) as unknown;
  } catch {
    value = rawValue;
  }
  if (path.length === 1 && path[0] === "publicBaseUrl" && typeof value === "string") {
    return normalizeOptionalPublicBaseUrl(value);
  }
  return value;
}

function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error(`Cannot set config.${path.join(".")}: config.${segment} is not an object.`);
    }
    const next = existing ?? {};
    current[segment] = next;
    current = next as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function deleteNestedValue(target: Record<string, unknown>, path: readonly string[]): void {
  const parents: Array<{ object: Record<string, unknown>; key: string }> = [];
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const existing = current[segment];
    if (!isRecord(existing)) return;
    parents.push({ object: current, key: segment });
    current = existing;
  }
  delete current[path[path.length - 1]!];
  for (const parent of parents.reverse()) {
    const value = parent.object[parent.key];
    if (isRecord(value) && Object.keys(value).length === 0) delete parent.object[parent.key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
