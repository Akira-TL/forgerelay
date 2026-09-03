import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { debugRoot, repoRoot } from "../runtime.mjs";

export function relayAcceptanceTopology() {
  const gatewayPort = 7677;
  const executionPort = 7678;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const gatewayMcpUrl = `${gatewayBaseUrl}/mcp`;
  const executionBaseUrl = `http://127.0.0.1:${executionPort}`;
  const acceptanceRoot = resolve(debugRoot, "relay-acceptance");
  const gatewayConfigDir = join(acceptanceRoot, "gateway", "config");
  const gatewayStateDir = join(acceptanceRoot, "gateway", "state");
  const gatewayWorktreeRoot = join(acceptanceRoot, "gateway", "worktrees");
  const gatewayProjects = join(acceptanceRoot, "gateway-projects");
  const gatewayLocalProject = join(gatewayProjects, "local");
  const executionConfigDir = join(acceptanceRoot, "execution", "config");
  const executionStateDir = join(acceptanceRoot, "execution", "state");
  const executionWorktreeRoot = join(acceptanceRoot, "execution", "worktrees");
  const executionProjects = join(acceptanceRoot, "execution-projects");
  const executionCheckout = join(executionProjects, "checkout");
  const executionWorktreeSource = join(executionProjects, "worktree-source");
  const bootstrapSecret = "RELAY_ACCEPTANCE_BOOTSTRAP_SECRET";
  const checkoutTaskBody = "RELAY_ACCEPTANCE_EXECUTION_TASK_BODY";
  const worktreeTaskBody = "RELAY_ACCEPTANCE_WORKTREE_TASK_BODY";
  const compositeMemberTaskBody = "RELAY_ACCEPTANCE_COMPOSITE_MEMBER_TASK_BODY";
  const compositeTaskBody = "RELAY_ACCEPTANCE_COMPOSITE_OWN_TASK_BODY";
  return {
    gatewayPort, executionPort, gatewayBaseUrl, gatewayMcpUrl, executionBaseUrl,
    acceptanceRoot, gatewayConfigDir, gatewayStateDir, gatewayWorktreeRoot,
    gatewayProjects, gatewayLocalProject, executionConfigDir, executionStateDir,
    executionWorktreeRoot, executionProjects, executionCheckout, executionWorktreeSource,
    bootstrapSecret, checkoutTaskBody, worktreeTaskBody, compositeMemberTaskBody, compositeTaskBody,
  };
}

export async function assertPortsFree(ports) {
  for (const port of ports) {
    const occupied = await new Promise((resolvePromise) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once("error", () => resolvePromise(false));
    });
    assert.equal(occupied, false, `reserved debug port ${port} is already in use; refusing to touch the existing process`);
  }
}

export function setupGitProject(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "Relay managed worktree acceptance\n");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "forgerelay-debug@example.com"]);
  runGit(root, ["config", "user.name", "ForgeRelay Debug"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial Relay acceptance commit"]);
}

export function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function taskStateFiles(stateDir) {
  const workspacesDir = join(stateDir, "workspaces");
  if (!existsSync(workspacesDir)) return [];
  const files = [];
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workspacesDir, entry.name, "tasks.json");
    if (existsSync(candidate)) files.push(candidate);
  }
  return files;
}

export function findTaskStateFile(stateDir, needle) {
  return taskStateFiles(stateDir).find((path) => readFileSync(path, "utf8").includes(needle));
}

export function assertTaskBodyAbsentFromGateway(gatewayStateDir, body) {
  const leaked = taskStateFiles(gatewayStateDir).filter((path) => readFileSync(path, "utf8").includes(body));
  assert.deepEqual(leaked, [], `Gateway stored an Execution-owned Task body in: ${leaked.join(", ")}`);
}

export function assertSafeRelayInspection(result, { executionWorkspaceId, executionBaseUrl, executionPort, executionOwnerToken, bootstrapSecret, remoteRecord, taskBodies }) {
  const json = JSON.stringify(result);
  for (const forbidden of [
    executionWorkspaceId,
    executionBaseUrl,
    `127.0.0.1:${executionPort}`,
    executionOwnerToken,
    remoteRecord.accessToken,
    remoteRecord.refreshToken,
    bootstrapSecret,
    "remoteInstanceId",
    "remoteWorkspaceId",
    "sshRoute",
    ...taskBodies,
  ]) {
    assert.equal(json.includes(forbidden), false, `Relay inspection leaked ${forbidden}`);
  }
  assert.doesNotMatch(json, /"ws_[0-9a-f]{10}"/);
}

export function assertToolOk(result, label) {
  assert.equal(result.isError, undefined, `${label}: ${toolText(result)}`);
}

export function toolText(result) {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

export function pass(label, detail) {
  console.log(`PASS ${label}: ${detail}`);
}
