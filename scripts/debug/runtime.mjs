import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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

export function interactiveDebugConfigDir({ env = process.env, home = homedir() } = {}) {
  const explicit = env.FORGERELAY_DEBUG_CONFIG_DIR;
  if (explicit) return resolve(explicit.startsWith("~/") ? join(home, explicit.slice(2)) : explicit);
  return resolve(join(home, ".forgerelay", "debug"));
}

export function interactiveDebugUrls(configDir) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
  } catch {
    // Keep the historical debug defaults when the selected config has not been created yet.
  }
  const configuredHost = typeof config.host === "string" && config.host.trim()
    ? config.host.trim()
    : "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
  const port = Number.isInteger(config.port) && config.port > 0 && config.port <= 65_535
    ? config.port
    : 7677;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const baseUrl = `http://${displayHost}:${port}`;
  return { baseUrl, mcpUrl: `${baseUrl}/mcp` };
}

function interactiveDebugOwnerToken(configDir) {
  const authPath = join(configDir, "auth.json");
  let auth;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load interactive debug Owner password from ${authPath}: ${reason}`);
  }

  const token = typeof auth.ownerToken === "string" ? auth.ownerToken.trim() : "";
  if (!token) {
    throw new Error(`Interactive debug Owner password is missing from ${authPath}.`);
  }
  return token;
}

export function createInteractiveDebugEnvironment({
  env = process.env,
  home = homedir(),
} = {}) {
  const configDir = interactiveDebugConfigDir({ env, home });
  const ownerToken = interactiveDebugOwnerToken(configDir);
  const { baseUrl, mcpUrl } = interactiveDebugUrls(configDir);
  mkdirSync(debugRoot, { recursive: true });

  const debugEnv = { ...env };
  for (const key of Object.keys(debugEnv)) {
    if (key === "HOST" || key === "PORT") {
      delete debugEnv[key];
      continue;
    }
    if (
      key.startsWith("FORGERELAY_")
      && !key.startsWith("FORGERELAY_LOG_")
      && !key.startsWith("FORGERELAY_DEBUG_")
    ) {
      delete debugEnv[key];
    }
  }
  debugEnv.FORGERELAY_CONFIG_DIR = configDir;

  return { ownerToken, configDir, baseUrl, mcpUrl, env: debugEnv };
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
