import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../../../workspaces/state/project-context.js";
import {
  hooksConfigDefinition,
  normalizeLegacyHookEntries,
  type ResolvedHookEntryInput,
} from "../../../mcp/hooks/config.js";
import { resolveConfigDomain } from "./resolver.js";
import type { ConfigSourceInput, ResolvedConfigDomain } from "./types.js";

const CANONICAL_PRIORITY = 100;
const LEGACY_PRIORITY = 0;
const LEGACY_DEPRECATION = {
  since: "1.2.0",
  removeIn: "1.4.0",
  replacement: "hooks/",
} as const;

export interface ResolveHooksConfigInput {
  configDir?: string;
  project?: Pick<ProjectContext, "sharedConfigDir" | "localConfigDir">;
  projectSharedConfigDir?: string;
  legacyUser?: unknown;
}

export interface EffectiveHookConfigEntry {
  name: string;
  scope: "user" | "project" | "project-local";
  sourcePriority: number;
  sourceLocation?: string;
  entries: ResolvedHookEntryInput[];
}

export async function resolveHooksConfig(
  input: ResolveHooksConfigInput,
): Promise<ResolvedConfigDomain> {
  const sources: ConfigSourceInput[] = [];
  if (input.legacyUser && isRecord(input.legacyUser) && Object.keys(input.legacyUser).length > 0) {
    sources.push({
      id: "legacy:user:hooks",
      scope: "user",
      kind: "file",
      priority: LEGACY_PRIORITY,
      ...(input.configDir ? { location: join(input.configDir, "config.json/hooks") } : {}),
      normalized: true,
      deprecation: LEGACY_DEPRECATION,
      value: { hooks: normalizeLegacyHookEntries(input.legacyUser) },
    });
  }
  if (input.configDir) {
    sources.push(...await loadHookDirectory("user", join(input.configDir, "hooks")));
  }
  const sharedConfigDir = input.project?.sharedConfigDir ?? input.projectSharedConfigDir;
  if (sharedConfigDir) {
    const legacyProject = await readLegacyHookAggregate(
      "legacy:project:hooks.json",
      "project",
      join(sharedConfigDir, "hooks.json"),
    );
    if (legacyProject) sources.push(legacyProject);
    sources.push(...await loadHookDirectory("project", join(sharedConfigDir, "hooks")));
  }
  if (input.project) {
    sources.push(...await loadHookDirectory("project-local", join(input.project.localConfigDir, "hooks")));
  }
  return resolveConfigDomain({
    definition: hooksConfigDefinition,
    sources,
  });
}

export function effectiveHookConfigEntries(
  resolution: ResolvedConfigDomain,
): EffectiveHookConfigEntry[] {
  const hooks = isRecord(resolution.values.hooks) ? resolution.values.hooks : {};
  const entries = Object.entries(hooks).flatMap(([name, value]) => {
    const provenance = resolution.entries[`hooks.${name}`];
    if (!provenance || !Array.isArray(value)) return [];
    const scope = provenance.effective.source.scope;
    if (scope !== "user" && scope !== "project" && scope !== "project-local") return [];
    return [{
      name,
      scope,
      sourcePriority: provenance.effective.source.priority,
      ...(provenance.effective.source.location ? { sourceLocation: provenance.effective.source.location } : {}),
      entries: value as ResolvedHookEntryInput[],
    }];
  });
  return entries.sort((left, right) => {
    const scope = hookScopeRank(left.scope) - hookScopeRank(right.scope);
    if (scope !== 0) return scope;
    const priority = left.sourcePriority - right.sourcePriority;
    if (priority !== 0) return priority;
    const leftOrder = left.entries[0]?.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.entries[0]?.order ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const location = (left.sourceLocation ?? "").localeCompare(right.sourceLocation ?? "");
    return location !== 0 ? location : left.name.localeCompare(right.name);
  });
}

function hookScopeRank(scope: EffectiveHookConfigEntry["scope"]): number {
  return scope === "user" ? 0 : scope === "project" ? 1 : 2;
}

async function loadHookDirectory(
  scope: "user" | "project" | "project-local",
  directory: string,
): Promise<ConfigSourceInput[]> {
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return [];
    return [{
      id: `canonical:${scope}:hooks-directory`,
      scope,
      kind: "file",
      location: directory,
      priority: CANONICAL_PRIORITY,
      error: {
        code: "invalid_source",
        message: "Hook configuration directory could not be read.",
      },
    }];
  }

  const sources: ConfigSourceInput[] = [];
  for (const entry of entries) {
    const location = join(directory, entry.name);
    const entryKey = entry.name.slice(0, -5);
    let raw: string;
    try {
      raw = await readFile(location, "utf8");
    } catch {
      sources.push(invalidHookSource(scope, location, entryKey, "Hook configuration file could not be read."));
      continue;
    }

    try {
      sources.push({
        id: `canonical:${scope}:hook:${entryKey}`,
        scope,
        kind: "file",
        location,
        priority: CANONICAL_PRIORITY,
        entryKey,
        shadowsLowerPriorityKeys: [`hooks.${entryKey}`],
        value: JSON.parse(raw) as unknown,
      });
    } catch {
      sources.push(invalidHookSource(scope, location, entryKey, "Hook configuration file is not valid JSON."));
    }
  }
  return sources;
}

function invalidHookSource(
  scope: "user" | "project" | "project-local",
  location: string,
  entryKey: string,
  message: string,
): ConfigSourceInput {
  return {
    id: `canonical:${scope}:hook:${entryKey}`,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    entryKey,
    shadowsLowerPriorityKeys: [`hooks.${entryKey}`],
    error: { code: "invalid_source", message },
  };
}

async function readLegacyHookAggregate(
  id: string,
  scope: "user" | "project",
  location: string,
): Promise<ConfigSourceInput | undefined> {
  let raw: string;
  try {
    raw = await readFile(location, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return undefined;
    return {
      id,
      scope,
      kind: "file",
      location,
      priority: LEGACY_PRIORITY,
      deprecation: LEGACY_DEPRECATION,
      error: { code: "invalid_source", message: "Legacy Hook configuration could not be read." },
    };
  }

  try {
    const value = normalizeLegacyHookEntries(JSON.parse(raw) as unknown);
    return {
      id,
      scope,
      kind: "file",
      location,
      priority: LEGACY_PRIORITY,
      normalized: true,
      deprecation: LEGACY_DEPRECATION,
      value: { hooks: value },
    };
  } catch {
    return {
      id,
      scope,
      kind: "file",
      location,
      priority: LEGACY_PRIORITY,
      deprecation: LEGACY_DEPRECATION,
      error: { code: "invalid_source", message: "Legacy Hook configuration is invalid." },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
