import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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

const AUTH_LOCK_RETRY_MS = 10;
const AUTH_LOCK_TIMEOUT_MS = 5_000;
const AUTH_LOCK_STALE_MS = 30_000;
const AUTH_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
  taskReminderInterval?: number;
  activityPanelExpanded?: boolean;
  workflowInstructions?: string | false;
  appendInstructions?: string;
  agentDir?: string;
  systemInstructionsPath?: string;
  subagents?: boolean;
  languageServers?: LanguageServerConfigInput;
  hooks?: HookConfigInput;
}

export interface ForgeRelayRemoteRecord {
  instanceId: string;
  target: string;
  sshRoute?: string[];
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  scope?: string;
}

export interface ForgeRelayAuthConfig {
  ownerToken?: string;
  instanceId?: string;
  remotes?: Record<string, ForgeRelayRemoteRecord>;
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
  return withAuthFileLock(filePath, () => {
    writeJsonFile(filePath, auth, 0o600);
    return filePath;
  });
}

export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generateInstanceId(): string {
  return `forge-${randomUUID()}`;
}

export function ensureForgeRelayInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const existing = loadForgeRelayFiles(env).auth.instanceId?.trim();
  if (existing) return existing;

  let resolved = "";
  updateForgeRelayAuth((auth) => {
    const current = auth.instanceId?.trim();
    if (current) {
      resolved = current;
      return auth;
    }
    resolved = generateInstanceId();
    return { ...auth, instanceId: resolved };
  }, env);
  return resolved;
}

function normalizeRemoteAlias(alias: string): string {
  const normalized = alias.trim();
  if (!normalized || /\s/.test(normalized)) {
    throw new Error("Remote alias must be a non-empty name without whitespace.");
  }
  return normalized;
}

export function writeForgeRelayRemote(
  alias: string,
  remote: ForgeRelayRemoteRecord,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedAlias = normalizeRemoteAlias(alias);
  return updateForgeRelayAuth((auth) => {
    const remotes = { ...(auth.remotes ?? {}) };
    const existing = remotes[normalizedAlias];
    if (existing && existing.instanceId !== remote.instanceId) {
      throw new Error(`Remote alias ${normalizedAlias} already belongs to another ForgeRelay instance.`);
    }
    const duplicate = Object.entries(remotes).find(
      ([name, record]) => name !== normalizedAlias && record.instanceId === remote.instanceId,
    );
    if (duplicate) {
      throw new Error(`ForgeRelay instance is already registered as ${duplicate[0]}; rename that remote instead.`);
    }
    remotes[normalizedAlias] = remote;
    return { ...auth, remotes };
  }, env);
}


export function renameForgeRelayRemote(
  fromAlias: string,
  toAlias: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const from = normalizeRemoteAlias(fromAlias);
  const to = normalizeRemoteAlias(toAlias);
  return updateForgeRelayAuth((auth) => {
    const remotes = { ...(auth.remotes ?? {}) };
    const remote = remotes[from];
    if (!remote) throw new Error(`Unknown remote alias: ${from}`);
    if (from !== to && remotes[to]) throw new Error(`Remote alias already exists: ${to}`);
    delete remotes[from];
    remotes[to] = remote;
    return { ...auth, remotes };
  }, env);
}

export function removeForgeRelayRemote(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalizedAlias = normalizeRemoteAlias(alias);
  return updateForgeRelayAuth((auth) => {
    const remotes = { ...(auth.remotes ?? {}) };
    if (!remotes[normalizedAlias]) throw new Error(`Unknown remote alias: ${normalizedAlias}`);
    delete remotes[normalizedAlias];
    return { ...auth, remotes };
  }, env);
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

function updateForgeRelayAuth(
  update: (auth: ForgeRelayAuthConfig) => ForgeRelayAuthConfig,
  env: NodeJS.ProcessEnv,
): string {
  const filePath = forgerelayAuthPath(env);
  mkdirSync(forgerelayConfigDir(env), { recursive: true });
  return withAuthFileLock(filePath, () => {
    const auth = existsSync(filePath) ? readJsonFile<ForgeRelayAuthConfig>(filePath) : {};
    writeJsonFile(filePath, update(auth), 0o600);
    return filePath;
  });
}

function withAuthFileLock<T>(filePath: string, operation: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      closeSync(fd);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > AUTH_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ForgeRelay auth lock: ${lockPath}`);
      }
      Atomics.wait(AUTH_LOCK_SLEEP, 0, 0, AUTH_LOCK_RETRY_MS);
    }
  }

  try {
    return operation();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function writeJsonFile(filePath: string, value: unknown, mode: number): void {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", { mode });
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
