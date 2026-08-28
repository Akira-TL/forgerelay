#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("ci:verify must be launched through npm so npm_execpath is available");
}

console.log(`CI environment: ${process.platform}/${process.arch} ${process.version}`);
runNpm(["--version"], "npm version");
runNpm(["run", "release:check"], "Release metadata");
runNpm(["run", "typecheck"], "Typecheck");
runNpm(["test"], "Full test suite");
runNpm(["run", "build"], "Build");
runNpm(["run", "lsp:interop"], "Optional LSP interoperability");
run(process.execPath, ["dist/cli.js", "doctor"], "Doctor");

console.log("CI verification passed.");

function runNpm(args, label) {
  run(process.execPath, [npmCli, ...args], label);
}

function run(command, args, label) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "unknown"}`);
  }
}
