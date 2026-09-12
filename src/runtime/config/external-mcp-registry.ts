import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectContext } from "../../workspaces/state/project-context.js";
import { externalMcpConfigDefinition } from "./definition/external-mcp.js";
import {
  parseExternalMcpStandaloneConfig,
  type ExternalMcpServerConfig,
  type ExternalMcpServersConfig,
  type ExternalMcpStandaloneServersConfig,
} from "./external-mcp-config.js";
import { resolveConfigDomain } from "./resolution/resolver.js";
import type {
  ConfigDiagnostic,
  ConfigSourceInput,
  ResolvedConfigDomain,
} from "./resolution/types.js";

export type ExternalMcpConfigSource = "legacy" | "global" | "project" | "project-local";

export interface ExternalMcpConfigDiagnostic {
  source: ExternalMcpConfigSource;
  path: string;
  severity: "error" | "warning";
  code: "invalid_source" | "missing_environment" | "deprecated_source";
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
  masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">>;
  sources: ExternalMcpConfigSourceStatus[];
  diagnostics: ExternalMcpConfigDiagnostic[];
}

export interface ExternalMcpRegistryOptions {
  configDir: string;
  legacyServers?: ExternalMcpServersConfig;
  environment?: NodeJS.ProcessEnv;
  onDiagnostic?: (diagnostic: ExternalMcpConfigDiagnostic) => void;
}

interface DynamicSourceSnapshot {
  observedFingerprint: string;
  value?: Record<string, unknown>;
  hasLastKnownGood: boolean;
  status: ExternalMcpConfigSourceStatus;
  diagnostic?: ExternalMcpConfigDiagnostic;
}

const MISSING_FINGERPRINT = "missing";
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
  private readonly legacyServers: ExternalMcpServersConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly onDiagnostic?: ExternalMcpRegistryOptions["onDiagnostic"];
  private readonly sourceSnapshots = new Map<string, DynamicSourceSnapshot>();

  constructor(options: ExternalMcpRegistryOptions) {
    this.configDir = resolve(options.configDir);
    this.legacyServers = { ...(options.legacyServers ?? {}) };
    this.environment = options.environment ?? process.env;
    this.onDiagnostic = options.onDiagnostic;
  }

  resolve(project: Pick<ProjectContext, "id" | "projectRoot" | "sharedConfigDir" | "localConfigDir">): ExternalMcpRegistrySnapshot {
    const global = this.loadCanonicalSource("global", "user", join(this.configDir, "mcp.json"));
    const shared = this.loadCanonicalSource("project", "project", join(project.sharedConfigDir, "mcp.json"));
    const local = this.loadCanonicalSource(
      "project-local",
      "project-local",
      join(project.localConfigDir, "mcp.json"),
    );
    return this.composeSnapshot([global, shared, local]);
  }

  resolveGlobal(): ExternalMcpRegistrySnapshot {
    const global = this.loadCanonicalSource("global", "user", join(this.configDir, "mcp.json"));
    return this.composeSnapshot([global]);
  }

  private composeSnapshot(dynamicSources: DynamicSourceSnapshot[]): ExternalMcpRegistrySnapshot {
    const sourceInputs: ConfigSourceInput[] = [];
    if (Object.keys(this.legacyServers).length > 0) {
      sourceInputs.push({
        id: "legacy:user:mcpServers",
        scope: "user",
        kind: "file",
        location: join(this.configDir, "config.json"),
        priority: LEGACY_PRIORITY,
        value: { servers: this.legacyServers },
        deprecation: LEGACY_DEPRECATION,
      });
    }
    for (const dynamic of dynamicSources) {
      const input = dynamicSourceInput(dynamic);
      if (input) sourceInputs.push(input);
    }

    const resolution = resolveConfigDomain({
      definition: externalMcpConfigDefinition,
      sources: sourceInputs,
      environment: this.environment,
    });
    const normalized = normalizeResolvedServers(resolution);
    const origins: Record<string, ExternalMcpConfigSource> = {};
    const masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">> = {};
    for (const [entryName, entry] of Object.entries(resolution.entries)) {
      if (!entryName.startsWith("servers.")) continue;
      const name = entryName.slice("servers.".length);
      const source = sourceFromId(entry.effective.source.id);
      if (entry.tombstone) {
        if (source !== "legacy") masked[name] = source;
      } else if (name in normalized) {
        origins[name] = source;
      }
    }

    const diagnostics = mergeDiagnostics(
      resolution.diagnostics.map(configDiagnostic),
      dynamicSources.flatMap((source) => source.diagnostic ? [source.diagnostic] : []),
    );
    return {
      servers: normalized,
      origins,
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

  private loadCanonicalSource(
    source: Exclude<ExternalMcpConfigSource, "legacy">,
    scope: "user" | "project" | "project-local",
    path: string,
  ): DynamicSourceSnapshot {
    const cacheKey = `${source}\0${path}`;
    const previous = this.sourceSnapshots.get(cacheKey);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        if (previous?.observedFingerprint === MISSING_FINGERPRINT) return previous;
        const missing: DynamicSourceSnapshot = {
          observedFingerprint: MISSING_FINGERPRINT,
          hasLastKnownGood: false,
          status: {
            source,
            path,
            state: "missing",
            usingLastKnownGood: false,
          },
        };
        this.sourceSnapshots.set(cacheKey, missing);
        return missing;
      }
      const fingerprint = `read-error:${errorCode(error)}`;
      if (previous?.observedFingerprint === fingerprint) return previous;
      const invalid = this.invalidSource(source, path, fingerprint, previous, {
        code: "invalid_source",
        message: "Configuration source could not be read.",
      });
      this.sourceSnapshots.set(cacheKey, invalid);
      return invalid;
    }

    const fingerprint = createHash("sha256").update(content).digest("base64url");
    if (previous?.observedFingerprint === fingerprint) return previous;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      const invalid = this.invalidSource(source, path, fingerprint, previous, {
        code: "invalid_source",
        message: "Configuration source is not valid JSON.",
      });
      this.sourceSnapshots.set(cacheKey, invalid);
      return invalid;
    }

    const candidate = canonicalSourceInput(source, scope, path, parsed);
    const validation = resolveConfigDomain({
      definition: externalMcpConfigDefinition,
      sources: [candidate],
      environment: this.environment,
    });
    const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (error) {
      const invalid = this.invalidSource(source, path, fingerprint, previous, {
        code: error.code === "missing_environment" ? "missing_environment" : "invalid_source",
        message: error.message,
      });
      this.sourceSnapshots.set(cacheKey, invalid);
      return invalid;
    }

    const valid: DynamicSourceSnapshot = {
      observedFingerprint: fingerprint,
      value: parsed as Record<string, unknown>,
      hasLastKnownGood: true,
      status: {
        source,
        path,
        state: "valid",
        usingLastKnownGood: false,
      },
    };
    this.sourceSnapshots.set(cacheKey, valid);
    return valid;
  }

  private invalidSource(
    source: Exclude<ExternalMcpConfigSource, "legacy">,
    path: string,
    observedFingerprint: string,
    previous: DynamicSourceSnapshot | undefined,
    error: { code: "invalid_source" | "missing_environment"; message: string },
  ): DynamicSourceSnapshot {
    const diagnostic: ExternalMcpConfigDiagnostic = {
      source,
      path,
      severity: "error",
      code: error.code,
      message: boundedDiagnosticMessage(error.message),
    };
    this.onDiagnostic?.(diagnostic);
    return {
      observedFingerprint,
      ...(previous?.hasLastKnownGood && previous.value ? { value: previous.value } : {}),
      hasLastKnownGood: previous?.hasLastKnownGood === true && previous.value !== undefined,
      status: {
        source,
        path,
        state: "invalid",
        usingLastKnownGood: previous?.hasLastKnownGood === true && previous.value !== undefined,
      },
      diagnostic,
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
