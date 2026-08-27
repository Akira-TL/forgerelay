import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), "utf8"));
}

test("release tag Hook is a fast proof gate, not a multi-minute CI runner", async () => {
  const hook = await readJson(".forgerelay/hooks/release-tag-local-ci.json");
  assert.equal(hook.event, "BeforeTool");
  assert.equal(hook.command, "node scripts/release-proof.mjs check-hook");
  assert.ok(hook.timeoutSeconds <= 30);
});

test("release:verify records proof only after the cloud-equivalent parity gate", async () => {
  const pkg = await readJson("package.json");
  assert.equal(
    pkg.scripts["release:verify"],
    "npm run release:parity && node scripts/release-proof.mjs write",
  );
});

test("release parity mirrors the cloud CI command surface on Node 22.19 and npm 10.9", async () => {
  const source = await readFile(resolve(repoRoot, "scripts/release-parity.mjs"), "utf8");
  assert.match(source, /const NODE_VERSION = "22\.19\.0"/);
  assert.match(source, /const NPM_VERSION = "10\.9\.3"/);
  for (const command of [
    '["npm", "ci", "--no-audit", "--no-fund"]',
    '["npm", "run", "release:check"]',
    '["npm", "run", "typecheck"]',
    '["npm", "test"]',
    '["npm", "run", "build"]',
    '["npm", "run", "lsp:interop"]',
    '["dist/cli.js", "doctor"]',
  ]) {
    assert.ok(source.includes(command), `release parity is missing ${command}`);
  }
});
