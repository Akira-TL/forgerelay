import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../../../workspaces/state/project-context.js";
import {
  BUILTIN_LANGUAGE_SERVER_DEFINITIONS,
  languageServersConfigDefinition,
  type LanguageServerDefinitionInput,
} from "../definition/language-servers.js";
import { resolveConfigDomain } from "./resolver.js";
import type { ConfigScope } from "../definition/types.js";
import type { ConfigSourceInput, ResolvedConfigDomain } from "./types.js";

const CANONICAL_PRIORITY = 100;
const LEGACY_PRIORITY = 0;
const LEGACY_DEPRECATION = {
  since: "1.2.0",
  removeIn: "1.4.0",
  replacement: "language-servers.json",
} as const;

export interface ResolveLanguageServersConfigInput {
  configDir?: string;
  project?: Pick<ProjectContext, "sharedConfigDir" | "localConfigDir">;
  projectSharedConfigDir?: string;
  legacyUser?: Record<string, LanguageServerDefinitionInput & { enabled?: boolean }>;
  environment?: NodeJS.ProcessEnv;
}

export interface EffectiveLanguageServerConfigEntry {
  id: string;
  value: LanguageServerDefinitionInput;
  scope: ConfigScope;
}

export async function resolveLanguageServersConfig(
  input: ResolveLanguageServersConfigInput,
): Promise<ResolvedConfigDomain> {
  const sources: ConfigSourceInput[] = [];
  if (input.legacyUser && Object.keys(input.legacyUser).length > 0) {
    sources.push({
      id: "legacy:user:languageServers",
      scope: "user",
      kind: "file",
      priority: LEGACY_PRIORITY,
      ...(input.configDir ? { location: join(input.configDir, "config.json") } : {}),
      value: normalizeLanguageServerDefinitions(input.legacyUser),
      deprecation: LEGACY_DEPRECATION,
    });
  }
  if (input.configDir) {
    const user = await readLanguageServerSource(
      "canonical:user:language-servers",
      "user",
      join(input.configDir, "language-servers.json"),
    );
    if (user) sources.push(user);
  }
  const sharedConfigDir = input.project?.sharedConfigDir ?? input.projectSharedConfigDir;
  if (sharedConfigDir) {
    const shared = await readLanguageServerSource(
      "canonical:project:language-servers",
      "project",
      join(sharedConfigDir, "language-servers.json"),
    );
    if (shared) sources.push(shared);
  }
  if (input.project) {
    const local = await readLanguageServerSource(
      "canonical:project-local:language-servers",
      "project-local",
      join(input.project.localConfigDir, "language-servers.json"),
    );
    if (local) sources.push(local);
  }
  return resolveConfigDomain({
    definition: languageServersConfigDefinition,
    sources,
    environment: input.environment,
  });
}

export function effectiveLanguageServerEntries(
  resolution: ResolvedConfigDomain,
): EffectiveLanguageServerConfigEntry[] {
  const servers = isRecord(resolution.values.servers) ? resolution.values.servers : {};
  return Object.entries(servers).map(([id, value]) => {
    const entry = resolution.entries[`servers.${id}`];
    if (!entry || !isRecord(value)) {
      throw new Error(`Language Server resolver produced an invalid entry for ${id}.`);
    }
    return {
      id,
      value: value as LanguageServerDefinitionInput,
      scope: entry.effective.source.scope,
    };
  });
}

async function readLanguageServerSource(
  id: string,
  scope: "user" | "project" | "project-local",
  location: string,
): Promise<ConfigSourceInput | undefined> {
  let raw: string;
  try {
    raw = await readFile(location, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    return invalidSource(id, scope, location, "Configuration source could not be read.");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return invalidSource(id, scope, location, "Configuration source is not valid JSON.");
  }
  return {
    id,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    value: isRecord(value) ? normalizeFileDefinitions(value) : value,
  };
}

function invalidSource(
  id: string,
  scope: "user" | "project" | "project-local",
  location: string,
  message: string,
): ConfigSourceInput {
  return {
    id,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    error: { code: "invalid_source", message },
  };
}

function normalizeFileDefinitions(value: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...definitions } = value;
  return {
    ...($schema === undefined ? {} : { $schema }),
    ...normalizeLanguageServerDefinitions(definitions),
  };
}

function normalizeLanguageServerDefinitions(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    if (!isRecord(raw)) return [id, raw];
    if (raw.disabled === true || raw.enabled === false) return [id, { disabled: true }];
    const { enabled: _enabled, disabled: _disabled, ...rest } = raw;
    const builtin = BUILTIN_LANGUAGE_SERVER_DEFINITIONS[id];
    if (!builtin) return [id, rest];
    return [id, {
      ...builtin,
      ...rest,
      env: { ...(builtin.env ?? {}), ...(isRecord(rest.env) ? rest.env : {}) },
      languageIdByExtension: {
        ...(builtin.languageIdByExtension ?? {}),
        ...(isRecord(rest.languageIdByExtension) ? rest.languageIdByExtension : {}),
      },
    }];
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
