import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(repoRoot, "package.json");
const lockPath = resolve(repoRoot, "package-lock.json");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");
const noticePath = resolve(repoRoot, "NOTICE.md");
const licensePath = resolve(repoRoot, "LICENSE");
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const expectedPackageName = "@akira-tl/forgerelay";
const expectedRepositoryUrl = "git+https://github.com/Akira-TL/forgerelay.git";
const expectedHomepage = "https://github.com/Akira-TL/forgerelay#readme";
const expectedBugsUrl = "https://github.com/Akira-TL/forgerelay/issues";

const [command = "check", argument, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run") || argument === "--dry-run";
const value = argument === "--dry-run" ? undefined : argument;
const state = await readState();

switch (command) {
  case "check":
    checkState(state);
    console.log(`release metadata is consistent at ${state.pkg.version}`);
    break;
  case "tag": {
    checkState(state);
    if (!value) fail("usage: node scripts/release-version.mjs tag vX.Y.Z[-rc.N]");
    if (getUnreleasedBody(state.changelog)) {
      fail("CHANGELOG.md still has Unreleased changes; prepare the next version before creating a release tag");
    }
    const expectedTag = `v${state.pkg.version}`;
    if (value !== expectedTag) {
      fail(`tag ${JSON.stringify(value)} does not match package version; expected ${expectedTag}`);
    }
    console.log(`release tag ${value} matches package version and changelog`);
    break;
  }
  case "prepare": {
    checkState(state);
    if (!value || !releaseVersionPattern.test(value)) {
      fail("usage: node scripts/release-version.mjs prepare X.Y.Z[-rc.N] [--dry-run]");
    }
    await prepareRelease(state, value, dryRun);
    break;
  }
  case "next": {
    checkState(state);
    const bump = value ?? "patch";
    if (!new Set(["patch", "minor", "major"]).has(bump)) {
      fail("usage: node scripts/release-version.mjs next [patch|minor|major] [--dry-run]");
    }
    await prepareRelease(state, incrementVersion(state.pkg.version, bump), dryRun);
    break;
  }
  case "notes": {
    checkState(state);
    if (!value) fail("usage: node scripts/release-version.mjs notes vX.Y.Z[-rc.N]");
    const version = value.startsWith("v") ? value.slice(1) : value;
    if (!releaseVersionPattern.test(version)) {
      fail(`release notes version ${JSON.stringify(value)} must be vX.Y.Z[-rc.N] or X.Y.Z[-rc.N]`);
    }
    const body = getReleaseBody(state.changelog, version);
    if (!body) fail(`CHANGELOG.md has no release notes for ${version}`);
    process.stdout.write(`${body}\n`);
    break;
  }
  default:
    fail(`unknown release command ${JSON.stringify(command)}; expected check, tag, prepare, next, or notes`);
}

async function readState() {
  const [packageText, lockText, changelog, notice, license] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(changelogPath, "utf8"),
    readFile(noticePath, "utf8"),
    readFile(licensePath, "utf8"),
  ]);

  return {
    packageText,
    lockText,
    changelog,
    notice,
    license,
    pkg: JSON.parse(packageText),
    lock: JSON.parse(lockText),
  };
}

function checkState(state) {
  const version = state.pkg.version;
  if (state.pkg.name !== expectedPackageName) {
    fail(`unexpected package name ${JSON.stringify(state.pkg.name)}; expected ${expectedPackageName}`);
  }
  if (typeof version !== "string" || !releaseVersionPattern.test(version)) {
    fail(`package version ${JSON.stringify(version)} must be X.Y.Z or X.Y.Z-rc.N`);
  }
  if (state.pkg.repository?.url !== expectedRepositoryUrl) {
    fail(`package repository.url must be ${expectedRepositoryUrl} for GitHub/npm trusted publishing`);
  }
  if (state.pkg.homepage !== expectedHomepage) {
    fail(`package homepage must be ${expectedHomepage}`);
  }
  if (state.pkg.bugs?.url !== expectedBugsUrl) {
    fail(`package bugs.url must be ${expectedBugsUrl}`);
  }
  if (state.pkg.publishConfig?.access !== "public") {
    fail("package publishConfig.access must be public");
  }
  if (state.pkg.publishConfig?.tag !== "latest") {
    fail("package publishConfig.tag must be latest");
  }
  if (state.pkg.bin?.forgerelay !== "dist/cli.js") {
    fail("package bin.forgerelay must point to dist/cli.js");
  }
  if (state.lock.name !== expectedPackageName || state.lock.version !== version) {
    fail("package-lock.json root name/version does not match package.json");
  }
  if (state.lock.packages?.[""]?.name !== expectedPackageName || state.lock.packages?.[""]?.version !== version) {
    fail("package-lock root package name/version does not match package.json");
  }
  if (!state.changelog.includes("## [Unreleased]")) {
    fail("CHANGELOG.md is missing ## [Unreleased]");
  }
  if (!state.changelog.includes(`## [${version}]`)) {
    fail(`CHANGELOG.md is missing the current release heading ## [${version}]`);
  }
  checkAttribution(state);
}

function checkAttribution(state) {
  if (!state.license.includes("Copyright (c) 2026 Waishnav")) {
    fail("LICENSE must preserve the upstream Waishnav copyright notice");
  }
  if (!state.license.includes("Copyright (c) 2026 Akira-TL, modifications")) {
    fail("LICENSE must identify Akira-TL modifications");
  }
  if (!state.notice.includes("https://github.com/Waishnav/devspace")) {
    fail("NOTICE.md must identify the upstream DevSpace repository");
  }
  if (!state.notice.includes("independently maintained by Akira-TL")) {
    fail("NOTICE.md must identify this distribution as independently maintained by Akira-TL");
  }
  if (!state.pkg.files?.includes("NOTICE.md")) {
    fail("package files must include NOTICE.md");
  }
}

async function prepareRelease(state, nextVersion, dryRun) {
  const nextChangelog = promoteUnreleased(state.changelog, nextVersion);
  const nextPackage = { ...state.pkg, version: nextVersion };
  const nextLock = structuredClone(state.lock);
  nextLock.version = nextVersion;
  nextLock.packages[""].version = nextVersion;

  if (dryRun) {
    console.log(`${state.pkg.version} -> ${nextVersion}`);
    console.log("dry run only; no files changed");
    return;
  }

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`),
    writeFile(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`),
    writeFile(changelogPath, nextChangelog),
  ]);

  console.log(`${state.pkg.version} -> ${nextVersion}`);
  console.log("updated package.json, package-lock.json, and CHANGELOG.md");
  console.log("next: review the diff, commit and push the release-ready tree, then push the matching release tag; cloud CI is the authoritative release verification");
}

function promoteUnreleased(changelog, nextVersion) {
  const unreleasedBody = getUnreleasedBody(changelog);
  if (!unreleasedBody) {
    fail("CHANGELOG.md Unreleased section is empty; add release notes before preparing a release");
  }
  if (changelog.includes(`## [${nextVersion}]`)) {
    fail(`CHANGELOG.md already contains release ${nextVersion}`);
  }

  const heading = "## [Unreleased]";
  const headingIndex = changelog.indexOf(heading);
  const bodyStart = headingIndex + heading.length;
  const nextHeadingIndex = changelog.indexOf("\n## [", bodyStart);
  const bodyEnd = nextHeadingIndex < 0 ? changelog.length : nextHeadingIndex;
  const date = new Date().toISOString().slice(0, 10);
  const replacement = `${heading}\n\n## [${nextVersion}] - ${date}\n\n${unreleasedBody}\n`;
  return `${changelog.slice(0, headingIndex)}${replacement}${changelog.slice(bodyEnd)}`;
}

function getUnreleasedBody(changelog) {
  const heading = "## [Unreleased]";
  const headingIndex = changelog.indexOf(heading);
  if (headingIndex < 0) return "";
  const bodyStart = headingIndex + heading.length;
  const nextHeadingIndex = changelog.indexOf("\n## [", bodyStart);
  const bodyEnd = nextHeadingIndex < 0 ? changelog.length : nextHeadingIndex;
  return changelog.slice(bodyStart, bodyEnd).trim();
}

function getReleaseBody(changelog, version) {
  const heading = `## [${version}]`;
  const headingIndex = changelog.indexOf(heading);
  if (headingIndex < 0) return "";
  const headingEnd = changelog.indexOf("\n", headingIndex);
  const bodyStart = headingEnd < 0 ? changelog.length : headingEnd + 1;
  const nextHeadingIndex = changelog.indexOf("\n## [", bodyStart);
  const bodyEnd = nextHeadingIndex < 0 ? changelog.length : nextHeadingIndex;
  return changelog.slice(bodyStart, bodyEnd).trim();
}

function incrementVersion(version, bump) {
  const match = version.match(stableVersionPattern);
  if (!match) fail(`cannot increment invalid stable version ${JSON.stringify(version)}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function fail(message) {
  console.error(`release-version: ${message}`);
  process.exit(1);
}
