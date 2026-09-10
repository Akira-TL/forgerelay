import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseExternalMcpStandaloneConfig,
  type ExternalMcpServerConfig,
  type ExternalMcpServersConfig,
  type ExternalMcpStandaloneServersConfig,
} from "./external-mcp-config.js";

export type ExternalMcpConfigSource = "legacy" | "global" | "project";

export interface ExternalMcpConfigDiagnostic {
  source: Exclude<ExternalMcpConfigSource, "legacy">;
  path: string;
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
  onDiagnostic?: (diagnostic: ExternalMcpConfigDiagnostic) => void;
}

interface DynamicSourceSnapshot {
  observedFingerprint: string;
  entries: ExternalMcpStandaloneServersConfig;
  hasLastKnownGood: boolean;
  status: ExternalMcpConfigSourceStatus;
  diagnostic?: ExternalMcpConfigDiagnostic;
}

const MISSING_FINGERPRINT = "missing";
const MAX_DIAGNOSTIC_LENGTH = 320;

export class ExternalMcpConfigRegistry {
  private readonly configDir: string;
  private readonly legacyServers: ExternalMcpServersConfig;
  private readonly onDiagnostic?: ExternalMcpRegistryOptions["onDiagnostic"];
  private global?: DynamicSourceSnapshot;
  private readonly projects = new Map<string, DynamicSourceSnapshot>();

  constructor(options: ExternalMcpRegistryOptions) {
    this.configDir = resolve(options.configDir);
    this.legacyServers = { ...(options.legacyServers ?? {}) };
    this.onDiagnostic = options.onDiagnostic;
  }

  resolve(workspaceRoot: string): ExternalMcpRegistrySnapshot {
    const projectRoot = resolve(workspaceRoot);
    const globalPath = join(this.configDir, "mcp.json");
    const projectPath = join(projectRoot, ".forgerelay", "mcp.json");
    this.global = this.loadDynamicSource("global", globalPath, this.global);
    const project = this.loadDynamicSource("project", projectPath, this.projects.get(projectRoot));
    this.projects.set(projectRoot, project);

    const servers: ExternalMcpServersConfig = { ...this.legacyServers };
    const origins: Record<string, ExternalMcpConfigSource> = Object.fromEntries(
      Object.keys(this.legacyServers).map((name) => [name, "legacy" as const]),
    );
    const masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">> = {};

    applySource(servers, origins, masked, this.global.entries, "global");
    applySource(servers, origins, masked, project.entries, "project");

    const diagnostics = [this.global.diagnostic, project.diagnostic]
      .filter((entry): entry is ExternalMcpConfigDiagnostic => entry !== undefined);
    return {
      servers,
      origins,
      masked,
      sources: [
        {
          source: "legacy",
          path: join(this.configDir, "config.json"),
          state: "valid",
          usingLastKnownGood: false,
        },
        this.global.status,
        project.status,
      ],
      diagnostics,
    };
  }

  private loadDynamicSource(
    source: Exclude<ExternalMcpConfigSource, "legacy">,
    path: string,
    previous: DynamicSourceSnapshot | undefined,
  ): DynamicSourceSnapshot {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        if (previous?.observedFingerprint === MISSING_FINGERPRINT) return previous;
        return {
          observedFingerprint: MISSING_FINGERPRINT,
          entries: {},
          hasLastKnownGood: true,
          status: {
            source,
            path,
            state: "missing",
            usingLastKnownGood: false,
          },
        };
      }
      const fingerprint = `read-error:${errorCode(error)}`;
      if (previous?.observedFingerprint === fingerprint) return previous;
      return this.invalidSource(source, path, fingerprint, previous, error);
    }

    const fingerprint = createHash("sha256").update(content).digest("base64url");
    if (previous?.observedFingerprint === fingerprint) return previous;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      return this.invalidSource(
        source,
        path,
        fingerprint,
        previous,
        new Error("Invalid JSON syntax."),
      );
    }
    try {
      const entries = parseExternalMcpStandaloneConfig(parsed);
      return {
        observedFingerprint: fingerprint,
        entries,
        hasLastKnownGood: true,
        status: {
          source,
          path,
          state: "valid",
          usingLastKnownGood: false,
        },
      };
    } catch (error) {
      return this.invalidSource(source, path, fingerprint, previous, error);
    }
  }

  private invalidSource(
    source: Exclude<ExternalMcpConfigSource, "legacy">,
    path: string,
    observedFingerprint: string,
    previous: DynamicSourceSnapshot | undefined,
    error: unknown,
  ): DynamicSourceSnapshot {
    const diagnostic: ExternalMcpConfigDiagnostic = {
      source,
      path,
      message: boundedDiagnosticMessage(error),
    };
    this.onDiagnostic?.(diagnostic);
    return {
      observedFingerprint,
      entries: previous?.entries ?? {},
      hasLastKnownGood: previous?.hasLastKnownGood ?? false,
      status: {
        source,
        path,
        state: "invalid",
        usingLastKnownGood: previous?.hasLastKnownGood === true,
      },
      diagnostic,
    };
  }
}

function applySource(
  servers: ExternalMcpServersConfig,
  origins: Record<string, ExternalMcpConfigSource>,
  masked: Record<string, Exclude<ExternalMcpConfigSource, "legacy">>,
  entries: ExternalMcpStandaloneServersConfig,
  source: Exclude<ExternalMcpConfigSource, "legacy">,
): void {
  for (const [name, entry] of Object.entries(entries)) {
    if ("disabled" in entry && entry.disabled === true) {
      delete servers[name];
      delete origins[name];
      masked[name] = source;
      continue;
    }
    servers[name] = entry as ExternalMcpServerConfig;
    origins[name] = source;
    delete masked[name];
  }
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
