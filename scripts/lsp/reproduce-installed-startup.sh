#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p logs
node --input-type=module - "$@" <<'JS' 2>&1 | tee logs/lsp-installed-startup.log
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const installed = process.argv[2] ?? resolve(dirname(process.execPath), "../lib/node_modules/@akira-tl/forgerelay");
const { CodeIntelligenceManager } = await import(pathToFileURL(join(installed, "dist/lsp/runtime/manager.js")));
const { ConfigRuntime } = await import(pathToFileURL(join(installed, "dist/runtime/config/runtime/config-runtime.js")));
await mkdir(".forgerelay-debug", { recursive: true });
const root = await mkdtemp(resolve(".forgerelay-debug/installed-startup-"));
const configDir = join(root, "config");
await mkdir(configDir);
await writeFile(join(root, "main.py"), "value: int = 1\n");
await writeFile(join(root, "pyrightconfig.json"), "{}\n");
await writeFile(join(configDir, "language-servers.json"), JSON.stringify({
  pyright: {
    command: process.execPath, args: [resolve("src/lsp/test-fixtures/fake-lsp-server.mjs")],
    env: { FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull" },
  },
}));
const manager = new CodeIntelligenceManager({ configDir, configRuntime: new ConfigRuntime() });
let initialized = false;
try {
  await manager.run(root, { operation: "diagnostics", path: "main.py" });
  initialized = true;
  console.log("Initialization succeeded.");
} catch (error) {
  console.error("Handled operation failure:", error.message);
} finally {
  await manager.shutdown();
}
await new Promise(resolveWait => setTimeout(resolveWait, 150));
assert.ok(initialized, "Initialization must succeed with the installed dependency graph.");
console.log("Host survived initialization cleanup.");
JS
