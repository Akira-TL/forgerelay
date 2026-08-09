import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface ForgeRelayUserConfig {
  host?: string;
  port?: number;
  allowedRoots?: string[];
  publicBaseUrl?: string | null;
  allowedHosts?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  artifactsEnabled?: boolean;
  artifactMaxFileBytes?: number;
  workflowInstructions?: string | false;
  appendInstructions?: string;
  agentDir?: string;
  systemInstructionsPath?: string;
  subagents?: boolean;
}

export interface ForgeRelayAuthConfig {
  ownerToken?: string;
}

export interface ForgeRelayFiles {
  dir: string;
  configPath: string;
  authPath: string;
  configExists: boolean;
  authExists: boolean;
  config: ForgeRelayUserConfig;
  auth: ForgeRelayAuthConfig;
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
  const configExists = existsSync(configPath);
  const authExists = existsSync(authPath);

  return {
    dir,
    configPath,
    authPath,
    configExists,
    authExists,
    config: configExists ? readJsonFile<ForgeRelayUserConfig>(configPath) : {},
    auth: authExists ? readJsonFile<ForgeRelayAuthConfig>(authPath) : {},
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
