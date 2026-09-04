import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("Relay routes workspace.checkpoint ownership, restore, and cleanup to the Execution ForgeRelay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-workspace-relay-checkpoint-"));
  const remoteRepo = join(root, "remote-repo");
  const gatewayRoot = join(root, "gateway-root");
  const remoteServerRoot = join(root, "remote-server");
  const gatewayServerRoot = join(root, "gateway");
  await setupGitRepository(remoteRepo);
  await mkdir(gatewayRoot, { recursive: true });

  const remote = await startForge(t, {
    root: remoteServerRoot,
    allowedRoot: remoteRepo,
    ownerToken: "remote-checkpoint-owner-token-long-enough",
    instanceId: "forge-relay-checkpoint-remote",
  });
  const remoteRecord = await authenticateRemote(remote.endpoint, remote.ownerToken);
  const gatewayConfigDir = join(gatewayServerRoot, "config");
  await mkdir(gatewayConfigDir, { recursive: true });
  await writeFile(join(gatewayConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "gateway-checkpoint-owner-token-long-enough",
    instanceId: "forge-relay-checkpoint-gateway",
    remotes: { workstation: remoteRecord },
  }, null, 2), { mode: 0o600 });
  const client = await startGatewayClient(t, {
    root: gatewayServerRoot,
    allowedRoot: gatewayRoot,
    configDir: gatewayConfigDir,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: remoteRepo, relay: "workstation", context: "none" },
  });
  assert.equal(opened.isError, undefined, resultText(opened));
  const gatewayWorkspaceId = String(structured(opened).workspaceId);
  const catalog = structured(opened).capabilityCatalog as Array<Record<string, unknown>>;
  assert.equal(catalog.some((entry) => entry.name === "workspace.checkpoint" && entry.available === true), true);

  await writeFile(join(remoteRepo, "relay-checkpoint.txt"), "execution-owned checkpoint\n");
  const created = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "create", name: "remote checkpoint" },
    },
  });
  assert.equal(created.isError, undefined, resultText(created));
  const createResult = structured(created).result as Record<string, unknown>;
  const checkpoint = createResult.checkpoint as Record<string, unknown>;
  const checkpointId = String(checkpoint.id);
  const checkpointCommit = String(checkpoint.commit);
  assert.equal(createResult.workspaceId, gatewayWorkspaceId);
  assert.equal(await gitOutput(remoteRepo, ["show", `${checkpointCommit}:relay-checkpoint.txt`]), "execution-owned checkpoint");

  const remoteCheckpointFiles = await checkpointStateFiles(join(remoteServerRoot, "state", "workspaces"));
  assert.equal(remoteCheckpointFiles.length, 1);
  assert.match(await readFile(remoteCheckpointFiles[0]!, "utf8"), /remote checkpoint/);
  const gatewayCheckpointFiles = await checkpointStateFiles(join(gatewayServerRoot, "state", "workspaces"));
  assert.deepEqual(gatewayCheckpointFiles, []);

  const listed = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "list" },
    },
  });
  assert.equal(listed.isError, undefined, resultText(listed));
  const checkpoints = (structured(listed).result as Record<string, unknown>).checkpoints as Array<Record<string, unknown>>;
  assert.equal(checkpoints[0]?.id, checkpointId);

  await writeFile(join(remoteRepo, "relay-checkpoint.txt"), "gateway must restore on execution forge\n");
  const preflight = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "restore.preflight", checkpointId },
    },
  });
  assert.equal(preflight.isError, undefined, resultText(preflight));
  const preflightResult = structured(preflight).result as Record<string, unknown>;
  assert.equal(preflightResult.workspaceId, gatewayWorkspaceId);
  const restored = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId: gatewayWorkspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: {
        operation: "restore",
        checkpointId,
        expectedCurrentSnapshot: preflightResult.currentSnapshot,
      },
    },
  });
  assert.equal(restored.isError, undefined, resultText(restored));
  assert.equal((structured(restored).result as Record<string, unknown>).workspaceId, gatewayWorkspaceId);
  assert.equal(
    (await readFile(join(remoteRepo, "relay-checkpoint.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "execution-owned checkpoint\n",
  );

  const deletedWorkspace = await client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: gatewayWorkspaceId, action: "delete" },
  });
  assert.equal(deletedWorkspace.isError, undefined, resultText(deletedWorkspace));
  assert.deepEqual(await checkpointStateFiles(join(remoteServerRoot, "state", "workspaces")), []);
  await assert.rejects(execFileAsync("git", [
    "show-ref",
    "--verify",
    `refs/forgerelay/checkpoints/${executionWorkspaceId(remoteCheckpointFiles[0]!)}/${checkpointId}`,
  ], { cwd: remoteRepo }));
});

async function checkpointStateFiles(workspacesDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workspacesDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(workspacesDir, entry.name, "checkpoints.json");
    try {
      await readFile(path, "utf8");
      files.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return files;
}

function executionWorkspaceId(checkpointStatePath: string): string {
  return checkpointStatePath.split(/[\\/]/).at(-2) ?? "";
}

function structured(result: Awaited<ReturnType<import("@modelcontextprotocol/sdk/client/index.js").Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function resultText(result: Awaited<ReturnType<import("@modelcontextprotocol/sdk/client/index.js").Client["callTool"]>>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
