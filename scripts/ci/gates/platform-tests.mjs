#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("ci:platform-tests must run through npm so npm_execpath is available");

const tests = [
  "src/cli/mcp/diagnostics.test.ts",
  "src/runtime/shell/command-shell-runtime.test.ts",
  "src/runtime/state/lock/file-lock.test.ts",
  "src/runtime/state/runtime-lease.test.ts",
  "src/runtime/state/db/migrations.test.ts",
  "src/mcp/process/process-platform.test.ts",
  "src/mcp/process/process-sessions.test.ts",
  "src/mcp/filesystem/roots.test.ts",
  "src/mcp/filesystem/file-mutations.test.ts",
  "src/workspaces/state/workspace-store.test.ts",
  "src/workspaces.test.ts",
  "src/workspaces/conversation-checkout.test.ts",
  "src/workspaces/conversation-worktree.test.ts",
  "src/workspaces/git/worktree-recovery.test.ts",
];

console.log(`Platform-sensitive CI tests: ${process.platform}/${process.arch} (${tests.length} files).`);
for (const path of tests) {
  console.log(`\n== ${path} ==`);
  const result = spawnSync(process.execPath, [npmCli, "exec", "--", "tsx", path], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Platform-sensitive test failed with exit ${result.status ?? "unknown"}: ${path}`);
}
console.log("Platform-sensitive CI tests passed.");
