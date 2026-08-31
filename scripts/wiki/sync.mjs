#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const sourceDirectory = join(repositoryRoot, "docs", "wiki");
const command = process.argv[2] ?? "check";

class WikiSyncError extends Error {}

try {
  if (!new Set(["check", "publish"]).has(command)) {
    fail(`Unknown wiki command: ${command}\nUsage: node scripts/wiki/sync.mjs <check|publish>`);
  }

  const sourceFiles = validateWikiSource(sourceDirectory);
  console.log(`Wiki source check passed (${sourceFiles.length} files).`);

  if (command === "publish") {
    publishWiki();
  }
} catch (error) {
  if (error instanceof WikiSyncError) {
    console.error(error.message);
  } else if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}

function validateWikiSource(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(`Wiki source directory does not exist: ${directory}`);
  }

  const files = listFiles(directory);
  const names = new Set(files.map((file) => file.relativePath));

  for (const required of ["Home.md", "_Sidebar.md"]) {
    if (!names.has(required)) {
      fail(`Wiki source is missing required page: ${required}`);
    }
  }

  const invalidNames = files
    .map((file) => file.relativePath)
    .filter((name) => !isSafeWikiPath(name));
  if (invalidNames.length > 0) {
    fail(`Wiki source contains unsupported paths:\n${invalidNames.map((name) => `- ${name}`).join("\n")}`);
  }

  const markdownNames = new Set(
    files
      .filter((file) => file.relativePath.endsWith(".md"))
      .map((file) => file.relativePath),
  );
  const brokenLinks = [];

  for (const file of files) {
    if (!file.relativePath.endsWith(".md")) continue;
    const text = readFileSync(file.absolutePath, "utf8");
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawTarget = match[1]?.trim();
      if (!rawTarget || isExternalOrAnchorLink(rawTarget)) continue;

      const target = decodeWikiTarget(rawTarget);
      if (!target) continue;
      if (target.startsWith("../") || target.startsWith("./")) {
        brokenLinks.push(`${file.relativePath}: relative repository link ${rawTarget}`);
        continue;
      }

      const candidate = target.endsWith(".md") ? target : `${target}.md`;
      if (!markdownNames.has(candidate)) {
        brokenLinks.push(`${file.relativePath}: ${rawTarget}`);
      }
    }
  }

  if (brokenLinks.length > 0) {
    fail(`Wiki source has unresolved local links:\n${brokenLinks.map((entry) => `- ${entry}`).join("\n")}`);
  }

  return files;
}

function publishWiki() {
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "Akira-TL/forgerelay";
  const remote = process.env.FORGERELAY_WIKI_REMOTE?.trim() || `git@github.com:${repository}.wiki.git`;
  const sourceRef = process.env.FORGERELAY_WIKI_SOURCE_REF?.trim() || currentSourceRef();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "forgerelay-wiki-"));
  const wikiCheckout = join(temporaryRoot, "wiki");

  try {
    const clone = runGit(["clone", "--quiet", remote, wikiCheckout], repositoryRoot, { allowFailure: true });
    if (clone.status !== 0) {
      const message = sanitizeGitOutput(`${clone.stdout}\n${clone.stderr}`, remote);
      if (/repository not found|not found/i.test(message)) {
        console.error(
          [
            "ForgeRelay GitHub Wiki has not been initialized yet.",
            `Create the first page once at https://github.com/${repository}/wiki, then rerun wiki publishing.`,
            "GitHub does not create the cloneable .wiki.git repository until the first Wiki page exists.",
          ].join("\n"),
        );
        process.exitCode = 2;
        return;
      }
      fail(`Could not clone the Wiki repository:\n${message || `git exited with ${clone.status}`}`);
    }

    mirrorSource(sourceDirectory, wikiCheckout);
    runGit(["add", "--all"], wikiCheckout);

    const diff = runGit(["diff", "--cached", "--quiet"], wikiCheckout, { allowFailure: true });
    if (diff.status === 0) {
      console.log("GitHub Wiki is already up to date.");
      return;
    }
    if (diff.status !== 1) {
      fail(`Could not inspect Wiki changes (git diff exited with ${diff.status}).`);
    }

    runGit(["config", "user.name", process.env.FORGERELAY_WIKI_GIT_NAME?.trim() || "ForgeRelay Wiki Sync"], wikiCheckout);
    runGit(
      [
        "config",
        "user.email",
        process.env.FORGERELAY_WIKI_GIT_EMAIL?.trim() || "41898282+github-actions[bot]@users.noreply.github.com",
      ],
      wikiCheckout,
    );
    runGit(["commit", "--quiet", "-m", `Sync Wiki from ${sourceRef}`], wikiCheckout);

    if (process.env.FORGERELAY_WIKI_DRY_RUN === "1") {
      console.log(`Wiki mirror prepared from ${sourceRef}; dry-run requested, skipping push.`);
      return;
    }

    const push = runGit(["push", "--quiet", "origin", "HEAD"], wikiCheckout, { allowFailure: true });
    if (push.status !== 0) {
      const message = sanitizeGitOutput(`${push.stdout}\n${push.stderr}`, remote);
      fail(`Could not push the Wiki mirror:\n${message || `git exited with ${push.status}`}`);
    }
    console.log(`Published GitHub Wiki from ${sourceRef}.`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function mirrorSource(source, destination) {
  for (const entry of readdirSync(destination)) {
    if (entry === ".git") continue;
    rmSync(join(destination, entry), { recursive: true, force: true });
  }

  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), { recursive: true });
  }
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath, relativePath));
      continue;
    }
    if (!entry.isFile()) {
      fail(`Wiki source contains a non-regular file: ${relativePath}`);
    }
    files.push({ relativePath, absolutePath });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isSafeWikiPath(relativePath) {
  if (!relativePath.endsWith(".md")) return false;
  if (relativePath.includes("/")) return false;
  return !/[\\:*?"<>|]/.test(relativePath) && basename(relativePath) === relativePath;
}

function isExternalOrAnchorLink(target) {
  return /^(?:https?:|mailto:|#)/i.test(target);
}

function decodeWikiTarget(target) {
  const withoutAnchor = target.split("#", 1)[0]?.trim();
  if (!withoutAnchor) return "";
  try {
    return decodeURIComponent(withoutAnchor);
  } catch {
    return withoutAnchor;
  }
}

function currentSourceRef() {
  const result = runGit(["rev-parse", "--short=12", "HEAD"], repositoryRoot, { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : "local source";
}

function runGit(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const output = sanitizeGitOutput(`${result.stdout}\n${result.stderr}`, args.join(" "));
    fail(`git ${args[0]} failed with exit ${result.status}:\n${output}`);
  }
  return result;
}

function sanitizeGitOutput(output, secretSource) {
  let sanitized = String(output ?? "").trim();
  sanitized = sanitized.replace(/https:\/\/[^/@\s]+@github\.com\//gi, "https://github.com/");
  if (secretSource && secretSource.includes("@") && /^https:\/\//i.test(secretSource)) {
    sanitized = sanitized.split(secretSource).join("<wiki remote>");
  }
  return sanitized;
}

function fail(message) {
  throw new WikiSyncError(message);
}
