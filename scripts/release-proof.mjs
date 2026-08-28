#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROOF_VERSION = 1;
const PROOF_RELATIVE_PATH = join("forgerelay", "release-proof.json");

function fail(message) {
  console.error(`Release proof failed: ${message}`);
  process.exitCode = 1;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json must contain a version string");
  }
  return pkg.version;
}

function gitDir() {
  const path = git(["rev-parse", "--git-dir"]);
  return path.startsWith("/") ? path : join(process.cwd(), path);
}

function proofPath() {
  return process.env.FORGERELAY_RELEASE_PROOF_PATH ?? join(gitDir(), PROOF_RELATIVE_PATH);
}

function currentHead() {
  return git(["rev-parse", "HEAD"]);
}

function assertReleaseTreeClean() {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error("working tree differs from HEAD or contains untracked files; commit or remove every release input before running release:verify");
  }
}

function writeProof() {
  assertReleaseTreeClean();
  const proof = {
    proofVersion: PROOF_VERSION,
    head: currentHead(),
    packageVersion: packageVersion(),
    verifiedAt: new Date().toISOString(),
  };
  const path = proofPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  console.log(`Release verification proof recorded for ${proof.head.slice(0, 12)} (${proof.packageVersion}).`);
}

function readProof() {
  const path = proofPath();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`no valid local release proof at ${path}: ${detail}. Run npm run release:verify on the committed release HEAD first`);
  }
  if (
    parsed?.proofVersion !== PROOF_VERSION ||
    typeof parsed?.head !== "string" ||
    typeof parsed?.packageVersion !== "string" ||
    typeof parsed?.verifiedAt !== "string"
  ) {
    throw new Error(`invalid release proof format at ${path}; run npm run release:verify again`);
  }
  return parsed;
}

function hookTag() {
  let payload;
  try {
    payload = JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}");
  } catch {
    throw new Error("FORGERELAY_HOOK_PAYLOAD is not valid JSON");
  }
  const command = typeof payload.originalCommand === "string"
    ? payload.originalCommand
    : typeof payload.command === "string"
      ? payload.command
      : "";
  const pushMatch = /git\s+push\b([^;&|\n]*)/.exec(command);
  if (!pushMatch?.[0] || !/\borigin\b/.test(pushMatch[0])) {
    throw new Error("release Hook payload does not contain an origin release tag push");
  }
  const pushCommand = pushMatch[0];
  if (/(?:^|\s)(?:-f|--force(?:-with-lease)?)(?:=\S*)?(?=$|\s)/.test(pushCommand)
    || /(?:^|\s)\+(?:refs\/tags\/)?v\d+\.\d+\.\d+(?:-rc\.\d+)?(?=$|\s)/.test(pushCommand)) {
    throw new Error("force push is not allowed for release tags");
  }
  if (/(?:^|\s)(?:-d|--delete)(?=$|\s)/.test(pushCommand)) {
    throw new Error("deleting a release tag is not allowed");
  }
  const tagMatch = /(?:^|\s)(?:tag\s+)?(?:refs\/tags\/)?(v\d+\.\d+\.\d+(?:-rc\.\d+)?)(?=$|\s)/.exec(pushCommand);
  if (!tagMatch?.[1]) {
    throw new Error("release Hook payload does not contain a release tag push");
  }
  return tagMatch[1];
}

function checkHookProof() {
  assertReleaseTreeClean();
  const proof = readProof();
  const head = currentHead();
  const version = packageVersion();
  const tag = hookTag();
  const expectedTag = `v${version}`;

  if (proof.head !== head) {
    throw new Error(`release proof is for ${proof.head.slice(0, 12)}, but current HEAD is ${head.slice(0, 12)}; rerun npm run release:verify`);
  }
  if (proof.packageVersion !== version) {
    throw new Error(`release proof is for package ${proof.packageVersion}, but package.json is ${version}; rerun npm run release:verify`);
  }
  if (tag !== expectedTag) {
    throw new Error(`tag ${tag} does not match package version ${version}; expected ${expectedTag}`);
  }

  let tagHead;
  try {
    tagHead = git(["rev-parse", `${tag}^{commit}`]);
  } catch {
    throw new Error(`local tag ${tag} does not exist or does not resolve to a commit`);
  }
  if (tagHead !== head) {
    throw new Error(`tag ${tag} points to ${tagHead.slice(0, 12)}, but verified HEAD is ${head.slice(0, 12)}`);
  }

  console.log(`Release proof OK: ${tag} -> ${head.slice(0, 12)} (${proof.verifiedAt}).`);
}

const action = process.argv[2];
try {
  if (action === "write") writeProof();
  else if (action === "check-hook") checkHookProof();
  else throw new Error("usage: node scripts/release-proof.mjs <write|check-hook>");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
