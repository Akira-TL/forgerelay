import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const debugConfigDir = resolve(repoRoot, "scripts", "debug");
export const debugRoot = resolve(repoRoot, ".forgerelay-debug");
export const debugHookRecorder = resolve(debugConfigDir, "hook-recorder.mjs");
export const debugHookLog = resolve(debugRoot, "hooks.jsonl");
export const debugBaseUrl = "http://127.0.0.1:7677";
export const debugMcpUrl = `${debugBaseUrl}/mcp`;

export function createDebugOwnerToken() {
  return randomBytes(32).toString("base64url");
}

export function productConfigDir({ env = process.env, home = homedir() } = {}) {
  const explicit = env.FORGERELAY_CONFIG_DIR ?? env.DEVSPACE_CONFIG_DIR;
  if (explicit) return resolve(explicit.startsWith("~/") ? join(home, explicit.slice(2)) : explicit);

  const current = join(home, ".forgerelay");
  const legacy = join(home, ".devspace");
  return resolve(existsSync(current) || !existsSync(legacy) ? current : legacy);
}

export function productOwnerToken({ env = process.env, configDir = productConfigDir({ env }) } = {}) {
  const environmentToken = env.FORGERELAY_OAUTH_OWNER_TOKEN ?? env.DEVSPACE_OAUTH_OWNER_TOKEN;
  if (environmentToken?.trim()) return environmentToken.trim();

  const authPath = join(configDir, "auth.json");
  let auth;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load product Owner password from ${authPath}: ${reason}`);
  }

  const token = typeof auth.ownerToken === "string" ? auth.ownerToken.trim() : "";
  if (!token) {
    throw new Error(`Product Owner password is missing from ${authPath}. Run: forgerelay init`);
  }
  return token;
}

export function createProductDebugEnvironment({
  env = process.env,
  home = homedir(),
  stateDir = resolve(debugRoot, "state"),
  worktreeRoot = resolve(debugRoot, "worktrees"),
} = {}) {
  const configDir = productConfigDir({ env, home });
  const ownerToken = env.FORGERELAY_DEBUG_OWNER_TOKEN?.trim() || productOwnerToken({ env, configDir });
  mkdirSync(debugRoot, { recursive: true });

  const debugEnv = {
    ...env,
    HOST: "127.0.0.1",
    PORT: "7677",
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_WORKTREE_ROOT: worktreeRoot,
  };
  if (env.FORGERELAY_DEBUG_OWNER_TOKEN?.trim()) {
    debugEnv.FORGERELAY_OAUTH_OWNER_TOKEN = ownerToken;
  }
  if (env.FORGERELAY_DEBUG_WIDGETS !== undefined) {
    debugEnv.FORGERELAY_WIDGETS = env.FORGERELAY_DEBUG_WIDGETS;
  }

  return { ownerToken, configDir, env: debugEnv };
}

export function createDebugEnvironment({
  ownerToken,
  stateDir = resolve(debugRoot, "state"),
  worktreeRoot = resolve(debugRoot, "worktrees"),
  hookLog = debugHookLog,
  widgets = process.env.FORGERELAY_DEBUG_WIDGETS ?? "off",
} = {}) {
  const token = ownerToken ?? process.env.FORGERELAY_DEBUG_OWNER_TOKEN ?? createDebugOwnerToken();
  mkdirSync(debugRoot, { recursive: true });

  return {
    ownerToken: token,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "7677",
      FORGERELAY_CONFIG_DIR: debugConfigDir,
      FORGERELAY_PUBLIC_BASE_URL: debugBaseUrl,
      FORGERELAY_ALLOWED_ROOTS: repoRoot,
      FORGERELAY_STATE_DIR: stateDir,
      FORGERELAY_WORKTREE_ROOT: worktreeRoot,
      FORGERELAY_OAUTH_OWNER_TOKEN: token,
      FORGERELAY_TOOL_MODE: "full",
      FORGERELAY_WIDGETS: widgets,
      FORGERELAY_LOG_LEVEL: process.env.FORGERELAY_LOG_LEVEL ?? "info",
      FORGERELAY_LOG_FORMAT: process.env.FORGERELAY_LOG_FORMAT ?? "pretty",
      FORGERELAY_DEBUG_HOOK_RECORDER: debugHookRecorder,
      FORGERELAY_DEBUG_HOOK_LOG: hookLog,
    },
  };
}
