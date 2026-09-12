import {
  externalMcpStandaloneServersSchema,
} from "../external-mcp-config.js";
import { defineConfigDomain } from "./definition.js";

const MCP_SCOPES = ["project-local", "project", "user"] as const;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const externalMcpConfigDefinition = defineConfigDomain({
  domain: "mcp",
  title: "ForgeRelay External MCP configuration",
  description: "Canonical External MCP server configuration. OAuth credentials remain in the machine-private mcp-auth.json store.",
  fields: {
    servers: {
      schema: externalMcpStandaloneServersSchema,
      description: "External MCP servers keyed by stable server name.",
      required: true,
      legalScopes: MCP_SCOPES,
      merge: "keyed",
      reload: "hot",
      sensitivity: "sensitive",
      interpolation: "env",
      interpolateValue: interpolateExternalMcpSecrets,
      builtIn: { kind: "none" },
      executionEffect: (value) => isRecord(value) && value.transport === "stdio" ? "process" : "none",
    },
  },
});

function interpolateExternalMcpSecrets(
  value: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (!isRecord(entry)) return [name, entry];
    const next = { ...entry };
    if (isRecord(entry.env)) next.env = interpolateStringRecord(entry.env, environment);
    if (isRecord(entry.headers)) next.headers = interpolateStringRecord(entry.headers, environment);
    return [name, next];
  }));
}

function interpolateStringRecord(
  value: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
    name,
    typeof entry === "string" ? interpolateString(entry, environment) : entry,
  ]));
}

function interpolateString(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REFERENCE, (_match, name: string) => {
    const resolved = environment[name];
    if (resolved !== undefined) return resolved;
    const error = new Error(`Required environment variable ${name} is not available.`) as Error & {
      code?: string;
      variable?: string;
    };
    error.code = "missing_environment";
    error.variable = name;
    throw error;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
