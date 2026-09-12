import * as z from "zod/v4";

const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_MCP_SERVERS = 32;

const nonEmptyStringSchema = z.string().trim().min(1);
const stringRecordSchema = z.record(z.string(), z.string());
const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use http or https.");
const clientMetadataUrlSchema = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.pathname !== "/";
}, "clientMetadataUrl must use https and contain a non-root path.");
const oauthSourceSchema = z.object({
  clientMetadataUrl: clientMetadataUrlSchema,
  callbackPort: z.number().int().min(1024).max(65535),
}).strict();
const stdioSourceSchema = z.object({
  transport: z.literal("stdio"),
  command: nonEmptyStringSchema,
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: nonEmptyStringSchema.optional(),
  disabled: z.literal(false).optional(),
}).strict();
const httpSourceSchema = z.object({
  transport: z.literal("streamable-http"),
  url: httpUrlSchema,
  headers: stringRecordSchema.optional(),
  oauth: oauthSourceSchema.optional(),
  disabled: z.literal(false).optional(),
}).strict();
const disabledSourceSchema = z.object({ disabled: z.literal(true) }).strict();

export const externalMcpStandaloneServerSchema = z.union([
  disabledSourceSchema,
  stdioSourceSchema,
  httpSourceSchema,
]);

export const externalMcpStandaloneServersSchema = z.record(
  z.string().regex(MCP_SERVER_NAME_PATTERN, "Use a lowercase stable server name."),
  externalMcpStandaloneServerSchema,
).refine((value) => Object.keys(value).length <= MAX_MCP_SERVERS, {
  message: `servers may contain at most ${MAX_MCP_SERVERS} configured servers.`,
});

export interface ExternalMcpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExternalMcpOAuthClientConfig {
  clientMetadataUrl: string;
  callbackPort: number;
}

export interface ExternalMcpHttpServerConfig {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  oauth?: ExternalMcpOAuthClientConfig;
}

export interface ExternalMcpDisabledServerConfig {
  disabled: true;
}

export type ExternalMcpServerConfig = ExternalMcpStdioServerConfig | ExternalMcpHttpServerConfig;
export type ExternalMcpServersConfig = Record<string, ExternalMcpServerConfig>;
export type ExternalMcpStandaloneServerConfig = ExternalMcpServerConfig | ExternalMcpDisabledServerConfig;
export type ExternalMcpStandaloneServersConfig = Record<string, ExternalMcpStandaloneServerConfig>;

export function parseExternalMcpServers(value: unknown): ExternalMcpServersConfig {
  return parseServerRegistry(value, "mcpServers", false) as ExternalMcpServersConfig;
}

export function parseExternalMcpStandaloneConfig(value: unknown): ExternalMcpStandaloneServersConfig {
  if (!isRecord(value)) throw new Error("External MCP configuration must be a JSON object.");
  rejectUnknownKeys(value, new Set(["servers"]), "External MCP configuration");
  if (!("servers" in value)) throw new Error("External MCP configuration must contain a servers object.");
  return parseServerRegistry(value.servers, "servers", true);
}

function parseServerRegistry(
  value: unknown,
  label: string,
  allowDisabled: boolean,
): ExternalMcpStandaloneServersConfig {
  if (value === undefined && !allowDisabled) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object keyed by server name.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_SERVERS) {
    throw new Error(`${label} may contain at most ${MAX_MCP_SERVERS} configured servers.`);
  }

  return Object.fromEntries(entries.map(([name, raw]) => {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid ${label} name '${name}'. Use a lowercase stable name.`);
    }
    if (!isRecord(raw)) throw new Error(`${label}.${name} must be an object.`);
    const disabled = allowDisabled && "disabled" in raw ? parseDisabled(raw.disabled, `${label}.${name}.disabled`) : false;
    const serverValue = allowDisabled && "disabled" in raw
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "disabled"))
      : raw;
    if (disabled && Object.keys(serverValue).length === 0) {
      return [name, { disabled: true } satisfies ExternalMcpDisabledServerConfig];
    }
    const server = serverValue.transport === "stdio"
      ? parseStdio(name, serverValue, label)
      : serverValue.transport === "streamable-http"
        ? parseHttp(name, serverValue, label)
        : undefined;
    if (!server) throw new Error(`${label}.${name}.transport must be 'stdio' or 'streamable-http'.`);
    return [name, disabled ? { disabled: true } satisfies ExternalMcpDisabledServerConfig : server];
  }));
}

function parseStdio(
  name: string,
  value: Record<string, unknown>,
  label: string,
): ExternalMcpStdioServerConfig {
  const command = requiredString(value.command, `${label}.${name}.command`);
  const args = optionalStringArray(value.args, `${label}.${name}.args`);
  const env = optionalStringRecord(value.env, `${label}.${name}.env`);
  const cwd = optionalString(value.cwd, `${label}.${name}.cwd`);
  rejectUnknownKeys(value, new Set(["transport", "command", "args", "env", "cwd"]), `${label}.${name}`);
  return {
    transport: "stdio",
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function parseHttp(
  name: string,
  value: Record<string, unknown>,
  label: string,
): ExternalMcpHttpServerConfig {
  const url = requiredString(value.url, `${label}.${name}.url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}.${name}.url must be a valid HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label}.${name}.url must use http or https.`);
  }
  const headers = optionalStringRecord(value.headers, `${label}.${name}.headers`);
  const oauth = parseOAuthClientConfig(value.oauth, `${label}.${name}.oauth`);
  rejectUnknownKeys(value, new Set(["transport", "url", "headers", "oauth"]), `${label}.${name}`);
  return {
    transport: "streamable-http",
    url: parsed.toString(),
    ...(headers ? { headers } : {}),
    ...(oauth ? { oauth } : {}),
  };
}

function parseOAuthClientConfig(value: unknown, label: string): ExternalMcpOAuthClientConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  rejectUnknownKeys(value, new Set(["clientMetadataUrl", "callbackPort"]), label);
  const clientMetadataUrl = requiredString(value.clientMetadataUrl, `${label}.clientMetadataUrl`);
  let parsed: URL;
  try {
    parsed = new URL(clientMetadataUrl);
  } catch {
    throw new Error(`${label}.clientMetadataUrl must be a valid HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.pathname === "/") {
    throw new Error(`${label}.clientMetadataUrl must use https and contain a non-root path.`);
  }
  const callbackPort = value.callbackPort;
  if (!Number.isInteger(callbackPort) || Number(callbackPort) < 1024 || Number(callbackPort) > 65535) {
    throw new Error(`${label}.callbackPort must be an integer from 1024 to 65535.`);
  }
  return {
    clientMetadataUrl: parsed.toString(),
    callbackPort: Number(callbackPort),
  };
}

function parseDisabled(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value];
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an object of string values.`);
  }
  return { ...value } as Record<string, string>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
