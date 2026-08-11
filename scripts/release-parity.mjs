import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const minimumNode = "22.19.0";
const npmVersion = "11";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const debugRoot = join(repoRoot, ".forgerelay-debug");
const sandbox = mkdtempSync(join(ensureDirectory(debugRoot), "release-parity-node22-"));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const highRiskTests = [
  "scripts/lsp-interop-support.test.mjs",
  "src/lsp/language-server-config.test.ts",
  "src/lsp/runtime/semantic-requests.test.ts",
  "src/lsp/operations/request-hardening.server.test.ts",
  "src/lsp/operations/recovery.server.test.ts",
  "src/lsp/operations/lifecycle.server.test.ts",
];

try {
  copy("package.json");
  copy("package-lock.json");
  copy("tsconfig.json");
  copy("src");
  copy("scripts");
  copy("capabilities");

  run(
    ["--yes", "-p", `node@${minimumNode}`, "-p", `npm@${npmVersion}`, "--", "npm", "ci", "--no-audit", "--no-fund"],
    `Node ${minimumNode} isolated npm ci`,
    sandbox,
  );

  run(
    [
      "--yes",
      `node@${minimumNode}`,
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...highRiskTests,
    ],
    `Node ${minimumNode} high-risk parity tests`,
    sandbox,
  );

  console.log(`Release parity passed in an isolated Node ${minimumNode} sandbox.`);
} finally {
  rmSync(sandbox, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  return `${path}/`;
}

function copy(relativePath) {
  cpSync(join(repoRoot, relativePath), join(sandbox, relativePath), {
    recursive: true,
    force: true,
  });
}

function run(args, label, cwd) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(npx, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`${label} failed with exit ${result.status ?? "unknown"}.`);
    process.exitCode = result.status ?? 1;
    throw new Error(`${label} failed.`);
  }
}
