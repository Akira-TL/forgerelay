#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:pack must be launched through npm so npm_execpath is available");
}

const outputDir = resolve(process.cwd(), process.env.RELEASE_ARTIFACT_DIR ?? ".release-artifacts");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [npmCli, "pack", "--pack-destination", outputDir],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm pack failed with exit ${result.status ?? "unknown"}`);
}

const packages = readdirSync(outputDir).filter((name) => name.endsWith(".tgz"));
if (packages.length !== 1) {
  throw new Error(`release:pack expected exactly one .tgz artifact, found ${packages.length}`);
}
console.log(`Verified npm artifact: ${packages[0]}`);
