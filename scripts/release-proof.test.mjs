import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = new URL("./release-proof.mjs", import.meta.url);

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function runProof(cwd, action, env = {}) {
  return execFileAsync(process.execPath, [script.pathname, action], {
    cwd,
    env: { ...process.env, ...env },
  });
}

test("release proof binds a successful local verification to the exact tag HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }) + "\n");
  await writeFile(join(root, "tracked.txt"), "verified\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 1.2.3"]);

  const written = await runProof(root, "write");
  assert.match(written.stdout, /Release verification proof recorded/);
  await git(root, ["tag", "v1.2.3"]);

  const checked = await runProof(root, "check-hook", {
    FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
  });
  assert.match(checked.stdout, /Release proof OK: v1\.2\.3/);

  await writeFile(join(root, "tracked.txt"), "changed after verification\n");
  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /working tree differs from HEAD/);
      return true;
    },
  );

  await writeFile(join(root, "tracked.txt"), "verified\n");
  await writeFile(join(root, "untracked.txt"), "not in the release commit\n");
  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /contains untracked files/);
      return true;
    },
  );
  await rm(join(root, "untracked.txt"));
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "--allow-empty", "-m", "new head"]);
  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /release proof is for .* current HEAD is/);
      return true;
    },
  );
});

test("release proof rejects a mismatched tag without invoking a remote", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }) + "\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 2.0.0"]);
  await runProof(root, "write");
  await git(root, ["tag", "v2.0.0"]);

  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v2.0.1" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /tag v2\.0\.1 does not match package version 2\.0\.0/);
      return true;
    },
  );

  const proof = JSON.parse(await readFile(join(root, ".git", "forgerelay", "release-proof.json"), "utf8"));
  assert.equal(proof.packageVersion, "2.0.0");
});
