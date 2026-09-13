#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAcceptancePrefix, resolveAcceptanceTarball } from "./acceptance-artifact.mjs";

if (process.platform !== "win32") {
  console.log("Prepared Windows product install skipped outside Windows.");
  process.exit(0);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Windows product preparation must run through npm so npm_execpath is available");

const repoRoot = process.cwd();
const prefix = resolveAcceptancePrefix(repoRoot);
if (!prefix) {
  throw new Error("FORGERELAY_ACCEPTANCE_PREFIX is required for the shared Windows product install.");
}

rmSync(prefix, { recursive: true, force: true });
await mkdir(prefix, { recursive: true });
const artifactDir = join(prefix, ".artifact-fallback");
await mkdir(artifactDir, { recursive: true });
const tarball = resolveAcceptanceTarball({ repoRoot, artifactDir, npmCli });

const install = spawnSync(
  process.execPath,
  [npmCli, "install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 240_000,
  },
);
if (install.error || install.status !== 0) {
  throw new Error(
    `Shared Windows product install failed: ${install.error?.message ?? install.stderr ?? install.stdout ?? install.status}`,
  );
}

const installedRoot = join(prefix, "node_modules", "@akira-tl", "forgerelay");
for (const expected of [
  join(installedRoot, "dist", "cli.js"),
  join(prefix, "forgerelay.cmd"),
  join(prefix, "forgerelay.ps1"),
]) {
  assert.ok(existsSync(expected), `Prepared Windows product install is missing: ${expected}`);
}

console.log(`Prepared shared Windows product install from ${tarball} at ${prefix}.`);
