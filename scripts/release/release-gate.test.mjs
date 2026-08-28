import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), "utf8"));
}

test("release tag Hook is a fast proof gate for common origin tag push forms", async () => {
  const hook = await readJson(".forgerelay/hooks/release-tag-local-ci.json");
  assert.equal(hook.event, "BeforeTool");
  assert.equal(hook.command, "node scripts/release-proof.mjs check-hook");
  assert.ok(hook.timeoutSeconds <= 30);

  const matcher = new RegExp(hook.matcher.commandRegex);
  for (const command of [
    "git push origin v1.2.3",
    "git push --atomic origin v1.2.3",
    "git push origin refs/tags/v1.2.3",
    "git status && git push origin tag v1.2.3 && echo done",
  ]) {
    assert.match(command, matcher);
  }
  assert.doesNotMatch("git push origin main", matcher);
});

test("release:verify records proof only after the cloud-equivalent parity gate", async () => {
  const pkg = await readJson("package.json");
  assert.equal(
    pkg.scripts["release:verify"],
    "npm run release:parity && node scripts/release-proof.mjs write",
  );
});

test("cross-platform cloud CI delegates to one shell-free verification entrypoint", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node-version-file:\s*\.nvmrc/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm run ci:verify/);
  assert.doesNotMatch(workflow, /shell:/);
  assert.doesNotMatch(workflow, /run:\s*\|/);
  for (const duplicatedCommand of [
    "npm run release:check",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run lsp:interop",
    "node dist/cli.js doctor",
  ]) {
    assert.equal(
      workflow.includes(`run: ${duplicatedCommand}`),
      false,
      `cloud CI must delegate ${duplicatedCommand} through ci:verify`,
    );
  }
});

test("release runtime and local parity share the checked-in Node contract", async () => {
  const nodeVersion = (await readFile(resolve(repoRoot, ".nvmrc"), "utf8")).trim();
  assert.equal(nodeVersion, "22.19.0");

  const pkg = await readJson("package.json");
  assert.equal(pkg.scripts["ci:verify"], "node scripts/ci/verify.mjs");

  const source = await readFile(resolve(repoRoot, "scripts/release-parity.mjs"), "utf8");
  assert.match(source, /readFileSync\(join\(repoRoot, "\.nvmrc"\), "utf8"\)/);
  assert.match(source, /const NPM_VERSION = "10\.9\.3"/);
  assert.ok(source.includes('["npm", "ci", "--no-audit", "--no-fund"]'));
  assert.ok(source.includes('["npm", "run", "ci:verify"]'));
  assert.ok(source.includes('["npm", "run", "release:pack"]'));
  assert.doesNotMatch(source, /\["npm", "run", "typecheck"\]/);
  assert.doesNotMatch(source, /\["npm", "test"\]/);
});

test("cloud verification produces one reusable npm package on Linux", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /if:\s*runner\.os == 'Linux'[\s\S]*run:\s*npm run release:pack/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(workflow, /name:\s*npm-package/);
  assert.match(workflow, /include-hidden-files:\s*true/);
  assert.match(workflow, /overwrite:\s*true/);
});

test("release workflow is tag-only and promotes the verified npm artifact without rebuilding", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /needs:\s*verify/);
  assert.match(workflow, /uses:\s*actions\/download-artifact@v5/);
  assert.match(workflow, /name:\s*npm-package/);
  assert.match(workflow, /run:\s*npm run release:publish/);
  assert.match(workflow, /npm install --global npm@11\.19\.1/);
  assert.doesNotMatch(workflow, /run:\s*npm ci/);
  assert.doesNotMatch(workflow, /run:\s*npm run build/);
  assert.doesNotMatch(workflow, /run:\s*\|/);
  assert.doesNotMatch(workflow, /shell:\s*bash/);
});
