import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./release-proof.mjs", import.meta.url));

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function runProof(cwd, action, env = {}) {
  return execFileAsync(process.execPath, [script, action], {
    cwd,
    env: { ...process.env, ...env },
  });
}

async function artifactApiEnv(t, { npmStatus = 404, githubStatus = 404 } = {}) {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/npm/")) response.statusCode = npmStatus;
    else if (request.url?.startsWith("/github/")) response.statusCode = githubStatus;
    else response.statusCode = 500;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    NODE_ENV: "test",
    FORGERELAY_TEST_NPM_REGISTRY_URL: `${base}/npm/`,
    FORGERELAY_TEST_GITHUB_API_URL: `${base}/github/`,
  };
}

test("release tag hook gate uses repository facts instead of requiring a local proof", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@akira-tl/forgerelay",
    version: "1.2.3",
    repository: { url: "git+https://github.com/Akira-TL/forgerelay.git" },
  }) + "\n");
  await mkdir(join(root, "docs", "releases"), { recursive: true });
  await writeFile(join(root, "docs", "releases", "v1.2.3.md"), "# v1.2.3\n\nDedicated notes.\n");
  await writeFile(join(root, "tracked.txt"), "verified\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 1.2.3"]);

  const written = await runProof(root, "write");
  assert.match(written.stdout, /Release verification proof recorded/);
  await rm(join(root, ".git", "forgerelay", "release-proof.json"));
  await git(root, ["tag", "v1.2.3"]);

  const checked = await runProof(root, "check-hook", {
    FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
  });
  assert.match(checked.stdout, /Release tag gate OK: v1\.2\.3/);

  for (const command of [
    "git push --atomic origin v1.2.3",
    "git push origin refs/tags/v1.2.3",
    "git status && git push origin tag v1.2.3 && echo done",
  ]) {
    const alternative = await runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command, originalCommand: command }),
    });
    assert.match(alternative.stdout, /Release tag gate OK: v1\.2\.3/);
  }

  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({
        command: "git push origin v1.2.3",
        originalCommand: "git push --force origin v1.2.3",
      }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /force push is not allowed for release tags/);
      return true;
    },
  );

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
  await runProof(root, "write");
  const mutableEnv = await artifactApiEnv(t);
  const deletion = await runProof(root, "check-hook", {
    ...mutableEnv,
    FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push --delete origin v1.2.3" }),
  });
  assert.match(deletion.stdout, /Release tag rebuild gate OK: v1\.2\.3/);

  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.2.3" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /tag v1\.2\.3 points to .* current HEAD is/);
      return true;
    },
  );
});

test("release tag hook gate refuses deletion after an irreversible release artifact exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@akira-tl/forgerelay",
    version: "1.3.0",
    repository: { url: "git+https://github.com/Akira-TL/forgerelay.git" },
  }) + "\n");
  await mkdir(join(root, "docs", "releases"), { recursive: true });
  await writeFile(join(root, "docs", "releases", "v1.3.0.md"), "# v1.3.0\n\nDedicated notes.\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 1.3.0"]);
  await git(root, ["tag", "v1.3.0"]);
  await runProof(root, "write");

  const npmPublishedEnv = await artifactApiEnv(t, { npmStatus: 200, githubStatus: 404 });
  await assert.rejects(
    () => runProof(root, "check-hook", {
      ...npmPublishedEnv,
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push --delete origin v1.3.0" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /npm package .* already exists/);
      return true;
    },
  );

  const githubPublishedEnv = await artifactApiEnv(t, { npmStatus: 404, githubStatus: 200 });
  await assert.rejects(
    () => runProof(root, "check-hook", {
      ...githubPublishedEnv,
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push --delete origin v1.3.0" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /GitHub Release .* already exists/);
      return true;
    },
  );
});

test("release tag hook gate rejects a matching tag when dedicated notes are missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.4.0" }) + "\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 1.4.0"]);
  await git(root, ["tag", "v1.4.0"]);

  await assert.rejects(
    () => runProof(root, "check-hook", {
      FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v1.4.0" }),
    }),
    (error) => {
      assert.match(String(error.stderr ?? error), /missing dedicated release notes: docs\/releases\/v1\.4\.0\.md/);
      return true;
    },
  );
});

test("release tag hook gate accepts an rc tag for the package version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.6.0-rc.1" }) + "\n");
  await mkdir(join(root, "docs", "releases"), { recursive: true });
  await writeFile(join(root, "docs", "releases", "v0.6.0-rc.1.md"), "# v0.6.0-rc.1\n\nDedicated RC notes.\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 0.6.0-rc.1"]);
  await git(root, ["tag", "v0.6.0-rc.1"]);

  const checked = await runProof(root, "check-hook", {
    FORGERELAY_HOOK_PAYLOAD: JSON.stringify({ command: "git push origin v0.6.0-rc.1" }),
  });
  assert.match(checked.stdout, /Release tag gate OK: v0\.6\.0-rc\.1/);
});

test("release tag hook gate rejects a mismatched tag without invoking a remote", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }) + "\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "proof@example.com"]);
  await git(root, ["config", "user.name", "Release Proof Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "release 2.0.0"]);
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

});
