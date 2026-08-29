import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ServerConfig } from "../config.js";

export type SubagentProvider = "codex" | "claude" | "opencode" | "pi" | "cursor" | "copilot";

export const SUBAGENT_PROVIDERS: readonly SubagentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

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

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
const PROVIDERS = new Set<SubagentProvider>(SUBAGENT_PROVIDERS);

export async function loadSubagentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<SubagentProfile[]> {
  if (!config.subagents) return [];

  const profileDirs = [
    config.devspaceAgentsDir,
    join(workspaceRoot, ".devspace", "agents"),
    join(workspaceRoot, ".forgerelay", "agents"),
  ];
  const profilesByName = new Map<string, SubagentProfile>();

  for (const directory of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
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

async function loadProfilesFromDirectory(directory: string): Promise<SubagentProfile[]> {
  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: SubagentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);
    try {
      profiles.push(await loadProfileFile(filePath));
    } catch (error) {
      console.warn(`Skipping invalid subagent profile ${filePath}: ${errorMessage(error)}`);
    }
  }

  return profiles;
}

async function loadProfileFile(filePath: string): Promise<SubagentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);
  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
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

function profileFromFrontmatter(
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

function readProvider(frontmatter: Record<string, unknown>, filePath: string): SubagentProvider {
  const provider = readString(frontmatter, "provider");
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }
  if (!PROVIDERS.has(provider as SubagentProvider)) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, pi, cursor, or copilot: ${filePath}`,
    );
  }
  return provider as SubagentProvider;
}

export function isSubagentProvider(value: string): value is SubagentProvider {
  return PROVIDERS.has(value as SubagentProvider);
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
