import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
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
