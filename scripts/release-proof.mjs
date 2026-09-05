#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROOF_VERSION = 1;
const PROOF_RELATIVE_PATH = join("forgerelay", "release-proof.json");
const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const DEFAULT_GITHUB_API_URL = "https://api.github.com/";

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

function packageMetadata() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json must contain a version string");
  }
  return pkg;
}

function packageVersion() {
  return packageMetadata().version;
}

function requireDedicatedReleaseNotes(version) {
  const path = join(process.cwd(), "docs", "releases", `v${version}.md`);
  let notes;
  try {
    notes = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`missing dedicated release notes: docs/releases/v${version}.md`);
    }
    throw error;
  }
  if (!notes.trim()) throw new Error(`dedicated release notes are empty: docs/releases/v${version}.md`);
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

function assertReleaseTreeClean(context) {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(`working tree differs from HEAD or contains untracked files; commit or remove every release input before ${context}`);
  }
}

function writeProof() {
  assertReleaseTreeClean("running release:verify");
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

function checkProof() {
  assertReleaseTreeClean("using the local release proof");
  const proof = readProof();
  const head = currentHead();
  const version = packageVersion();
  if (proof.head !== head) {
    throw new Error(`release proof is for ${proof.head.slice(0, 12)}, but current HEAD is ${head.slice(0, 12)}. Run npm run release:verify again`);
  }
  if (proof.packageVersion !== version) {
    throw new Error(`release proof is for package ${proof.packageVersion}, but package.json is ${version}. Run npm run release:verify again`);
  }
  console.log(`Release proof OK: ${head.slice(0, 12)} (${version}).`);
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
  const deleting = /(?:^|\s)(?:-d|--delete)(?=$|\s)/.test(pushCommand);
  const tagMatch = /(?:^|\s)(?:tag\s+)?(?:refs\/tags\/)?(v\d+\.\d+\.\d+(?:-rc\.\d+)?)(?=$|\s)/.exec(pushCommand);
  if (!tagMatch?.[1]) {
    throw new Error("release Hook payload does not contain a release tag push");
  }
  return { tag: tagMatch[1], deleting };
}

function githubRepositorySlug(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("package.json must contain a GitHub repository URL before rebuilding a release tag");
  }
  const normalized = raw.trim().replace(/^git\+/, "").replace(/\.git$/, "");
  const match = /github\.com(?::|\/)([^/\s]+\/[^/\s]+)$/.exec(normalized);
  if (!match?.[1]) {
    throw new Error(`unable to determine GitHub repository from package.json repository URL: ${raw}`);
  }
  return match[1];
}

function testEndpoint(name, fallback) {
  if (process.env.NODE_ENV === "test" && process.env[name]) return process.env[name];
  return fallback;
}

async function artifactExists(label, url, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to verify ${label} before deleting the release tag: ${detail}`);
  }
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`unable to verify ${label} before deleting the release tag: HTTP ${response.status}`);
}

async function assertReleaseTagMutable(tag, version) {
  const pkg = packageMetadata();
  if (typeof pkg.name !== "string" || !pkg.name) {
    throw new Error("package.json must contain a package name before rebuilding a release tag");
  }
  const repository = githubRepositorySlug(pkg.repository);
  const npmBase = testEndpoint("FORGERELAY_TEST_NPM_REGISTRY_URL", DEFAULT_NPM_REGISTRY_URL);
  const githubBase = testEndpoint("FORGERELAY_TEST_GITHUB_API_URL", DEFAULT_GITHUB_API_URL);
  const npmUrl = new URL(`${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`, npmBase).toString();
  const githubUrl = new URL(
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    githubBase,
  ).toString();
  const [npmPublished, githubReleased] = await Promise.all([
    artifactExists(`npm package ${pkg.name}@${version}`, npmUrl),
    artifactExists(`GitHub Release ${tag}`, githubUrl, {
      Accept: "application/vnd.github+json",
      "User-Agent": "ForgeRelay-release-tag-gate",
    }),
  ]);
  if (npmPublished) {
    throw new Error(`npm package ${pkg.name}@${version} already exists; release tag ${tag} is immutable`);
  }
  if (githubReleased) {
    throw new Error(`GitHub Release ${tag} already exists; release tag ${tag} is immutable`);
  }
}

async function checkHookTag() {
  assertReleaseTreeClean("pushing a release tag");
  const head = currentHead();
  const version = packageVersion();
  const { tag, deleting } = hookTag();
  const expectedTag = `v${version}`;

  if (tag !== expectedTag) {
    throw new Error(`tag ${tag} does not match package version ${version}; expected ${expectedTag}`);
  }
  requireDedicatedReleaseNotes(version);

  let tagHead;
  try {
    tagHead = git(["rev-parse", `${tag}^{commit}`]);
  } catch {
    throw new Error(`local tag ${tag} does not exist or does not resolve to a commit`);
  }

  if (deleting) {
    checkProof();
    await assertReleaseTagMutable(tag, version);
    console.log(
      `Release tag rebuild gate OK: ${tag}; npm package and GitHub Release are absent, so the existing tag may be deleted and rebuilt.`,
    );
    return;
  }

  if (tagHead !== head) {
    throw new Error(`tag ${tag} points to ${tagHead.slice(0, 12)}, but current HEAD is ${head.slice(0, 12)}`);
  }

  console.log(`Release tag gate OK: ${tag} -> ${head.slice(0, 12)}; cloud CI will perform release verification.`);
}

const action = process.argv[2];
try {
  if (action === "write") writeProof();
  else if (action === "check") checkProof();
  else if (action === "check-hook") await checkHookTag();
  else throw new Error("usage: node scripts/release-proof.mjs <write|check|check-hook>");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
