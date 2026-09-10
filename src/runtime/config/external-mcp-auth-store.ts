import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { withFileLock } from "../state/lock/file-lock.js";
import { forgerelayConfigDir } from "./user-config.js";

export type ExternalMcpCredentialIdentity =
  | { kind: "global"; server: string }
  | { kind: "project"; server: string; projectRoot: string };

export interface ExternalMcpOAuthCredentialRecord {
  identity: ExternalMcpCredentialIdentity;
  serverUrl: string;
  revision: string;
  updatedAt: string;
  tokens?: StoredOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  discoveryState?: OAuthDiscoveryState;
  authorizationServerUrl?: string;
  resourceUrl?: string;
  reauthorization?: {
    reason: "authorization_required" | "invalid_grant" | "insufficient_scope" | "binding_changed";
    observedAt: string;
    scope?: string;
  };
}

interface ExternalMcpAuthFile {
  version: 1;
  credentials: Record<string, ExternalMcpOAuthCredentialRecord>;
}

export interface ExternalMcpCredentialStoreOptions {
  configDir?: string;
  env?: NodeJS.ProcessEnv;
}

const AUTH_FILE_VERSION = 1;
const AUTH_FILE_NAME = "mcp-auth.json";

export class ExternalMcpCredentialStore {
  readonly configDir: string;
  readonly filePath: string;

  constructor(options: ExternalMcpCredentialStoreOptions = {}) {
    this.configDir = resolve(options.configDir ?? forgerelayConfigDir(options.env));
    this.filePath = join(this.configDir, AUTH_FILE_NAME);
  }

  read(identity: ExternalMcpCredentialIdentity): ExternalMcpOAuthCredentialRecord | undefined {
    const record = this.readFile().credentials[credentialKey(identity)];
    if (!record || !sameIdentity(record.identity, identity)) return undefined;
    return cloneRecord(record);
  }

  async replace(
    identity: ExternalMcpCredentialIdentity,
    serverUrl: string,
    record: Omit<ExternalMcpOAuthCredentialRecord, "identity" | "serverUrl" | "revision" | "updatedAt">,
  ): Promise<ExternalMcpOAuthCredentialRecord> {
    let written!: ExternalMcpOAuthCredentialRecord;
    await this.updateFile((file) => {
      written = {
        ...cloneRecord(record),
        identity: normalizeIdentity(identity),
        serverUrl,
        revision: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      file.credentials[credentialKey(identity)] = written;
    });
    return cloneRecord(written);
  }

  async update(
    identity: ExternalMcpCredentialIdentity,
    serverUrl: string,
    update: (
      current: ExternalMcpOAuthCredentialRecord | undefined,
    ) => Omit<ExternalMcpOAuthCredentialRecord, "identity" | "serverUrl" | "revision" | "updatedAt"> | undefined,
  ): Promise<ExternalMcpOAuthCredentialRecord | undefined> {
    let written: ExternalMcpOAuthCredentialRecord | undefined;
    await this.updateFile((file) => {
      const key = credentialKey(identity);
      const existing = file.credentials[key];
      const current = existing && sameIdentity(existing.identity, identity) ? cloneRecord(existing) : undefined;
      const next = update(current);
      if (!next) {
        delete file.credentials[key];
        written = undefined;
        return;
      }
      written = {
        ...cloneRecord(next),
        identity: normalizeIdentity(identity),
        serverUrl,
        revision: randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      file.credentials[key] = written;
    });
    return written ? cloneRecord(written) : undefined;
  }

  async remove(identity: ExternalMcpCredentialIdentity): Promise<boolean> {
    let removed = false;
    await this.updateFile((file) => {
      const key = credentialKey(identity);
      const existing = file.credentials[key];
      if (!existing || !sameIdentity(existing.identity, identity)) return;
      delete file.credentials[key];
      removed = true;
    });
    return removed;
  }

  withIdentityLock<T>(identity: ExternalMcpCredentialIdentity, operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.configDir, { recursive: true });
    return withFileLock(join(this.configDir, `.mcp-auth-${credentialKeyHash(identity)}.lock`), operation, {
      timeoutMs: 15_000,
      staleMs: 60_000,
      mode: 0o600,
    });
  }

  private readFile(): ExternalMcpAuthFile {
    if (!existsSync(this.filePath)) return emptyAuthFile();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      throw new Error(`Unable to read External MCP credential store ${this.filePath}: invalid JSON.`);
    }
    return parseAuthFile(raw, this.filePath);
  }

  private async updateFile(update: (file: ExternalMcpAuthFile) => void): Promise<void> {
    mkdirSync(this.configDir, { recursive: true });
    await withFileLock(`${this.filePath}.lock`, () => {
      const file = this.readFile();
      update(file);
      writePrivateJsonFile(this.filePath, file);
    }, { mode: 0o600 });
  }
}

export function externalMcpCredentialIdentity(
  source: "legacy" | "global" | "project",
  server: string,
  projectRoot: string,
): ExternalMcpCredentialIdentity {
  return source === "project"
    ? { kind: "project", server, projectRoot: resolve(projectRoot) }
    : { kind: "global", server };
}

export function credentialKey(identity: ExternalMcpCredentialIdentity): string {
  const normalized = normalizeIdentity(identity);
  return normalized.kind === "global"
    ? `global:${normalized.server}`
    : `project:${credentialKeyHash(normalized)}:${normalized.server}`;
}

function credentialKeyHash(identity: ExternalMcpCredentialIdentity): string {
  const normalized = normalizeIdentity(identity);
  const material = normalized.kind === "global"
    ? `global\0${normalized.server}`
    : `project\0${normalized.projectRoot}\0${normalized.server}`;
  return createHash("sha256").update(material).digest("hex");
}

function normalizeIdentity(identity: ExternalMcpCredentialIdentity): ExternalMcpCredentialIdentity {
  return identity.kind === "project"
    ? { kind: "project", server: identity.server, projectRoot: resolve(identity.projectRoot) }
    : { kind: "global", server: identity.server };
}

function sameIdentity(left: ExternalMcpCredentialIdentity, right: ExternalMcpCredentialIdentity): boolean {
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  return a.kind === b.kind
    && a.server === b.server
    && (a.kind === "global" || (b.kind === "project" && a.projectRoot === b.projectRoot));
}

function emptyAuthFile(): ExternalMcpAuthFile {
  return { version: AUTH_FILE_VERSION, credentials: {} };
}

function parseAuthFile(value: unknown, filePath: string): ExternalMcpAuthFile {
  if (!isRecord(value) || value.version !== AUTH_FILE_VERSION || !isRecord(value.credentials)) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: unsupported format.`);
  }
  const credentials: Record<string, ExternalMcpOAuthCredentialRecord> = {};
  for (const [key, raw] of Object.entries(value.credentials)) {
    credentials[key] = parseCredentialRecord(raw, filePath);
  }
  return { version: AUTH_FILE_VERSION, credentials };
}

function parseCredentialRecord(value: unknown, filePath: string): ExternalMcpOAuthCredentialRecord {
  if (!isRecord(value) || !isCredentialIdentity(value.identity)) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid credential identity.`);
  }
  if (
    typeof value.serverUrl !== "string"
    || typeof value.revision !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid credential metadata.`);
  }
  if (
    value.tokens !== undefined
    && (!isRecord(value.tokens) || typeof value.tokens.access_token !== "string")
  ) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid token record.`);
  }
  if (
    value.clientInformation !== undefined
    && (!isRecord(value.clientInformation) || typeof value.clientInformation.client_id !== "string")
  ) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid client record.`);
  }
  if (
    value.discoveryState !== undefined
    && (!isRecord(value.discoveryState) || typeof value.discoveryState.authorizationServerUrl !== "string")
  ) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid discovery record.`);
  }
  const reauthorization = parseReauthorization(value.reauthorization, filePath);
  return {
    identity: normalizeIdentity(value.identity),
    serverUrl: value.serverUrl,
    revision: value.revision,
    updatedAt: value.updatedAt,
    ...(value.tokens ? { tokens: structuredClone(value.tokens) as StoredOAuthTokens } : {}),
    ...(value.clientInformation
      ? { clientInformation: structuredClone(value.clientInformation) as StoredOAuthClientInformation }
      : {}),
    ...(value.discoveryState
      ? { discoveryState: structuredClone(value.discoveryState) as unknown as OAuthDiscoveryState }
      : {}),
    ...(typeof value.authorizationServerUrl === "string"
      ? { authorizationServerUrl: value.authorizationServerUrl }
      : {}),
    ...(typeof value.resourceUrl === "string" ? { resourceUrl: value.resourceUrl } : {}),
    ...(reauthorization ? { reauthorization } : {}),
  };
}

function parseReauthorization(
  value: unknown,
  filePath: string,
): ExternalMcpOAuthCredentialRecord["reauthorization"] | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value)
    || !["authorization_required", "invalid_grant", "insufficient_scope", "binding_changed"].includes(String(value.reason))
    || typeof value.observedAt !== "string"
    || (value.scope !== undefined && typeof value.scope !== "string")
  ) {
    throw new Error(`Unable to read External MCP credential store ${filePath}: invalid reauthorization state.`);
  }
  return {
    reason: value.reason as NonNullable<ExternalMcpOAuthCredentialRecord["reauthorization"]>["reason"],
    observedAt: value.observedAt,
    ...(typeof value.scope === "string" && value.scope.trim() ? { scope: value.scope.trim() } : {}),
  };
}

function isCredentialIdentity(value: unknown): value is ExternalMcpCredentialIdentity {
  if (!isRecord(value) || typeof value.server !== "string" || !value.server) return false;
  if (value.kind === "global") return true;
  return value.kind === "project" && typeof value.projectRoot === "string" && Boolean(value.projectRoot);
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

function writePrivateJsonFile(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
