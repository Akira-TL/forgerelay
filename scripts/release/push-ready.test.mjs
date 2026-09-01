import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pushReadyScript = resolve(repoRoot, "scripts/release/push-ready.mjs");
const releaseProofScript = resolve(repoRoot, "scripts/release-proof.mjs");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writePackage(root, version = "1.2.3") {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
}

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", message]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-release-push-ready-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  git(root, ["init", "--bare", origin]);
  git(checkout, ["init", "-b", "main"]);
  git(checkout, ["config", "user.email", "forgerelay@example.com"]);
  git(checkout, ["config", "user.name", "ForgeRelay Test"]);
  git(checkout, ["remote", "add", "origin", origin]);
  writePackage(checkout);
  writeFileSync(join(checkout, "README.md"), "base\n");
  commitAll(checkout, "base");
  git(checkout, ["push", "-u", "origin", "main"]);
  return { root, origin, checkout };
}

function writeProof(checkout) {
  execFileSync(process.execPath, [releaseProofScript, "write"], {
    cwd: checkout,
    stdio: "pipe",
  });
}

test("release push-ready atomically advances remote main/release and synchronizes local main", () => {
  const context = fixture();
  try {
    const { checkout, origin } = context;
    git(checkout, ["switch", "-c", "release/1.2.3"]);
    writeFileSync(join(checkout, "release.txt"), "release\n");
    commitAll(checkout, "release");
    const releaseHead = git(checkout, ["rev-parse", "HEAD"]);
    writeProof(checkout);

    execFileSync(process.execPath, [pushReadyScript], {
      cwd: checkout,
      stdio: "pipe",
    });

    assert.equal(git(checkout, ["rev-parse", "main"]), releaseHead);
    assert.equal(git(checkout, ["rev-parse", "origin/main"]), releaseHead);
    assert.equal(git(checkout, ["rev-parse", "origin/release/1.2.3"]), releaseHead);
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), releaseHead);
    assert.equal(git(origin, ["rev-parse", "refs/heads/release/1.2.3"]), releaseHead);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("release push-ready refuses to move main when local main has a real unique patch", () => {
  const context = fixture();
  try {
    const { checkout, origin } = context;
    const base = git(checkout, ["rev-parse", "HEAD"]);

    writeFileSync(join(checkout, "main-only.txt"), "must preserve\n");
    commitAll(checkout, "main only");
    const localMain = git(checkout, ["rev-parse", "HEAD"]);

    git(checkout, ["switch", "-c", "release/1.2.3", base]);
    writeFileSync(join(checkout, "release.txt"), "release\n");
    commitAll(checkout, "release");
    writeProof(checkout);

    const result = spawnSync(process.execPath, [pushReadyScript], {
      cwd: checkout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /local main has commits with patches not present in release HEAD/i);
    assert.equal(git(checkout, ["rev-parse", "main"]), localMain);
    assert.equal(git(origin, ["rev-parse", "refs/heads/main"]), base);
    assert.throws(() => git(origin, ["rev-parse", "refs/heads/release/1.2.3"]));
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
