import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LanguageServerConfigInput } from "./lsp/language-server-config.js";
import {
  mergeHookConfigs,
  parseHookFile,
  type HookConfig,
  type HookConfigInput,
} from "./hooks.js";

export interface ForgeRelayUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | string[] | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  artifactsEnabled?: boolean;
  artifactMaxFileBytes?: number;
  activityPanelExpanded?: boolean;
  workflowInstructions?: string | false;
  appendInstructions?: string;
  agentDir?: string;
  systemInstructionsPath?: string;
  subagents?: boolean;
  languageServers?: LanguageServerConfigInput;
  hooks?: HookConfigInput;
}

export interface ForgeRelayAuthConfig {
  ownerToken?: string;
}

export interface ForgeRelayFiles {
  dir: string;
  configPath: string;
  authPath: string;
  hooksPath: string;
  configExists: boolean;
  authExists: boolean;
  hooksExists: boolean;
  config: ForgeRelayUserConfig;
  auth: ForgeRelayAuthConfig;
  hooks: HookConfigInput;
  hookFiles: HookConfig;
  usingLegacyDir: boolean;
}

/** @deprecated Internal compatibility alias. */
export type DevspaceUserConfig = ForgeRelayUserConfig;
/** @deprecated Internal compatibility alias. */
export type DevspaceAuthConfig = ForgeRelayAuthConfig;
/** @deprecated Internal compatibility alias. */
export type DevspaceFiles = ForgeRelayFiles;

export function forgerelayConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FORGERELAY_CONFIG_DIR ?? env.DEVSPACE_CONFIG_DIR;
  if (explicit) return resolve(expandHomePath(explicit));

  const current = join(homedir(), ".forgerelay");
  const legacy = join(homedir(), ".devspace");
  if (existsSync(current) || !existsSync(legacy)) return resolve(current);
  return resolve(legacy);
}

export function forgerelayConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "config.json");
}

export function forgerelayAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "auth.json");
}

export function forgerelayHooksPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "hooks.json");
}

export function forgerelayHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "hooks");
}

export function forgerelaySkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "skills");
}

export function forgerelayAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(forgerelayConfigDir(env), "agents");
}

export function loadForgeRelayFiles(env: NodeJS.ProcessEnv = process.env): ForgeRelayFiles {
  const dir = forgerelayConfigDir(env);
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const hooksPath = join(dir, "hooks.json");
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);
  const hooksExists = existsSync(hooksPath);

  return {
    dir,
    configPath,
    authPath,
    hooksPath,
    configExists,
    authExists,
    hooksExists,
    config: configExists ? readJsonFile<ForgeRelayUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<ForgeRelayAuthConfig>(authPath) : {},
    hooks: hooksExists ? readJsonFile<HookConfigInput>(hooksPath) : {},
    hookFiles: readHookFiles(join(dir, "hooks")),
    usingLegacyDir: dir === resolve(join(homedir(), ".devspace")),
  };
}

export function writeForgeRelayConfig(
  config: ForgeRelayUserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = forgerelayConfigPath(env);
  mkdirSync(forgerelayConfigDir(env), { recursive: true });
  writeJsonFile(filePath, config, 0o600);
  return filePath;
}

export function writeForgeRelayAuth(
  auth: ForgeRelayAuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = forgerelayAuthPath(env);
  mkdirSync(forgerelayConfigDir(env), { recursive: true });
  writeJsonFile(filePath, auth, 0o600);
  return filePath;
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ensureForgeRelayDefaultSkills(env: NodeJS.ProcessEnv = process.env): string[] {
  const targetPath = join(forgerelaySkillsDir(env), "subagent-delegation", "SKILL.md");
  if (existsSync(targetPath)) return [];

  const sourcePath = new URL("../skills/subagent-delegation/SKILL.md", import.meta.url);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), { mode: 0o644 });
  return [targetPath];
}

export function resolveSubagentsFlag(
  config: Pick<ForgeRelayUserConfig, "subagents">,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const value = env.FORGERELAY_SUBAGENTS ?? env.DEVSPACE_SUBAGENTS;
  if (value === undefined) return config.subagents;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

// Legacy exported names remain temporarily so existing integrations and tests do not
// break while the public product surface migrates to ForgeRelay.
export const devspaceConfigDir = forgerelayConfigDir;
export const devspaceConfigPath = forgerelayConfigPath;
export const devspaceAuthPath = forgerelayAuthPath;
export const devspaceSkillsDir = forgerelaySkillsDir;
export const devspaceAgentsDir = forgerelayAgentsDir;
export const loadDevspaceFiles = loadForgeRelayFiles;
export const writeDevspaceConfig = writeForgeRelayConfig;
export const writeDevspaceAuth = writeForgeRelayAuth;
export const ensureDevspaceDefaultSkills = ensureForgeRelayDefaultSkills;

function readHookFiles(directory: string): HookConfig {
  if (!existsSync(directory)) return {};

  let hooks: HookConfig = {};
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    try {
      hooks = mergeHookConfigs(
        hooks,
        parseHookFile(readJsonFile<unknown>(filePath), entry.name.slice(0, -5)),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to load hook file ${filePath}: ${reason}`);
    }
  }
  return hooks;
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${filePath}: ${reason}`);
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", { mode });
}
