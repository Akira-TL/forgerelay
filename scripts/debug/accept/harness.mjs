import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDebugEnvironment,
  debugRoot,
  repoRoot,
} from "../runtime.mjs";
import {
  setupCodeIntelligenceProject as setupCodeIntelligenceAcceptanceProject,
} from "../code-intelligence-accept.mjs";
import { assertCurlAvailable, assertDebugPortFree, pass, setupGitProject } from "./support.mjs";

/** Build the disposable 7677 acceptance environment in one place so the main
 * scenario remains a readable sequence of externally observable assertions. */
export async function createAcceptanceHarness() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const acceptanceRoot = resolve(debugRoot, "acceptance");
  const stateDir = resolve(acceptanceRoot, "state");
  const worktreeRoot = resolve(acceptanceRoot, "worktrees");
  const hookLog = resolve(acceptanceRoot, "hooks.jsonl");
  const checkoutWorkspace = resolve(acceptanceRoot, "workspace");
  const lifecycleDeleteWorkspace = resolve(acceptanceRoot, "delete-workspace");
  const codeIntelligenceLog = resolve(acceptanceRoot, "code-intelligence-lsp.jsonl");
  const fakeLanguageServer = resolve(repoRoot, "src", "lsp", "test-fixtures", "fake-lsp-server.mjs");
  const gitProject = resolve(acceptanceRoot, "git-project");
  const releaseProject = resolve(acceptanceRoot, "release-project");
  const releaseRemote = resolve(acceptanceRoot, "release-remote.git");
  const ownerToken = randomBytes(32).toString("base64url");
  const tempAcceptanceRoot = resolve(tmpdir(), `forgerelay-debug-acceptance-${randomUUID()}`);

  assertCurlAvailable();
  await assertDebugPortFree();
  rmSync(acceptanceRoot, { recursive: true, force: true });
  mkdirSync(acceptanceRoot, { recursive: true });
  setupGitProject(checkoutWorkspace);
  setupGitProject(lifecycleDeleteWorkspace);
  writeFileSync(join(lifecycleDeleteWorkspace, "keep.txt"), "keep checkout files\n");
  writeFileSync(join(lifecycleDeleteWorkspace, "AGENTS.md"), "INSPECTION_ACCEPTANCE_BOOTSTRAP_SECRET\n");
  setupCodeIntelligenceAcceptanceProject({ root: checkoutWorkspace, fakeLanguageServer, logPath: codeIntelligenceLog });

  const { env } = createDebugEnvironment({
    ownerToken,
    stateDir,
    worktreeRoot,
    hookLog,
    widgets: "changes",
  });
  env.FORGERELAY_ARTIFACTS = "1";
  const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Public base URL: http:\/\/127\.0\.0\.1:7677/);
  assert.match(doctor.stdout, /Tool mode: full/);
  assert.match(doctor.stdout, /Widgets: changes/);
  assert.match(doctor.stdout, /Trust proxy: off/);
  pass("doctor resolved MCP shape", "public URL + tool/widgets/proxy state");

  const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  return {
    packageJson, acceptanceRoot, stateDir, worktreeRoot, hookLog, checkoutWorkspace,
    lifecycleDeleteWorkspace, codeIntelligenceLog, fakeLanguageServer, gitProject, releaseProject,
    releaseRemote, ownerToken, tempAcceptanceRoot, env, server,
  };
}
