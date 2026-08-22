import { spawn } from "node:child_process";
import {
  createInteractiveDebugEnvironment,
  repoRoot,
} from "../runtime.mjs";

const { configDir, env } = createInteractiveDebugEnvironment();
const hostPort = parseHostPort(process.env.FORGERELAY_DEBUG_HOST_PORT);
const localBaseUrl = `http://127.0.0.1:${hostPort}`;
const localMcpUrl = `${localBaseUrl}/mcp`;

// The normal interactive debug profile may mirror the product's public tunnel.
// A local MCP Apps Host must instead receive localhost resource and asset URLs,
// otherwise the Inspector ends up exercising the remote deployment again.
env.HOST = "127.0.0.1";
env.PORT = String(hostPort);
env.FORGERELAY_PUBLIC_BASE_URL = localBaseUrl;
env.FORGERELAY_WIDGETS = process.env.FORGERELAY_DEBUG_WIDGETS ?? "full";

console.error("[forgerelay:debug-host] local MCP Apps Host server");
console.error(`[forgerelay:debug-host] debug config: ${configDir}/config.json`);
console.error(`[forgerelay:debug-host] health: ${localBaseUrl}/healthz`);
console.error(`[forgerelay:debug-host] MCP: ${localMcpUrl}`);
console.error(`[forgerelay:debug-host] public base override: ${localBaseUrl}`);
console.error(`[forgerelay:debug-host] widgets: ${env.FORGERELAY_WIDGETS}`);
console.error(`[forgerelay:debug-host] Owner password loaded from ${configDir}/auth.json`);
console.error("[forgerelay:debug-host] all runtime state is under .forgerelay-debug/");

const child = spawn(process.execPath, ["scripts/dev-server.mjs"], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

function parseHostPort(value) {
  if (value === undefined || value === "") return 7677;
  if (!/^\d+$/.test(value)) {
    throw new Error("FORGERELAY_DEBUG_HOST_PORT must be an integer from 1 to 65535.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FORGERELAY_DEBUG_HOST_PORT must be an integer from 1 to 65535.");
  }
  return port;
}
