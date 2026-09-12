import { basename, join, resolve } from "node:path";
import * as z from "zod/v4";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "../runtime/config/config.js";
import { defineConfigDomain } from "../runtime/config/definition/definition.js";
import type { ConfigScope } from "../runtime/config/definition/types.js";
import { resolveConfigDomain } from "../runtime/config/resolution/resolver.js";
import type {
  ConfigDiagnostic,
  ConfigSourceInput,
  ResolvedConfigDomain,
} from "../runtime/config/resolution/types.js";
import {
  ConfigSourceRuntime,
  type ConfigSourceRefreshIssue,
} from "../runtime/config/runtime/source-refresh.js";
import { resolveProjectContext } from "../workspaces/state/project-context.js";

export type SubagentProvider = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot";

export const SUBAGENT_PROVIDERS = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
] as const satisfies readonly SubagentProvider[];

export interface SubagentProfile {
  name: string;
  description: string;
  provider: SubagentProvider;
  model?: string;
  thinking?: string;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface SubagentProfileSummary {
  name: string;
  description: string;
  provider: SubagentProvider;
  model?: string;
  thinking?: string;
}

export interface AvailableSubagentProfileSummary extends SubagentProfileSummary {
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface EffectiveSubagentProfileEntry {
  name: string;
  value: SubagentProfileValue;
  scope: ConfigScope;
  filePath: string;
}

type ProfileScope = "user" | "project" | "project-local";

const FRONTMATTER_DELIMITER = "---";
const CANONICAL_PRIORITY = 100;
const LEGACY_PRIORITY = 0;
const LEGACY_DEPRECATION = {
  since: "1.2.0",
  removeIn: "1.4.0",
  replacement: "subagents/",
} as const;
const profileNameSchema = z.string().trim().min(1);
const providerSchema = z.enum(SUBAGENT_PROVIDERS);
const optionalNonEmptyString = z.string().trim().min(1).optional();
const activeProfileFrontmatterSchema = z.object({
  name: profileNameSchema.optional(),
  description: z.string().trim().min(1),
  provider: providerSchema,
  model: optionalNonEmptyString,
  thinking: optionalNonEmptyString,
  disabled: z.literal(false).optional(),
}).strict();
const disabledProfileFrontmatterSchema = z.object({
  name: profileNameSchema.optional(),
  description: optionalNonEmptyString,
  provider: providerSchema.optional(),
  model: optionalNonEmptyString,
  thinking: optionalNonEmptyString,
  disabled: z.literal(true),
}).strict();
const subagentProfileValueSchema = z.object({
  description: z.string().trim().min(1),
  provider: providerSchema,
  model: optionalNonEmptyString,
  thinking: optionalNonEmptyString,
  body: z.string(),
}).strict();
const subagentProfileDisabledSchema = z.object({ disabled: z.literal(true) }).strict();
const subagentProfilesSchema = z.record(
  profileNameSchema,
  z.union([subagentProfileValueSchema, subagentProfileDisabledSchema]),
);

type SubagentProfileValue = z.infer<typeof subagentProfileValueSchema>;

export const subagentProfilesConfigDefinition = defineConfigDomain({
  domain: "subagents",
  title: "ForgeRelay Subagent Profile configuration",
  description: "Markdown Subagent Profiles resolved by profile name across user, Project, and Project Local scopes.",
  schemaOutput: "none",
  fields: {
    profiles: {
      schema: subagentProfilesSchema,
      description: "Subagent Profiles keyed by effective profile name.",
      required: true,
      legalScopes: ["project-local", "project", "user"],
      merge: "keyed",
      reload: "hot",
      sensitivity: "sensitive",
      interpolation: "none",
      builtIn: { kind: "none" },
      executionEffect: (value) => isRecord(value) && value.disabled === true ? "none" : "process",
    },
  },
});

export async function resolveSubagentProfilesConfig(
  config: Pick<ServerConfig, "configDir" | "configRuntime">,
  workspaceRoot: string,
): Promise<ResolvedConfigDomain> {
  const project = await resolveProjectContext(config.configDir, workspaceRoot);
  const sources: ConfigSourceInput[] = [];
  const refreshDiagnostics: ConfigDiagnostic[] = [];
  const sourceRuntime = config.configRuntime.sources;
  appendProfileDirectory(sources, refreshDiagnostics, sourceRuntime, "user", join(config.configDir, "agents"), false);
  appendProfileDirectory(sources, refreshDiagnostics, sourceRuntime, "user", join(config.configDir, "subagents"), true);
  appendProfileDirectory(sources, refreshDiagnostics, sourceRuntime, "project", join(project.sharedConfigDir, "agents"), false);
  appendProfileDirectory(sources, refreshDiagnostics, sourceRuntime, "project", join(project.sharedConfigDir, "subagents"), true);
  appendProfileDirectory(sources, refreshDiagnostics, sourceRuntime, "project-local", join(project.localConfigDir, "subagents"), true);
  const resolution = resolveConfigDomain({
    definition: subagentProfilesConfigDefinition,
    sources,
  });
  resolution.diagnostics = mergeDiagnostics(resolution.diagnostics, refreshDiagnostics);
  return resolution;
}

export async function loadSubagentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<SubagentProfile[]> {
  if (!config.subagents) return [];
  const resolution = await resolveSubagentProfilesConfig(config, workspaceRoot);
  for (const diagnostic of resolution.diagnostics) {
    if (diagnostic.severity !== "error" || diagnostic.diagnosticChanged === false) continue;
    console.warn(
      `Skipping invalid subagent profile ${diagnostic.source.location ?? diagnostic.source.id}: ${diagnostic.message}`,
    );
  }
  return effectiveSubagentProfileEntries(resolution)
    .map((entry) => ({
      name: entry.name,
      description: entry.value.description,
      provider: entry.value.provider,
      ...(entry.value.model ? { model: entry.value.model } : {}),
      ...(entry.value.thinking ? { thinking: entry.value.thinking } : {}),
      filePath: entry.filePath,
      body: entry.value.body,
      disabled: false,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function summarizeSubagentProfile(
  profile: SubagentProfile,
): SubagentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking,
  };
}

export function formatAvailableSubagentProfile(profile: AvailableSubagentProfileSummary): string {
  const model = profile.model ? `, model ${profile.model}` : "";
  const thinking = profile.thinking ? `, thinking ${profile.thinking}` : "";
  const availability = profile.providerAvailable === false
    ? `, unavailable: ${profile.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${profile.name} (${profile.provider}${model}${thinking}${availability})`;
}

function effectiveSubagentProfileEntries(
  resolution: ResolvedConfigDomain,
): EffectiveSubagentProfileEntry[] {
  const values = isRecord(resolution.values.profiles) ? resolution.values.profiles : {};
  const result: EffectiveSubagentProfileEntry[] = [];
  for (const [name, value] of Object.entries(values)) {
    const parsed = subagentProfileValueSchema.safeParse(value);
    const entry = resolution.entries[`profiles.${name}`];
    if (!parsed.success || !entry || !entry.effective.source.location) {
      throw new Error(`Subagent Profile resolver produced an invalid effective entry for ${name}.`);
    }
    result.push({
      name,
      value: parsed.data,
      scope: entry.effective.source.scope,
      filePath: entry.effective.source.location,
    });
  }
  return result;
}

function appendProfileDirectory(
  sources: ConfigSourceInput[],
  diagnostics: ConfigDiagnostic[],
  sourceRuntime: ConfigSourceRuntime,
  scope: ProfileScope,
  directory: string,
  canonical: boolean,
): void {
  const resolvedDirectory = resolve(directory);
  const refreshed = sourceRuntime.refreshDirectory<SubagentProfile>({
    key: `subagents:${canonical ? "canonical" : "legacy"}:${scope}:${resolvedDirectory}`,
    directory: resolvedDirectory,
    include: (name) => name.endsWith(".md"),
    parse: (_name, content, filePath) => parseProfileSourceDocument(canonical, content, filePath),
    parseIssue: (error) => ({
      code: "invalid_source",
      message: "Subagent Profile is invalid.",
      ...(error instanceof SubagentProfileSourceError && error.keyHint
        ? { keyHint: error.keyHint }
        : {}),
    }),
    readIssue: { code: "invalid_source", message: "Subagent Profile could not be read." },
  });

  if (refreshed.state === "invalid" && refreshed.issue) {
    diagnostics.push({
      severity: "error",
      code: refreshed.issue.code,
      source: {
        id: `${canonical ? "canonical" : "legacy"}:${scope}:subagents-directory`,
        scope,
        kind: "file",
        location: resolvedDirectory,
        priority: canonical ? CANONICAL_PRIORITY : LEGACY_PRIORITY,
      },
      message: refreshed.issue.message,
      diagnosticChanged: refreshed.diagnosticChanged,
    });
  }

  for (const unit of refreshed.units) {
    const filePath = unit.status.path;
    if (unit.value !== undefined) {
      const source = profileSource(scope, filePath, unit.name, canonical, unit.value);
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
      sources.push(invalidProfileSource(
        scope,
        filePath,
        profileKeyHintFromIssue(unit.issue) ?? basename(unit.name, ".md"),
        canonical,
        unit.issue?.message ?? "Subagent Profile is invalid.",
        unit.issue?.code,
      ));
    }
  }
}

function profileSource(
  scope: ProfileScope,
  filePath: string,
  fileName: string,
  canonical: boolean,
  profile: SubagentProfile,
): ConfigSourceInput {
  const value = profile.disabled
    ? { disabled: true as const }
    : {
        description: profile.description,
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
        body: profile.body,
      };
  return {
    id: `${canonical ? "canonical" : "legacy"}:${scope}:subagent:${fileName}`,
    scope,
    kind: "file",
    location: filePath,
    priority: canonical ? CANONICAL_PRIORITY : LEGACY_PRIORITY,
    normalized: true,
    ...(canonical ? { shadowsLowerPriorityKeys: [`profiles.${profile.name}`] } : { deprecation: LEGACY_DEPRECATION }),
    value: { profiles: { [profile.name]: value } },
  };
}

function invalidProfileSource(
  scope: ProfileScope,
  filePath: string,
  key: string,
  canonical: boolean,
  message: string,
  code: "invalid_source" | "missing_environment" = "invalid_source",
): ConfigSourceInput {
  return {
    id: `${canonical ? "canonical" : "legacy"}:${scope}:subagent:${basename(filePath)}`,
    scope,
    kind: "file",
    location: filePath,
    priority: canonical ? CANONICAL_PRIORITY : LEGACY_PRIORITY,
    ...(canonical ? { shadowsLowerPriorityKeys: [`profiles.${key}`] } : { deprecation: LEGACY_DEPRECATION }),
    error: { code, message },
  };
}

class SubagentProfileSourceError extends Error {
  constructor(readonly keyHint?: string) {
    super("Subagent Profile source is invalid.");
    this.name = "SubagentProfileSourceError";
  }
}

function parseProfileSourceDocument(
  canonical: boolean,
  content: string,
  filePath: string,
): SubagentProfile {
  const keyHint = profileKeyHint(content, filePath);
  try {
    return canonical
      ? canonicalProfileFromDocument(content, filePath)
      : legacyProfileFromDocument(content, filePath);
  } catch {
    throw new SubagentProfileSourceError(keyHint);
  }
}

function canonicalProfileFromDocument(content: string, filePath: string): SubagentProfile {
  const parsed = parseFrontmatter(content, filePath);
  const frontmatter = z.union([
    disabledProfileFrontmatterSchema,
    activeProfileFrontmatterSchema,
  ]).parse(parsed.frontmatter);
  const name = frontmatter.name ?? basename(filePath, ".md");
  if (frontmatter.disabled === true) {
    return {
      name,
      description: frontmatter.description ?? "Disabled Subagent Profile.",
      provider: frontmatter.provider ?? "codex",
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      filePath,
      body: parsed.body,
      disabled: true,
    };
  }
  return {
    name,
    description: frontmatter.description,
    provider: frontmatter.provider,
    model: frontmatter.model,
    thinking: frontmatter.thinking,
    filePath,
    body: parsed.body,
    disabled: false,
  };
}

function legacyProfileFromDocument(content: string, filePath: string): SubagentProfile {
  const parsed = parseFrontmatter(content, filePath);
  return legacyProfileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}

export function canonicalSubagentProfileDocumentFromLegacy(content: string, filePath: string): string {
  const profile = legacyProfileFromDocument(content, filePath);
  const frontmatter = [
    `name: ${JSON.stringify(profile.name)}`,
    `description: ${JSON.stringify(profile.description)}`,
    `provider: ${profile.provider}`,
    ...(profile.model ? [`model: ${JSON.stringify(profile.model)}`] : []),
    ...(profile.thinking ? [`thinking: ${JSON.stringify(profile.thinking)}`] : []),
    ...(profile.disabled ? ["disabled: true"] : []),
  ];
  return [FRONTMATTER_DELIMITER, ...frontmatter, FRONTMATTER_DELIMITER, profile.body, ""].join("\n");
}

function legacyProfileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string,
): SubagentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readProvider(frontmatter, filePath);
  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    model: readString(frontmatter, "model"),
    thinking: readString(frontmatter, "thinking"),
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function profileKeyHint(content: string, filePath: string): string | undefined {
  try {
    return readString(parseFrontmatter(content, filePath).frontmatter, "name");
  } catch {
    return undefined;
  }
}

function profileKeyHintFromIssue(issue: ConfigSourceRefreshIssue | undefined): string | undefined {
  if (!issue || !("keyHint" in issue) || typeof issue.keyHint !== "string") return undefined;
  const trimmed = issue.keyHint.trim();
  return trimmed || undefined;
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseProfileYaml(source: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(source) ?? {};
  } catch (error) {
    throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

function readProvider(frontmatter: Record<string, unknown>, filePath: string): SubagentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  if (!isSubagentProvider(provider)) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, pi, cursor, or copilot: ${filePath}`,
    );
  }
  return provider;
}

export function isSubagentProvider(value: string): value is SubagentProvider {
  return (SUBAGENT_PROVIDERS as readonly string[]).includes(value);
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
