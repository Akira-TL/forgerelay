import { join } from "node:path";
import type { ProjectContext } from "../../../workspaces/state/project-context.js";
import {
  hooksConfigDefinition,
  normalizeLegacyHookEntries,
  type HookEntriesConfig,
  type ResolvedHookEntryInput,
} from "../../../mcp/hooks/config.js";
import { ConfigSourceRuntime } from "../runtime/source-refresh.js";
import { resolveConfigDomain } from "./resolver.js";
import type { ConfigDiagnostic, ConfigSourceInput, ResolvedConfigDomain } from "./types.js";

const CANONICAL_PRIORITY = 100;
const LEGACY_PRIORITY = 0;
const LEGACY_DEPRECATION = {
  since: "1.2.0",
  removeIn: "1.4.0",
  replacement: "hooks/",
} as const;

type HookConfigScope = "user" | "project" | "project-local";

export interface ResolveHooksConfigInput {
  configDir?: string;
  project?: Pick<ProjectContext, "sharedConfigDir" | "localConfigDir">;
  projectSharedConfigDir?: string;
  legacyUser?: unknown;
  sourceRuntime?: ConfigSourceRuntime;
}

export interface EffectiveHookConfigEntry {
  name: string;
  scope: HookConfigScope;
  sourcePriority: number;
  sourceLocation?: string;
  entries: ResolvedHookEntryInput[];
}

export async function resolveHooksConfig(
  input: ResolveHooksConfigInput,
): Promise<ResolvedConfigDomain> {
  const sources: ConfigSourceInput[] = [];
  const refreshDiagnostics: ConfigDiagnostic[] = [];
  const sourceRuntime = input.sourceRuntime ?? new ConfigSourceRuntime();

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
    appendHookDirectory(
      sources,
      refreshDiagnostics,
      sourceRuntime,
      "user",
      join(input.configDir, "hooks"),
    );
  }

  const sharedConfigDir = input.project?.sharedConfigDir ?? input.projectSharedConfigDir;
  if (sharedConfigDir) {
    const legacyProject = readLegacyHookAggregate(
      sourceRuntime,
      "legacy:project:hooks.json",
      "project",
      join(sharedConfigDir, "hooks.json"),
    );
    if (legacyProject.source) sources.push(legacyProject.source);
    if (legacyProject.diagnostic) refreshDiagnostics.push(legacyProject.diagnostic);
    appendHookDirectory(
      sources,
      refreshDiagnostics,
      sourceRuntime,
      "project",
      join(sharedConfigDir, "hooks"),
    );
  }

  if (input.project) {
    appendHookDirectory(
      sources,
      refreshDiagnostics,
      sourceRuntime,
      "project-local",
      join(input.project.localConfigDir, "hooks"),
    );
  }

  const resolution = resolveConfigDomain({
    definition: hooksConfigDefinition,
    sources,
  });
  resolution.diagnostics = mergeDiagnostics(resolution.diagnostics, refreshDiagnostics);
  return resolution;
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

function appendHookDirectory(
  sources: ConfigSourceInput[],
  diagnostics: ConfigDiagnostic[],
  sourceRuntime: ConfigSourceRuntime,
  scope: HookConfigScope,
  directory: string,
): void {
  const refreshed = sourceRuntime.refreshDirectory<unknown>({
    key: `hooks:${scope}:${directory}`,
    directory,
    include: (name) => name.endsWith(".json"),
    parse: (_name, content) => JSON.parse(content) as unknown,
    parseIssue: {
      code: "invalid_source",
      message: "Hook configuration file is not valid JSON.",
    },
    readIssue: {
      code: "invalid_source",
      message: "Hook configuration file could not be read.",
    },
    validate: (value, name, location) => {
      const entryKey = name.slice(0, -5);
      const validation = resolveConfigDomain({
        definition: hooksConfigDefinition,
        sources: [canonicalHookSource(scope, location, entryKey, value)],
      });
      const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (!error) return undefined;
      return {
        code: error.code === "missing_environment" ? "missing_environment" : "invalid_source",
        message: error.message,
      };
    },
  });

  if (refreshed.state === "invalid" && refreshed.issue) {
    diagnostics.push({
      severity: "error",
      code: refreshed.issue.code,
      source: {
        id: `canonical:${scope}:hooks-directory`,
        scope,
        kind: "file",
        location: refreshed.directory,
        priority: CANONICAL_PRIORITY,
      },
      message: refreshed.issue.message,
      diagnosticChanged: refreshed.diagnosticChanged,
    });
  }

  for (const unit of refreshed.units) {
    const location = unit.status.path;
    const entryKey = unit.name.slice(0, -5);
    if (unit.value !== undefined) {
      const source = canonicalHookSource(scope, location, entryKey, unit.value);
      sources.push(source);
      if (unit.status.state === "invalid" && unit.issue) {
        diagnostics.push({
          severity: "error",
          code: unit.issue.code,
          source: sourceReference(source),
          message: unit.issue.message,
          usingLastKnownGood: true,
          diagnosticChanged: unit.status.diagnosticChanged,
        });
      }
      continue;
    }
    if (unit.status.state === "invalid") {
      sources.push(invalidHookSource(
        scope,
        location,
        entryKey,
        unit.issue?.message ?? "Hook configuration file is invalid.",
        unit.issue?.code,
      ));
    }
  }
}

function canonicalHookSource(
  scope: HookConfigScope,
  location: string,
  entryKey: string,
  value: unknown,
): ConfigSourceInput {
  return {
    id: `canonical:${scope}:hook:${entryKey}`,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    entryKey,
    shadowsLowerPriorityKeys: [`hooks.${entryKey}`],
    value,
  };
}

function invalidHookSource(
  scope: HookConfigScope,
  location: string,
  entryKey: string,
  message: string,
  code: "invalid_source" | "missing_environment" = "invalid_source",
): ConfigSourceInput {
  return {
    id: `canonical:${scope}:hook:${entryKey}`,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    entryKey,
    shadowsLowerPriorityKeys: [`hooks.${entryKey}`],
    error: { code, message },
  };
}

function readLegacyHookAggregate(
  sourceRuntime: ConfigSourceRuntime,
  id: string,
  scope: "user" | "project",
  location: string,
): { source?: ConfigSourceInput; diagnostic?: ConfigDiagnostic } {
  const refreshed = sourceRuntime.refreshFile<HookEntriesConfig>({
    key: `hooks:${id}:${location}`,
    path: location,
    parse: (raw) => normalizeLegacyHookEntries(JSON.parse(raw) as unknown),
    parseIssue: { code: "invalid_source", message: "Legacy Hook configuration is invalid." },
    readIssue: { code: "invalid_source", message: "Legacy Hook configuration could not be read." },
    validate: (value) => {
      const validation = resolveConfigDomain({
        definition: hooksConfigDefinition,
        sources: [legacyHookSource(id, scope, location, value)],
      });
      const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      return error ? { code: "invalid_source", message: error.message } : undefined;
    },
  });

  if (refreshed.status.state === "missing") return {};
  if (refreshed.value !== undefined) {
    const source = legacyHookSource(id, scope, location, refreshed.value);
    if (refreshed.status.state !== "invalid" || !refreshed.issue) return { source };
    return {
      source,
      diagnostic: {
        severity: "error",
        code: refreshed.issue.code,
        source: sourceReference(source),
        message: refreshed.issue.message,
        usingLastKnownGood: true,
        diagnosticChanged: refreshed.status.diagnosticChanged,
      },
    };
  }

  return {
    source: {
      id,
      scope,
      kind: "file",
      location,
      priority: LEGACY_PRIORITY,
      deprecation: LEGACY_DEPRECATION,
      error: {
        code: refreshed.issue?.code ?? "invalid_source",
        message: refreshed.issue?.message ?? "Legacy Hook configuration is invalid.",
      },
    },
  };
}

function legacyHookSource(
  id: string,
  scope: "user" | "project",
  location: string,
  value: HookEntriesConfig,
): ConfigSourceInput {
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
}

function sourceReference(source: ConfigSourceInput): ConfigDiagnostic["source"] {
  return {
    id: source.id,
    scope: source.scope,
    kind: source.kind,
    ...(source.location ? { location: source.location } : {}),
    priority: source.priority,
  };
}

function mergeDiagnostics(left: ConfigDiagnostic[], right: ConfigDiagnostic[]): ConfigDiagnostic[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((diagnostic) => {
    const key = `${diagnostic.source.id}\0${diagnostic.code}\0${diagnostic.message}\0${diagnostic.usingLastKnownGood === true}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
