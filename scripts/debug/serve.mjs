import { spawn } from "node:child_process";
import { createDebugEnvironment, debugBaseUrl, debugConfigDir, debugHookLog, debugMcpUrl, repoRoot } from "./runtime.mjs";

const { ownerToken, env } = createDebugEnvironment();

console.error("[forgerelay:debug] local debug server");
console.error(`[forgerelay:debug] config: ${debugConfigDir}/config.json`);
console.error(`[forgerelay:debug] health: ${debugBaseUrl}/healthz`);
console.error(`[forgerelay:debug] MCP: ${debugMcpUrl}`);
console.error(`[forgerelay:debug] hook log: ${debugHookLog}`);
console.error(`[forgerelay:debug] Owner password: ${ownerToken}`);
console.error("[forgerelay:debug] all runtime state is under .forgerelay-debug/");

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
