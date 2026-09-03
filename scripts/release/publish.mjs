#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repository = "Akira-TL/forgerelay";
const releaseTag = requiredEnv("RELEASE_TAG");
const packageDir = resolve(repoRoot, process.env.RELEASE_PACKAGE_DIR ?? ".release-package");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:publish must be launched through npm so npm_execpath is available");
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const expectedTag = `v${pkg.version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`release tag ${releaseTag} does not match package version ${pkg.version}; expected ${expectedTag}`);
}

const head = git(["rev-parse", "HEAD"]);
const tagHead = git(["rev-parse", `${releaseTag}^{commit}`]);
if (head !== tagHead) {
  throw new Error(`checked-out HEAD ${head.slice(0, 12)} does not match ${releaseTag} at ${tagHead.slice(0, 12)}`);
}
if (!gitSucceeds(["merge-base", "--is-ancestor", tagHead, "origin/main"])) {
  throw new Error(`${releaseTag} does not point to a commit contained in origin/main`);
}
const notesPath = prepareReleaseNotes(releaseTag);

const packages = readdirSync(packageDir).filter((name) => name.endsWith(".tgz"));
if (packages.length !== 1) {
  throw new Error(`release package directory must contain exactly one .tgz artifact, found ${packages.length}`);
}
const packagePath = join(packageDir, packages[0]);
const expectedPackageName = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
if (basename(packagePath) !== expectedPackageName) {
  throw new Error(`unexpected release artifact ${basename(packagePath)}; expected ${expectedPackageName}`);
}

const npmTag = pkg.version.includes("-rc.") ? "next" : "latest";
const packageSpec = `${pkg.name}@${pkg.version}`;
if (npmPackageExists(packageSpec)) {
  console.log(`${packageSpec} is already published; leaving npm unchanged.`);
} else {
  console.log(`Publishing verified artifact ${basename(packagePath)} with npm tag ${npmTag}.`);
  const publishEnv = { ...process.env };
  if (!publishEnv.NODE_AUTH_TOKEN) delete publishEnv.NODE_AUTH_TOKEN;
  runNpm(["publish", packagePath, "--access", "public", "--tag", npmTag], "npm publish", publishEnv);
}

if (ghReleaseExists(releaseTag)) {
  console.log(`GitHub Release ${releaseTag} already exists; leaving it unchanged.`);
} else {
  const args = [
    "release",
    "create",
    releaseTag,
    "--repo",
    repository,
    "--verify-tag",
    "--title",
    releaseTag,
    "--notes-file",
    notesPath,
  ];
  if (npmTag === "next") args.push("--prerelease");
  run("gh", args, "GitHub Release");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitSucceeds(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function npmPackageExists(spec) {
  const result = spawnSync(process.execPath, [npmCli, "view", spec, "version", "--json"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found/i.test(detail)) return false;
  throw new Error(`npm view failed while checking ${spec}: ${detail.trim() || `exit ${result.status ?? "unknown"}`}`);
}

function runNpm(args, label, env = process.env) {
  run(process.execPath, [npmCli, ...args], label, env);
}

function ghReleaseExists(tag) {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", repository], {
    cwd: repoRoot,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function prepareReleaseNotes(tag) {
  const manualNotes = join(repoRoot, "docs", "releases", `${tag}.md`);
  let notes;
  try {
    notes = readFileSync(manualNotes, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Missing dedicated release notes: docs/releases/${tag}.md`);
    }
    throw error;
  }
  if (!notes.trim()) throw new Error(`Dedicated release notes are empty: docs/releases/${tag}.md`);
  const tempRoot = resolve(process.env.RUNNER_TEMP ?? join(repoRoot, ".forgerelay-debug"));
  mkdirSync(tempRoot, { recursive: true });
  const notesPath = join(tempRoot, `release-notes-${tag}.md`);
  writeFileSync(notesPath, notes.endsWith("\n") ? notes : `${notes}\n`);
  return notesPath;
}

function run(command, args, label, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "unknown"}`);
  }
}
