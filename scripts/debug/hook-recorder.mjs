import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const logPath = process.env.FORGERELAY_DEBUG_HOOK_LOG;
if (!logPath) {
  throw new Error("FORGERELAY_DEBUG_HOOK_LOG is required by the debug hook recorder.");
}

let payload = {};
try {
  payload = JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}");
} catch {
  payload = { payloadParseError: true };
}

const entry = {
  ts: new Date().toISOString(),
  event: process.env.FORGERELAY_HOOK_EVENT,
  workspaceId: process.env.FORGERELAY_WORKSPACE_ID,
  workspaceRoot: process.env.FORGERELAY_WORKSPACE_ROOT,
  workspaceMode: process.env.FORGERELAY_WORKSPACE_MODE,
  sourceRoot: process.env.FORGERELAY_SOURCE_ROOT,
  tool: process.env.FORGERELAY_TOOL_NAME,
  path: payload.path,
  paths: payload.paths,
  status: payload.status,
  branch: payload.branch,
  targetBranch: payload.targetBranch,
  agentId: payload.agentId,
  profile: payload.profile,
  provider: payload.provider,
};

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
