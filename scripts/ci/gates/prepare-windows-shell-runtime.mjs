#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveAcceptanceTarball } from "./acceptance-artifact.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Windows shell runtime preparation must run through npm so npm_execpath is available");

const repoRoot = process.cwd();
const configuredRoot = process.env.FORGERELAY_ACCEPTANCE_RUNTIME_ROOT?.trim();
const runtimeRoot = resolve(repoRoot, configuredRoot || ".release-runtime");
rmSync(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const artifactDir = join(runtimeRoot, ".artifact-fallback");
await mkdir(artifactDir, { recursive: true });
const tarball = resolveAcceptanceTarball({ repoRoot, artifactDir, npmCli });
const tarExecutable = process.platform === "win32" ? "tar.exe" : "tar";
const unpack = spawnSync(
  tarExecutable,
  ["-xzf", tarball, "-C", runtimeRoot, "--strip-components=1"],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 60_000,
  },
);
if (unpack.error || unpack.status !== 0) {
  throw new Error(
    `Acceptance runtime unpack failed: ${unpack.error?.message ?? unpack.stderr ?? unpack.stdout ?? unpack.status}`,
  );
}

for (const expected of [join(runtimeRoot, "package.json"), join(runtimeRoot, "dist", "cli.js")]) {
  assert.ok(existsSync(expected), `Unpacked acceptance runtime is missing: ${expected}`);
}

console.log(`Prepared shell runtime directly from ${tarball} at ${runtimeRoot}.`);
