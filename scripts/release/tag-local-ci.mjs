#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.19.0";
const NPM_VERSION = "10.9.3";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

main();

function main() {
  assertCleanReleaseHead();
  const tag = releaseTagFromHookPayload();
  assertTagMatchesReleaseHead(tag);

  const sandbox = mkdtempSync(join(tmpdir(), "forgerelay-release-hook-ci-"));
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
      ["npm", "ci"],
      `Node ${NODE_VERSION} / npm ${NPM_VERSION} install`,
    );
    runNodeNpm(sandbox, env, ["npm", "run", "release:check"], "Release metadata");
    runNodeNpm(sandbox, env, ["npm", "run", "typecheck"], "Typecheck");
    runNodeNpm(sandbox, env, ["npm", "test"], "Full test suite");
    runNodeNpm(sandbox, env, ["npm", "run", "build"], "Build");
    runNodeNpm(sandbox, env, ["npm", "run", "lsp:interop"], "Optional LSP interoperability");
    runNode(
      sandbox,
      env,
      ["dist/cli.js", "doctor"],
      "Doctor",
    );

    execFileSync(process.execPath, [join(repoRoot, "scripts", "release-proof.mjs"), "write"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    execFileSync(process.execPath, [join(repoRoot, "scripts", "release-proof.mjs"), "check-hook"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    console.log(`Release tag local CI passed for ${tag} with cloud-equivalent Node ${NODE_VERSION} checks.`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
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
  if (status) throw new Error("release tag local CI requires a clean working tree");
}

function releaseTagFromHookPayload() {
  let payload;
  try {
    payload = JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}");
  } catch {
    throw new Error("FORGERELAY_HOOK_PAYLOAD is not valid JSON");
  }
  const command = typeof payload.command === "string" ? payload.command : "";
  const match = /git\s+push\s+origin\s+(v\d+\.\d+\.\d+)/.exec(command);
  if (!match?.[1]) throw new Error("release Hook payload does not contain a stable tag push");
  return match[1];
}

function assertTagMatchesReleaseHead(tag) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const expectedTag = `v${pkg.version}`;
  if (tag !== expectedTag) throw new Error(`tag ${tag} does not match package version ${pkg.version}`);
  const head = git(["rev-parse", "HEAD"]);
  let tagHead;
  try {
    tagHead = git(["rev-parse", `${tag}^{commit}`]);
  } catch {
    throw new Error(`local tag ${tag} does not exist or does not resolve to a commit`);
  }
  if (tagHead !== head) {
    throw new Error(`tag ${tag} points to ${tagHead.slice(0, 12)}, but current HEAD is ${head.slice(0, 12)}`);
  }
}

function copyTrackedTree(sandbox) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  for (const relativePath of files) {
    const source = join(repoRoot, relativePath);
    const destination = join(sandbox, relativePath);
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

function runNode(cwd, env, args, label) {
  run(cwd, env, ["--yes", `node@${NODE_VERSION}`, ...args], label);
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
