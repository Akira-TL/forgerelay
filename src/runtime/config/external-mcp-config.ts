const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_MCP_SERVERS = 32;

export interface ExternalMcpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExternalMcpHttpServerConfig {
  transport: "streamable-http";
  url: string;
  headers?: Record<string, string>;
}

export type ExternalMcpServerConfig = ExternalMcpStdioServerConfig | ExternalMcpHttpServerConfig;
export type ExternalMcpServersConfig = Record<string, ExternalMcpServerConfig>;

export function parseExternalMcpServers(value: unknown): ExternalMcpServersConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("mcpServers must be an object keyed by server name.");
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_SERVERS) {
    throw new Error(`mcpServers may contain at most ${MAX_MCP_SERVERS} configured servers.`);
  }

  return Object.fromEntries(entries.map(([name, raw]) => {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid mcpServers name '${name}'. Use a lowercase stable name.`);
    }
    if (!isRecord(raw)) throw new Error(`mcpServers.${name} must be an object.`);
    if (raw.transport === "stdio") return [name, parseStdio(name, raw)];
    if (raw.transport === "streamable-http") return [name, parseHttp(name, raw)];
    throw new Error(`mcpServers.${name}.transport must be 'stdio' or 'streamable-http'.`);
  }));
}

function parseStdio(name: string, value: Record<string, unknown>): ExternalMcpStdioServerConfig {
  const command = requiredString(value.command, `mcpServers.${name}.command`);
  const args = optionalStringArray(value.args, `mcpServers.${name}.args`);
  const env = optionalStringRecord(value.env, `mcpServers.${name}.env`);
  const cwd = optionalString(value.cwd, `mcpServers.${name}.cwd`);
  rejectUnknownKeys(value, new Set(["transport", "command", "args", "env", "cwd"]), `mcpServers.${name}`);
  return {
    transport: "stdio",
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function parseHttp(name: string, value: Record<string, unknown>): ExternalMcpHttpServerConfig {
  const url = requiredString(value.url, `mcpServers.${name}.url`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`mcpServers.${name}.url must be a valid HTTP(S) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`mcpServers.${name}.url must use http or https.`);
  }
  const headers = optionalStringRecord(value.headers, `mcpServers.${name}.headers`);
  rejectUnknownKeys(value, new Set(["transport", "url", "headers"]), `mcpServers.${name}`);
  return {
    transport: "streamable-http",
    url: parsed.toString(),
    ...(headers ? { headers } : {}),
  };
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
