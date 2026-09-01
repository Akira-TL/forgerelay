#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const scriptDir = dirname(fileURLToPath(import.meta.url));
const proofScript = resolve(scriptDir, "..", "release-proof.mjs");

try {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== "main" && !branch.startsWith("release/")) {
    throw new Error(`release-ready push must run from main or release/*, not ${branch}`);
  }

  verifyReleaseProof();
  git(["fetch", "--quiet", "origin", "main"]);

  const head = git(["rev-parse", "HEAD"]);
  if (!gitSucceeds(["merge-base", "--is-ancestor", "origin/main", head])) {
    throw new Error("release HEAD must fast-forward origin/main; reconcile remote main before publishing");
  }

  if (branch !== "main") {
    assertLocalMainCanMove(head);
  }

  const refspecs = ["HEAD:refs/heads/main"];
  if (branch !== "main") refspecs.push(`HEAD:refs/heads/${branch}`);
  runGit(["push", "--atomic", "origin", ...refspecs]);

  if (branch !== "main") {
    runGit(["branch", "-f", "main", head]);
  }

  const remoteMain = git(["rev-parse", "origin/main"]);
  const localMain = git(["rev-parse", "main"]);
  if (remoteMain !== head || localMain !== head) {
    throw new Error("release-ready push completed but local/remote main did not converge on release HEAD");
  }

  console.log(`Release-ready branches synchronized at ${head.slice(0, 12)} (${branch} -> origin/main).`);
} catch (error) {
  console.error(`release-push-ready: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function verifyReleaseProof() {
  const result = spawnSync(process.execPath, [proofScript, "check"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(detail || `release proof check failed with exit ${result.status ?? "unknown"}`);
  }
}

function assertLocalMainCanMove(head) {
  git(["rev-parse", "--verify", "refs/heads/main"]);
  const uniquePatches = git(["cherry", head, "main"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("+ "));
  if (uniquePatches.length > 0) {
    throw new Error(
      `local main has commits with patches not present in release HEAD: ${uniquePatches.map((line) => line.slice(2, 14)).join(", ")}`,
    );
  }

  const mainWorktree = checkedOutBranchWorktree("refs/heads/main");
  if (mainWorktree) {
    throw new Error(`local main is checked out in another worktree (${mainWorktree}); switch it away before release-ready push`);
  }
}

function checkedOutBranchWorktree(branchRef) {
  const records = git(["worktree", "list", "--porcelain"]).split(/\n\n+/);
  for (const record of records) {
    const lines = record.split("\n");
    if (!lines.includes(`branch ${branchRef}`)) continue;
    return lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  }
  return undefined;
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

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed with exit ${result.status ?? "unknown"}`);
  }
}
