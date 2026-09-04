import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { authenticateRemote } from "../auth/remote-auth.js";
import {
  setupGitRepository,
  startForge,
  startGatewayClient,
} from "./test-support.js";

const execFileAsync = promisify(execFile);

test("Relay routes workspace.recovery repair to the Execution ForgeRelay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-recovery-"));
  const remoteRepo = join(root, "remote-repo");
  const gatewayRoot = join(root, "gateway-root");
  await setupGitRepository(remoteRepo);
  await mkdir(gatewayRoot, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const remote = await startForge(t, {
    root: join(root, "remote-server"),
    allowedRoot: remoteRepo,
    ownerToken: "remote-recovery-owner-token-long-enough",
    instanceId: "forge-relay-recovery-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(root, "gateway", "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-recovery-owner-token-long-enough",
    instanceId: "forge-relay-recovery-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: join(root, "gateway"),
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: {
      path: remoteRepo,
      relay: "workstation",
      mode: "worktree",
      context: "none",
    },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const openedStructured = structured(opened);
  const gatewayWorkspaceId = String(openedStructured.workspaceId);
  const catalog = openedStructured.capabilityCatalog as Array<Record<string, unknown>>;
  assert.equal(catalog.some((entry) => entry.name === "workspace.recovery"), true);
  const inspected = await client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId: gatewayWorkspaceId },
  });
  assert.equal(inspected.isError, undefined, resultText(inspected));
  const inspection = structured(inspected).inspection as Record<string, unknown>;
  const oldRoot = String(inspection.root);
  const branch = String(inspection.branch);
  const targetBranch = String(inspection.targetBranch);
  assert.equal(inspection.mode, "worktree");
  assert.equal(inspection.managed, true);

  await writeFile(join(oldRoot, "unique-relay-recovery.txt"), "remote managed branch survives\n");
  await git(oldRoot, ["add", "unique-relay-recovery.txt"]);
  await git(oldRoot, ["commit", "-m", "TEST: (relay) preserve recovery commit"]);
  const managedHead = await gitOutput(remoteRepo, ["rev-parse", `refs/heads/${branch}`]);
  const targetHeadBefore = await gitOutput(remoteRepo, ["rev-parse", `refs/heads/${targetBranch}`]);
  await rm(oldRoot, { recursive: true, force: true });

  const repaired = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.recovery",
      action: "run",
      arguments: { operation: "repair" },
    },
  });
  assert.equal(repaired.isError, undefined, resultText(repaired));
  const result = structured(repaired).result as Record<string, unknown>;
  assert.equal(result.workspaceId, gatewayWorkspaceId);
  assert.equal(result.repaired, true);
  assert.equal(result.branch, branch);
  const newRoot = String(result.root);
  assert.notEqual(newRoot, oldRoot);
  assert.equal(await readFile(join(newRoot, "unique-relay-recovery.txt"), "utf8"), "remote managed branch survives\n");
  assert.equal(await gitOutput(newRoot, ["rev-parse", "HEAD"]), managedHead);
  assert.equal(await gitOutput(remoteRepo, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);

  const routedRead = await client.callTool({
    name: "read",
    arguments: { workspaceId: gatewayWorkspaceId, path: "unique-relay-recovery.txt" },
  });
  assert.equal(routedRead.isError, undefined, resultText(routedRead));
  assert.match(resultText(routedRead), /remote managed branch survives/);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function structured(result: Awaited<ReturnType<import("@modelcontextprotocol/sdk/client/index.js").Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function resultText(result: Awaited<ReturnType<import("@modelcontextprotocol/sdk/client/index.js").Client["callTool"]>>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" && entry !== null && entry.type === "text" && typeof entry.text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}
