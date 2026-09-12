import { join } from "node:path";
import type { ProjectContext } from "../../../workspaces/state/project-context.js";
import {
  BUILTIN_LANGUAGE_SERVER_DEFINITIONS,
  languageServersConfigDefinition,
  type LanguageServerDefinitionInput,
} from "../definition/language-servers.js";
import { resolveConfigDomain } from "./resolver.js";
import type { ConfigScope } from "../definition/types.js";
import type { ConfigDiagnostic, ConfigSourceInput, ResolvedConfigDomain } from "./types.js";
import { ConfigSourceRuntime } from "../runtime/source-refresh.js";

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
  sourceRuntime?: ConfigSourceRuntime;
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
  const refreshDiagnostics: ConfigDiagnostic[] = [];
  const sourceRuntime = input.sourceRuntime ?? new ConfigSourceRuntime();
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
    const user = readLanguageServerSource(
      sourceRuntime,
      "canonical:user:language-servers",
      "user",
      join(input.configDir, "language-servers.json"),
      input.environment,
    );
    if (user.source) sources.push(user.source);
    if (user.diagnostic) refreshDiagnostics.push(user.diagnostic);
  }
  const sharedConfigDir = input.project?.sharedConfigDir ?? input.projectSharedConfigDir;
  if (sharedConfigDir) {
    const shared = readLanguageServerSource(
      sourceRuntime,
      "canonical:project:language-servers",
      "project",
      join(sharedConfigDir, "language-servers.json"),
      input.environment,
    );
    if (shared.source) sources.push(shared.source);
    if (shared.diagnostic) refreshDiagnostics.push(shared.diagnostic);
  }
  if (input.project) {
    const local = readLanguageServerSource(
      sourceRuntime,
      "canonical:project-local:language-servers",
      "project-local",
      join(input.project.localConfigDir, "language-servers.json"),
      input.environment,
    );
    if (local.source) sources.push(local.source);
    if (local.diagnostic) refreshDiagnostics.push(local.diagnostic);
  }
  const resolution = resolveConfigDomain({
    definition: languageServersConfigDefinition,
    sources,
    environment: input.environment,
  });
  resolution.diagnostics = mergeDiagnostics(resolution.diagnostics, refreshDiagnostics);
  return resolution;
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

function readLanguageServerSource(
  sourceRuntime: ConfigSourceRuntime,
  id: string,
  scope: "user" | "project" | "project-local",
  location: string,
  environment: NodeJS.ProcessEnv | undefined,
): { source?: ConfigSourceInput; diagnostic?: ConfigDiagnostic } {
  const refreshed = sourceRuntime.refreshFile<unknown>({
    key: `language-servers:${id}:${location}`,
    path: location,
    parse: (raw) => {
      const value = JSON.parse(raw) as unknown;
      return isRecord(value) ? normalizeFileDefinitions(value) : value;
    },
    parseIssue: {
      code: "invalid_source",
      message: "Configuration source is not valid JSON.",
    },
    readIssue: {
      code: "invalid_source",
      message: "Configuration source could not be read.",
    },
    validate: (value) => {
      const validation = resolveConfigDomain({
        definition: languageServersConfigDefinition,
        sources: [canonicalLanguageServerSource(id, scope, location, value)],
        environment,
      });
      const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (!error) return undefined;
      return {
        code: error.code === "missing_environment" ? "missing_environment" : "invalid_source",
        message: error.message,
      };
    },
  });
  if (refreshed.status.state === "missing") return {};
  if (refreshed.value !== undefined) {
    const source = canonicalLanguageServerSource(id, scope, location, refreshed.value);
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
  const source = invalidSource(
    id,
    scope,
    location,
    refreshed.issue?.message ?? "Language Server configuration is invalid.",
    refreshed.issue?.code,
  );
  return { source };
}

function canonicalLanguageServerSource(
  id: string,
  scope: "user" | "project" | "project-local",
  location: string,
  value: unknown,
): ConfigSourceInput {
  return {
    id,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    value,
  };
}

function invalidSource(
  id: string,
  scope: "user" | "project" | "project-local",
  location: string,
  message: string,
  code: "invalid_source" | "missing_environment" = "invalid_source",
): ConfigSourceInput {
  return {
    id,
    scope,
    kind: "file",
    location,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    error: { code, message },
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
