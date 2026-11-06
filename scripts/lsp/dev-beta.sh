#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p logs
node --input-type=module - "$@" <<'JS' 2>&1 | tee logs/lsp-beta-dev.log
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInteractiveDebugEnvironment, debugRoot } from "./scripts/debug/runtime.mjs";
import { loadConfig } from "./dist/runtime/config/config.js";

const { configDir, env } = createInteractiveDebugEnvironment();
const config = loadConfig(env);
const repoRoot = realpathSync(".");
const packageRoot = realpathSync(process.argv[2] ?? repoRoot);
const packageRelative = relative(repoRoot, packageRoot);
assert.ok(packageRelative !== ".." && !packageRelative.startsWith(`..${sep}`) && !isAbsolute(packageRelative),
  "Beta acceptance package must stay inside the repository.");
assert.equal(config.port, 7677, "Beta acceptance must use the dedicated dev port 7677.");
assert.equal(config.host, "127.0.0.1", "Beta acceptance must bind to loopback.");
const stateRelative = relative(realpathSync(debugRoot), realpathSync(config.stateDir));
assert.ok(stateRelative !== ".." && !stateRelative.startsWith(`..${sep}`) && !stateRelative.startsWith(sep),
  "Beta acceptance state must stay under .forgerelay-debug/.");
console.error(`[forgerelay:beta] config: ${configDir}; isolated state: ${config.stateDir}`);
console.error(`[forgerelay:beta] package: ${packageRoot}`);
const child = spawn(process.execPath, [join(packageRoot, "dist/cli.js"), "serve"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
JS
