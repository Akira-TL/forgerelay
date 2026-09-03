#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { extname, basename, dirname } from "node:path";
import { readFileSync } from "node:fs";

const MAX_LINES = 800;
const MAX_DIRECT_FILES = 8;
const MAX_DIRECT_DIRS = 8;
const LINE_LIMIT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css"]);

// Repository-root protocol files are intentionally discoverable by Git, npm,
// Node, Vite, contributors, and agents. Keep that conventional surface explicit
// instead of hiding required/default-discovery files merely to satisfy a count.
const ROOT_PROTOCOL_FILES = new Set([
  ".env.example",
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "package-lock.json",
  "package.json",
  "tsconfig.build.json",
  "tsconfig.json",
  "vite.config.ts",
]);

const tracked = gitTrackedFiles();
const violations = [];
const directFiles = new Map();
const directDirs = new Map();

for (const path of tracked) {
  const parent = normalizeDirectory(dirname(path));
  directFiles.set(parent, (directFiles.get(parent) ?? 0) + 1);

  let child = parent;
  while (child !== ".") {
    const grandparent = normalizeDirectory(dirname(child));
    let children = directDirs.get(grandparent);
    if (!children) directDirs.set(grandparent, children = new Set());
    children.add(basename(child));
    child = grandparent;
  }

  if (LINE_LIMIT_EXTENSIONS.has(extname(path))) {
    const lines = physicalLineCount(readFileSync(path, "utf8"));
    if (lines > MAX_LINES) violations.push(`${path}: ${lines} lines > ${MAX_LINES}`);
  }
}

for (const path of tracked.filter((path) => dirname(path) === ".")) {
  if (!ROOT_PROTOCOL_FILES.has(path)) violations.push(`repository root has unclassified file: ${path}`);
}

for (const allowed of ROOT_PROTOCOL_FILES) {
  if (!tracked.includes(allowed)) continue;
  // Presence is allowed, not required; this loop documents the intentional set.
}

const directories = new Set([...directFiles.keys(), ...directDirs.keys()]);
for (const directory of [...directories].sort()) {
  const files = directFiles.get(directory) ?? 0;
  const dirs = directDirs.get(directory)?.size ?? 0;
  if (directory !== "." && files > MAX_DIRECT_FILES) {
    violations.push(`${directory}: ${files} direct files > ${MAX_DIRECT_FILES}`);
  }
  if (dirs > MAX_DIRECT_DIRS) {
    violations.push(`${directory}: ${dirs} direct directories > ${MAX_DIRECT_DIRS}`);
  }
}

if (violations.length > 0) {
  console.error("Architecture check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Architecture check passed: ${tracked.length} tracked files; ` +
  `code <= ${MAX_LINES} lines; non-root directories <= ${MAX_DIRECT_FILES} files / ${MAX_DIRECT_DIRS} directories.`,
);

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed with exit ${result.status ?? "unknown"}`);
  return result.stdout.split("\0").filter(Boolean);
}

function normalizeDirectory(directory) {
  return directory === "" ? "." : directory.replaceAll("\\", "/");
}

function physicalLineCount(text) {
  if (text.length === 0) return 0;
  const newlines = text.match(/\n/g)?.length ?? 0;
  return newlines + (text.endsWith("\n") ? 0 : 1);
}
