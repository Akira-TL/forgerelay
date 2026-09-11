import * as z from "zod/v4";
import { defineConfigDomain } from "./definition.js";
import type { ConfigFieldDefinition } from "./types.js";

const USER_RUNTIME_SCOPES = ["runtime", "user", "built-in"] as const;
const USER_SCOPES = ["user", "built-in"] as const;
const USER_ONLY_SCOPES = ["user"] as const;
const LEGACY_REMOVAL_VERSION = "1.4.0";

const commandShellSchema = z.object({
  mode: z.enum(["follow-launcher", "pinned"]),
  family: z.enum(["bash", "zsh", "fish", "sh", "pwsh", "powershell", "cmd"]),
  executable: z.string().min(1),
}).strict();

const retentionSchema = z.object({
  historyDays: z.number().int().min(1).max(36_500).optional(),
  orphanedAdministrativeState: z.boolean().optional(),
}).strict();

export const generalConfigDefinition = defineConfigDomain({
  domain: "config",
  title: "ForgeRelay general configuration",
  description: "Canonical ForgeRelay general configuration. Domain-specific MCP, Language Server, Hook, Subagent, and credential settings use separate sources.",
  fields: {
    host: field(z.string().min(1), "Local bind host.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal("127.0.0.1"),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("HOST", (env) => env.HOST),
    }),
    port: field(z.number().int().min(1).max(65535), "Local listening port.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(7676),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("PORT", (env) => readIntegerEnv(env, "PORT", 1, 65535)),
    }),
    allowedRoots: field(z.array(z.string()), "Filesystem roots that Workspaces may open.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("The process working directory when no roots are configured."),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_ALLOWED_ROOTS", (env) => readListEnv(env, "FORGERELAY_ALLOWED_ROOTS")),
    }),
    publicBaseUrl: field(
      z.union([z.string().min(1), z.array(z.string().min(1)).min(1), z.null()]),
      "Canonical public base URL or ordered public base URL list.",
      {
        scopes: USER_RUNTIME_SCOPES,
        builtIn: computed("A local HTTP URL derived from the effective bind host and port."),
        reload: "restart-required",
        runtimeOverride: runtimeEnv("FORGERELAY_PUBLIC_BASE_URL", (env) => readRequiredTextEnv(env, "FORGERELAY_PUBLIC_BASE_URL")),
      },
    ),
    allowedHosts: field(z.array(z.string()), "Explicit Host-header allowlist.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("Derived from loopback, bind host, and configured public base URL hostnames."),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_ALLOWED_HOSTS", (env) => readListEnv(env, "FORGERELAY_ALLOWED_HOSTS")),
    }),
    trustedProxies: field(z.array(z.string()), "Trusted proxy IP addresses, CIDRs, or the internal loopback alias.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("No trusted proxy unless the deployment shape safely derives loopback trust."),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_TRUSTED_PROXIES", (env) => readListEnv(env, "FORGERELAY_TRUSTED_PROXIES")),
    }),
    stateDir: field(z.string().min(1), "ForgeRelay durable state directory.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("~/.local/share/forgerelay"),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_STATE_DIR", (env) => env.FORGERELAY_STATE_DIR),
    }),
    worktreeRoot: field(z.string().min(1), "Managed worktree directory.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("~/.forgerelay/worktrees"),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_WORKTREE_ROOT", (env) => env.FORGERELAY_WORKTREE_ROOT),
    }),
    artifactsEnabled: field(z.boolean(), "Enable ForgeRelay Artifact capability support.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(false),
      runtimeOverride: runtimeEnv("FORGERELAY_ARTIFACTS", (env) => readBooleanEnv(env, "FORGERELAY_ARTIFACTS")),
    }),
    artifactMaxFileBytes: field(z.number().int().min(1), "Maximum bytes accepted for one downloaded Artifact file.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(100 * 1024 * 1024),
      runtimeOverride: runtimeEnv("FORGERELAY_ARTIFACT_MAX_FILE_BYTES", (env) => readIntegerEnv(env, "FORGERELAY_ARTIFACT_MAX_FILE_BYTES", 1)),
    }),
    mediaMaxBytes: field(z.number().int().min(1), "Maximum aggregate decoded inline image bytes in one Host-facing result.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(20 * 1024 * 1024),
      runtimeOverride: runtimeEnv("FORGERELAY_MEDIA_MAX_BYTES", (env) => readIntegerEnv(env, "FORGERELAY_MEDIA_MAX_BYTES", 1)),
    }),
    taskReminderInterval: field(z.number().int().min(0), "Semantic-work interval for Workspace Task reminders; zero disables reminders.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(30),
      runtimeOverride: runtimeEnv("FORGERELAY_TASK_REMINDER_INTERVAL", (env) => readIntegerEnv(env, "FORGERELAY_TASK_REMINDER_INTERVAL", 0)),
    }),
    retention: field(retentionSchema, "Owner-authorized durable history and orphaned administrative-state retention policy.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("Unlimited durable history and no orphaned administrative cleanup authorization."),
      runtimeOverride: runtimeEnv(
        ["FORGERELAY_RETENTION_HISTORY_DAYS", "FORGERELAY_RETENTION_ORPHANED_ADMIN"],
        readRetentionEnv,
      ),
    }),
    activityPanelExpanded: field(z.boolean(), "Whether the Activity Panel opens expanded by default.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(false),
      runtimeOverride: runtimeEnv("FORGERELAY_ACTIVITY_PANEL_EXPANDED", (env) => readBooleanEnv(env, "FORGERELAY_ACTIVITY_PANEL_EXPANDED")),
    }),
    workflowInstructions: field(z.union([z.string(), z.literal(false)]), "Replace ForgeRelay built-in Agent workflow instructions while retaining the capability contract.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("ForgeRelay built-in workflow instructions."),
      runtimeOverride: runtimeEnv("FORGERELAY_WORKFLOW_INSTRUCTIONS", (env) => env.FORGERELAY_WORKFLOW_INSTRUCTIONS),
    }),
    appendInstructions: field(z.string(), "Append operator workflow instructions after the selected ForgeRelay workflow policy.", {
      scopes: ["runtime", ...USER_ONLY_SCOPES] as const,
      builtIn: none(),
      runtimeOverride: runtimeEnv("FORGERELAY_APPEND_INSTRUCTIONS", (env) => env.FORGERELAY_APPEND_INSTRUCTIONS),
    }),
    agentDir: field(z.string().min(1), "Agent runtime directory used by supported integrations.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("~/.codex"),
      reload: "restart-required",
      runtimeOverride: runtimeEnv("FORGERELAY_AGENT_DIR", (env) => env.FORGERELAY_AGENT_DIR),
    }),
    systemInstructionsPath: field(z.string().min(1), "Global Agent instruction file consumed by ForgeRelay.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: computed("~/.agents/AGENTS.md"),
      runtimeOverride: runtimeEnv("FORGERELAY_SYSTEM_INSTRUCTIONS_PATH", (env) => readNonEmptyPathEnv(env, "FORGERELAY_SYSTEM_INSTRUCTIONS_PATH")),
    }),
    commandShell: field(commandShellSchema, "Recorded command-shell preference for ForgeRelay command and Hook execution.", {
      scopes: USER_SCOPES,
      builtIn: computed("Detected launcher shell with the recorded compatibility fallback used when needed."),
      reload: "restart-required",
    }),
    shellInstructions: field(z.boolean(), "Enable ForgeRelay-owned runtime shell instructions.", {
      scopes: USER_SCOPES,
      builtIn: literal(true),
    }),
    subagents: field(z.boolean(), "Enable Subagent Session support.", {
      scopes: USER_RUNTIME_SCOPES,
      builtIn: literal(false),
      runtimeOverride: runtimeEnv("FORGERELAY_SUBAGENTS", (env) => readBooleanEnv(env, "FORGERELAY_SUBAGENTS")),
    }),
    allowAgentLanguageServerInstall: field(z.boolean(), "Allow Agents to install ForgeRelay-managed Language Servers.", {
      scopes: USER_SCOPES,
      builtIn: literal(false),
    }),
    languageServers: field(z.unknown(), "Deprecated inline Language Server configuration retained for v1.2 compatibility.", {
      scopes: USER_ONLY_SCOPES,
      builtIn: none(),
      deprecation: legacyDeprecation("language-servers.json"),
    }),
    mcpServers: field(z.unknown(), "Deprecated inline External MCP configuration retained for v1.2 compatibility.", {
      scopes: USER_ONLY_SCOPES,
      builtIn: none(),
      deprecation: legacyDeprecation("mcp.json"),
    }),
    hooks: field(z.unknown(), "Deprecated inline Hook configuration retained for v1.2 compatibility.", {
      scopes: USER_ONLY_SCOPES,
      builtIn: none(),
      deprecation: legacyDeprecation("hooks/"),
    }),
  },
});

interface FieldOptions<T> {
  scopes: readonly ("runtime" | "project-local" | "project" | "user" | "built-in")[];
  builtIn: ConfigFieldDefinition<z.ZodType<T>>["builtIn"];
  reload?: "hot" | "restart-required";
  sensitivity?: "public" | "sensitive";
  interpolation?: "none" | "env";
  executionEffect?: "none" | "process";
  runtimeOverride?: ConfigFieldDefinition<z.ZodType<T>>["runtimeOverride"];
  deprecation?: ConfigFieldDefinition<z.ZodType<T>>["deprecation"];
}

function field<TSchema extends z.ZodType>(
  schema: TSchema,
  description: string,
  options: FieldOptions<z.output<TSchema>>,
): ConfigFieldDefinition<TSchema> {
  return {
    schema,
    description,
    legalScopes: options.scopes,
    merge: "replace",
    reload: options.reload ?? "hot",
    sensitivity: options.sensitivity ?? "public",
    interpolation: options.interpolation ?? "none",
    executionEffect: options.executionEffect ?? "none",
    builtIn: options.builtIn as ConfigFieldDefinition<TSchema>["builtIn"],
    ...(options.runtimeOverride ? { runtimeOverride: options.runtimeOverride } : {}),
    ...(options.deprecation ? { deprecation: options.deprecation } : {}),
  };
}

function literal<T>(value: T): { kind: "literal"; value: T } {
  return { kind: "literal", value };
}

function computed(description: string): { kind: "computed"; description: string } {
  return { kind: "computed", description };
}

function none(): { kind: "none" } {
  return { kind: "none" };
}

function runtimeEnv<T>(
  env: string | readonly string[],
  readEnv: (values: NodeJS.ProcessEnv) => T | undefined,
): { env: string | readonly string[]; readEnv: (values: NodeJS.ProcessEnv) => T | undefined } {
  return { env, readEnv };
}

function readBooleanEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `an integer greater than or equal to ${minimum}`
      : `an integer from ${minimum} to ${maximum}`;
    throw new Error(`Invalid ${name}: expected ${range}.`);
  }
  return parsed;
}

function readListEnv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readRequiredTextEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!value.split(",").some((entry) => entry.trim().length > 0)) {
    throw new Error(`${name} must contain at least one public base URL.`);
  }
  return value;
}

function readNonEmptyPathEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error(`${name} must be one non-empty path`);
  return value;
}

function readRetentionEnv(env: NodeJS.ProcessEnv): z.output<typeof retentionSchema> | undefined {
  const rawHistoryDays = env.FORGERELAY_RETENTION_HISTORY_DAYS;
  let historyDays: number | undefined;
  if (rawHistoryDays !== undefined && rawHistoryDays !== "") {
    const parsed = Number(rawHistoryDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 36_500) {
      throw new Error("Retention historyDays must be an integer between 1 and 36500.");
    }
    historyDays = parsed;
  }

  const rawOrphaned = env.FORGERELAY_RETENTION_ORPHANED_ADMIN;
  let orphanedAdministrativeState: boolean | undefined;
  if (rawOrphaned !== undefined && rawOrphaned !== "") {
    const normalized = rawOrphaned.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) orphanedAdministrativeState = true;
    else if (["0", "false", "no", "off"].includes(normalized)) orphanedAdministrativeState = false;
    else throw new Error("Retention orphanedAdministrativeState must be a boolean.");
  }

  if (historyDays === undefined && orphanedAdministrativeState === undefined) return undefined;
  return {
    ...(historyDays === undefined ? {} : { historyDays }),
    ...(orphanedAdministrativeState === undefined ? {} : { orphanedAdministrativeState }),
  };
}

function legacyDeprecation(replacement: string) {
  return {
    since: "1.2.0",
    removeIn: LEGACY_REMOVAL_VERSION,
    replacement,
  };
}
