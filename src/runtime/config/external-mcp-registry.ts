import { join, resolve } from "node:path";
import type { ProjectContext } from "../../workspaces/state/project-context.js";
import { externalMcpConfigDefinition } from "./definition/external-mcp.js";
import {
  parseExternalMcpServers,
  parseExternalMcpStandaloneConfig,
  type ExternalMcpServerConfig,
  type ExternalMcpServersConfig,
} from "./external-mcp-config.js";
import { refreshLegacyUserConfigField } from "./resolution/project-sources.js";
import { resolveConfigDomain } from "./resolution/resolver.js";
import type {
  ConfigDiagnostic,
  ConfigSourceInput,
  ResolvedConfigDomain,
} from "./resolution/types.js";
import { ConfigSourceRuntime } from "./runtime/source-refresh.js";
import { projectExecutionRequirement, type ProjectExecutionRequirement } from "../security/project-execution-trust.js";

export type ExternalMcpConfigSource = "legacy" | "global" | "project" | "project-local";

export interface ExternalMcpConfigDiagnostic {
  source: ExternalMcpConfigSource;
  path: string;
  severity: "error" | "warning";
  code: "invalid_source" | "missing_environment" | "deprecated_source" | "schema_mismatch";
  message: string;
}

export interface ExternalMcpConfigSourceStatus {
  source: ExternalMcpConfigSource;
  path: string;
  state: "missing" | "valid" | "invalid";
  usingLastKnownGood: boolean;
}

export interface ExternalMcpRegistrySnapshot {
  servers: ExternalMcpServersConfig;
  origins: Record<string, ExternalMcpConfigSource>;
  executionRequirements: Record<string, ProjectExecutionRequirement>;
  masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">>;
  sources: ExternalMcpConfigSourceStatus[];
  diagnostics: ExternalMcpConfigDiagnostic[];
}

export interface ExternalMcpRegistryOptions {
  configDir: string;
  environment?: NodeJS.ProcessEnv;
  sourceRuntime?: ConfigSourceRuntime;
  onDiagnostic?: (diagnostic: ExternalMcpConfigDiagnostic) => void;
}

interface DynamicSourceSnapshot {
  value?: unknown;
  hasLastKnownGood: boolean;
  status: ExternalMcpConfigSourceStatus;
  diagnosticChanged: boolean;
  diagnostic?: ExternalMcpConfigDiagnostic;
}

const CANONICAL_PRIORITY = 100;
const LEGACY_PRIORITY = 0;
const MAX_DIAGNOSTIC_LENGTH = 320;
const LEGACY_DEPRECATION = {
  since: "1.2.0",
  removeIn: "1.4.0",
  replacement: "mcp.json",
} as const;

export class ExternalMcpConfigRegistry {
  private readonly configDir: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly sourceRuntime: ConfigSourceRuntime;
  private readonly onDiagnostic?: ExternalMcpRegistryOptions["onDiagnostic"];

  constructor(options: ExternalMcpRegistryOptions) {
    this.configDir = resolve(options.configDir);
    this.environment = options.environment ?? process.env;
    this.sourceRuntime = options.sourceRuntime ?? new ConfigSourceRuntime();
    this.onDiagnostic = options.onDiagnostic;
  }

  resolve(project: Pick<ProjectContext, "id" | "projectRoot" | "sharedConfigDir" | "localConfigDir">): ExternalMcpRegistrySnapshot {
    const dynamicSources = this.projectSources(project.sharedConfigDir, project.localConfigDir);
    return this.composeSnapshot(dynamicSources, this.composeResolution(dynamicSources), project.id);
  }

  resolveGlobal(): ExternalMcpRegistrySnapshot {
    const dynamicSources = this.projectSources();
    return this.composeSnapshot(dynamicSources, this.composeResolution(dynamicSources));
  }

  /** Internal Config v2 inspection seam. Resolved values may contain secrets; callers must use provenance for display. */
  resolveConfiguration(input: { projectSharedConfigDir?: string; projectLocalConfigDir?: string } = {}): ResolvedConfigDomain {
    const dynamicSources = this.projectSources(input.projectSharedConfigDir, input.projectLocalConfigDir);
    return this.composeResolution(dynamicSources);
  }

  private projectSources(projectSharedConfigDir?: string, projectLocalConfigDir?: string): DynamicSourceSnapshot[] {
    return [
      this.loadCanonicalSource("global", "user", join(this.configDir, "mcp.json")),
      ...(projectSharedConfigDir
        ? [this.loadCanonicalSource("project", "project", join(projectSharedConfigDir, "mcp.json"))]
        : []),
      ...(projectLocalConfigDir
        ? [this.loadCanonicalSource("project-local", "project-local", join(projectLocalConfigDir, "mcp.json"))]
        : []),
    ];
  }

  private composeResolution(dynamicSources: DynamicSourceSnapshot[]): ResolvedConfigDomain {
    const sourceInputs: ConfigSourceInput[] = [];
    const legacy = this.loadLegacyInlineSource();
    if (legacy.source) sourceInputs.push(legacy.source);
    for (const dynamic of dynamicSources) {
      const input = dynamicSourceInput(dynamic);
      if (input) sourceInputs.push(input);
    }

    const resolution = resolveConfigDomain({
      definition: externalMcpConfigDefinition,
      sources: sourceInputs,
      environment: this.environment,
    });
    if (legacy.diagnostic) resolution.diagnostics.push(legacy.diagnostic);
    for (const dynamic of dynamicSources) {
      if (!dynamic.diagnostic || !dynamic.status.usingLastKnownGood) continue;
      const source = dynamic.status.source;
      if (source === "legacy") continue;
      resolution.diagnostics.push({
        severity: "error",
        code: dynamic.diagnostic.code,
        source: {
          id: sourceId(source),
          scope: scopeForSource(source),
          kind: "file",
          location: dynamic.status.path,
          priority: CANONICAL_PRIORITY,
        },
        message: dynamic.diagnostic.message,
        usingLastKnownGood: true,
        diagnosticChanged: dynamic.diagnosticChanged,
      });
    }
    return resolution;
  }

  private composeSnapshot(
    dynamicSources: DynamicSourceSnapshot[],
    resolution: ResolvedConfigDomain,
    projectId?: string,
  ): ExternalMcpRegistrySnapshot {
    const normalized = normalizeResolvedServers(resolution);
    const origins: Record<string, ExternalMcpConfigSource> = {};
    const executionRequirements: Record<string, ProjectExecutionRequirement> = {};
    const masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">> = {};
    for (const [entryName, entry] of Object.entries(resolution.entries)) {
      if (!entryName.startsWith("servers.")) continue;
      const name = entryName.slice("servers.".length);
      const source = sourceFromId(entry.effective.source.id);
      if (entry.tombstone) {
        if (source !== "legacy") masked[name] = source;
      } else if (name in normalized) {
        origins[name] = source;
        const requirement = projectId ? projectExecutionRequirement({
          projectId, resolution, entryKey: entryName,
          display: { kind: "external-mcp", name },
        }) : undefined;
        if (requirement) executionRequirements[name] = requirement;
      }
    }

    const diagnostics = mergeDiagnostics(
      resolution.diagnostics.map(configDiagnostic),
      [],
    );
    return {
      servers: normalized,
      origins,
      executionRequirements,
      masked,
      sources: [
        {
          source: "legacy",
          path: join(this.configDir, "config.json"),
          state: "valid",
          usingLastKnownGood: false,
        },
        ...dynamicSources.map((source) => source.status),
      ],
      diagnostics,
    };
  }

  private loadLegacyInlineSource(): { source?: ConfigSourceInput; diagnostic?: ConfigDiagnostic } {
    const path = join(this.configDir, "config.json");
    const refreshed = refreshLegacyUserConfigField({
      sourceRuntime: this.sourceRuntime,
      configDir: this.configDir,
      field: "mcpServers",
      parse: (value) => value === undefined ? undefined : parseExternalMcpServers(value),
      invalidMessage: "Legacy inline External MCP configuration is invalid.",
    });
    if (refreshed.status.state === "missing") return {};
    const source = refreshed.value === undefined ? undefined : {
      id: "legacy:user:mcpServers",
      scope: "user" as const,
      kind: "file" as const,
      location: path,
      priority: LEGACY_PRIORITY,
      value: { servers: refreshed.value },
      deprecation: LEGACY_DEPRECATION,
    };
    if (refreshed.status.state !== "invalid" || !refreshed.issue) return source ? { source } : {};
    if (refreshed.issueScope === "container") return source ? { source } : {};
    const diagnostic: ConfigDiagnostic = {
      severity: "error",
      code: refreshed.issue.code,
      source: source ? {
        id: source.id,
        scope: source.scope,
        kind: source.kind,
        ...(source.location ? { location: source.location } : {}),
        priority: source.priority,
      } : {
        id: "legacy:user:mcpServers",
        scope: "user",
        kind: "file",
        location: path,
        priority: LEGACY_PRIORITY,
      },
      message: refreshed.issue.message,
      usingLastKnownGood: refreshed.status.usingLastKnownGood,
      diagnosticChanged: refreshed.status.diagnosticChanged,
    };
    if (refreshed.status.diagnosticChanged) this.onDiagnostic?.(configDiagnostic(diagnostic));
    if (source) return { source, diagnostic };
    return {
      source: {
        id: "legacy:user:mcpServers",
        scope: "user",
        kind: "file",
        location: path,
        priority: LEGACY_PRIORITY,
        deprecation: LEGACY_DEPRECATION,
        error: { code: refreshed.issue.code, message: refreshed.issue.message },
      },
    };
  }

  private loadCanonicalSource(
    source: Exclude<ExternalMcpConfigSource, "legacy">,
    scope: "user" | "project" | "project-local",
    path: string,
  ): DynamicSourceSnapshot {
    const refreshed = this.sourceRuntime.refreshFile<unknown>({
      key: `external-mcp:${source}:${path}`,
      path,
      parse: (content) => JSON.parse(content) as unknown,
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
          definition: externalMcpConfigDefinition,
          sources: [canonicalSourceInput(source, scope, path, value)],
          environment: this.environment,
        });
        const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        if (!error) return undefined;
        return {
          code: error.code === "missing_environment" ? "missing_environment" : "invalid_source",
          message: error.message,
        };
      },
    });
    const diagnostic = refreshed.status.state === "invalid" && refreshed.issue
      ? {
          source,
          path,
          severity: "error" as const,
          code: refreshed.issue.code,
          message: boundedDiagnosticMessage(refreshed.issue.message),
        }
      : undefined;
    if (diagnostic && refreshed.status.diagnosticChanged) this.onDiagnostic?.(diagnostic);
    return {
      ...(refreshed.value !== undefined ? { value: refreshed.value } : {}),
      hasLastKnownGood: refreshed.status.usingLastKnownGood || refreshed.status.state === "valid",
      status: {
        source,
        path,
        state: refreshed.status.state,
        usingLastKnownGood: refreshed.status.usingLastKnownGood,
      },
      diagnosticChanged: refreshed.status.diagnosticChanged,
      ...(diagnostic ? { diagnostic } : {}),
    };
  }
}

function dynamicSourceInput(source: DynamicSourceSnapshot): ConfigSourceInput | undefined {
  if (source.status.state === "missing") return undefined;
  const dynamicSource = source.status.source;
  if (dynamicSource === "legacy") throw new Error("Legacy External MCP configuration cannot be a dynamic source.");
  const scope = scopeForSource(dynamicSource);
  if (source.value) {
    return canonicalSourceInput(dynamicSource, scope, source.status.path, source.value);
  }
  return {
    id: sourceId(dynamicSource),
    scope,
    kind: "file",
    location: source.status.path,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    error: {
      code: source.diagnostic?.code === "missing_environment" ? "missing_environment" : "invalid_source",
      message: source.diagnostic?.message ?? "External MCP configuration is invalid.",
    },
  };
}

function canonicalSourceInput(
  source: Exclude<ExternalMcpConfigSource, "legacy">,
  scope: "user" | "project" | "project-local",
  path: string,
  value: unknown,
): ConfigSourceInput {
  return {
    id: sourceId(source),
    scope,
    kind: "file",
    location: path,
    priority: CANONICAL_PRIORITY,
    shadowsLowerPriority: true,
    value,
  };
}

function sourceId(source: Exclude<ExternalMcpConfigSource, "legacy">): string {
  return source === "global" ? "canonical:user:mcp" : `canonical:${source}:mcp`;
}

function sourceFromId(id: string): ExternalMcpConfigSource {
  if (id === "legacy:user:mcpServers") return "legacy";
  if (id === "canonical:user:mcp") return "global";
  if (id === "canonical:project:mcp") return "project";
  if (id === "canonical:project-local:mcp") return "project-local";
  throw new Error(`Unknown External MCP resolver source: ${id}`);
}

function scopeForSource(
  source: Exclude<ExternalMcpConfigSource, "legacy">,
): "user" | "project" | "project-local" {
  if (source === "global") return "user";
  return source;
}

function normalizeResolvedServers(resolution: ResolvedConfigDomain): ExternalMcpServersConfig {
  const raw = resolution.values.servers;
  if (raw === undefined) return {};
  const parsed = parseExternalMcpStandaloneConfig({ servers: raw });
  return Object.fromEntries(
    Object.entries(parsed)
      .filter((entry): entry is [string, ExternalMcpServerConfig] => !("disabled" in entry[1] && entry[1].disabled === true)),
  );
}

function configDiagnostic(diagnostic: ConfigDiagnostic): ExternalMcpConfigDiagnostic {
  return {
    source: sourceFromId(diagnostic.source.id),
    path: diagnostic.source.location ?? diagnostic.source.id,
    severity: diagnostic.severity === "error" ? "error" : "warning",
    code: diagnostic.code,
    message: boundedDiagnosticMessage(diagnostic.message),
  };
}

function mergeDiagnostics(
  left: ExternalMcpConfigDiagnostic[],
  right: ExternalMcpConfigDiagnostic[],
): ExternalMcpConfigDiagnostic[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((diagnostic) => {
    const key = `${diagnostic.source}\0${diagnostic.path}\0${diagnostic.code}\0${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedDiagnosticMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim() || "Invalid External MCP configuration.";
  return normalized.length <= MAX_DIAGNOSTIC_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "UNKNOWN";
}
