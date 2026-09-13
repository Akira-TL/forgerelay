#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:pack must be launched through npm so npm_execpath is available");
}

const repoRoot = process.cwd();
const outputDir = resolve(repoRoot, process.env.RELEASE_ARTIFACT_DIR ?? ".release-artifacts");
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [npmCli, "pack", "--json", "--pack-destination", outputDir],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  },
);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  throw new Error(`npm pack failed with exit ${result.status ?? "unknown"}`);
}

const packages = readdirSync(outputDir).filter((name) => name.endsWith(".tgz"));
if (packages.length !== 1) {
  throw new Error(`release:pack expected exactly one .tgz artifact, found ${packages.length}`);
}

const report = parsePackReport(result.stdout);
const packagedPaths = new Set(report.files.map((file) => file.path));
const expectedSchemas = readdirSync(resolve(repoRoot, "schemas", "v1"))
  .filter((name) => name.endsWith(".schema.json"))
  .map((name) => `schemas/v1/${name}`)
  .sort();
if (expectedSchemas.length === 0) {
  throw new Error("release:pack expected at least one generated Config System v1 schema");
}
const missingSchemas = expectedSchemas.filter((path) => !packagedPaths.has(path));
if (missingSchemas.length > 0) {
  throw new Error(`release:pack omitted generated Config schemas: ${missingSchemas.join(", ")}`);
}

const expectedRuntimeResources = [
  "dist/cli.js",
  ...collectPackageFiles(resolve(repoRoot, "templates"), "templates"),
  ...collectPackageFiles(resolve(repoRoot, "capabilities"), "capabilities"),
].sort();
const missingRuntimeResources = expectedRuntimeResources.filter((path) => !packagedPaths.has(path));
if (missingRuntimeResources.length > 0) {
  throw new Error(
    `release:pack omitted ForgeRelay-owned runtime resources: ${missingRuntimeResources.join(", ")}`,
  );
}

console.log(`Verified npm artifact: ${packages[0]}`);
console.log(`Verified packaged Config schemas: ${expectedSchemas.join(", ")}`);
console.log(`Verified packaged ForgeRelay-owned runtime resources: ${expectedRuntimeResources.join(", ")}`);

function collectPackageFiles(directory, prefix) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectPackageFiles(resolve(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function parsePackReport(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`npm pack did not return valid JSON metadata: ${reason}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0]?.files)) {
    throw new Error("npm pack returned an unexpected JSON report");
  }
  return parsed[0];
}
