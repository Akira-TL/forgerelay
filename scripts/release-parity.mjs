#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_VERSION = "11.19.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_VERSION = readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
const debugRoot = join(repoRoot, ".forgerelay-debug");
const sandbox = mkdtempSync(join(ensureDirectory(debugRoot), "release-parity-node22-"));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

assertCleanReleaseHead();

try {
  copyTrackedTree(sandbox);
  const env = {
    ...process.env,
    FORGERELAY_ALLOWED_ROOTS: sandbox,
    FORGERELAY_OAUTH_OWNER_TOKEN: "ci-owner-token-that-is-long-enough",
    FORGERELAY_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  };

  runNodeNpm(
    sandbox,
    env,
    ["npm", "ci", "--no-audit", "--no-fund"],
    `Node ${NODE_VERSION} / npm ${NPM_VERSION} install`,
  );
  runNodeNpm(sandbox, env, ["npm", "run", "ci:verify"], "Cloud verification entrypoint");
  runNodeNpm(sandbox, env, ["npm", "run", "release:pack"], "Cloud release packaging");

  console.log(
    `Release parity passed through ci:verify and release:pack on Node ${NODE_VERSION} / npm ${NPM_VERSION}.`,
  );
} finally {
  rmSync(sandbox, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertCleanReleaseHead() {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(
      "release parity requires a clean committed release HEAD; commit or remove every release input first",
    );
  }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  return `${path}/`;
}

function copyTrackedTree(destinationRoot) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  for (const relativePath of files) {
    const source = join(repoRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }
}

function runNodeNpm(cwd, env, command, label) {
  run(
    cwd,
    env,
    ["--yes", "-p", `node@${NODE_VERSION}`, "-p", `npm@${NPM_VERSION}`, "--", ...command],
    label,
  );
}

function run(cwd, env, args, label) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(npx, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? "unknown"}`);
}
