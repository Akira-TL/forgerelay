#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("ci:contract must run through npm so npm_execpath is available");

console.log(`Core CI contract: ${process.platform}/${process.arch} ${process.version}`);
runNpm(["--version"], "npm version");
runNpm(["run", "config:schema:check"], "Config schemas");
runNpm(["run", "architecture:check"], "Architecture");
runNpm(["run", "release:check"], "Release metadata");
runNpm(["run", "typecheck"], "Typecheck");
console.log("Core CI contract passed.");

function runNpm(args, label) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? "unknown"}`);
}
