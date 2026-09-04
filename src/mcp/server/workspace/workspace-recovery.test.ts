import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  structuredContent,
} from "../../../runtime/testing/server-fixture.js";

const execFileAsync = promisify(execFile);

test("workspace.recovery repairs missing managed-worktree backing from the surviving managed branch", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-repair", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);
  const managedBranch = String(worktree.branch);
  const targetBranch = String(worktree.targetBranch);

  const catalog = structuredContent(opened).capabilityCatalog as Array<Record<string, unknown>>;
  assert.ok(catalog.some((entry) => entry.name === "workspace.recovery"));

  await writeFile(`${oldRoot}/unique-recovery.txt`, "managed branch survives\n");
  await git(oldRoot, ["add", "unique-recovery.txt"]);
  await git(oldRoot, ["commit", "-m", "test: preserve recovery commit"]);
  const managedHead = await gitOutput(context.project, ["rev-parse", `refs/heads/${managedBranch}`]);
  const targetHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]);

  const taskList = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "recovery durable task" },
    },
  });
  const taskListId = String((((structuredContent(taskList).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)
    .find((entry) => entry.name === "recovery durable task"))?.id);
  assert.match(taskListId, /^tl_/);

  await rm(oldRoot, { recursive: true, force: true });

  const status = await recoveryCall(context.client, workspaceId, "status");
  assert.equal(status.isError, undefined);
  const statusResult = structuredContent(status).result as Record<string, unknown>;
  assert.equal(statusResult.workspaceId, workspaceId);
  assert.equal(statusResult.repaired, false);
  assert.equal((statusResult.recovery as Record<string, unknown>).classification, "recoverable");

  const repaired = await recoveryCall(context.client, workspaceId, "repair");
  assert.equal(repaired.isError, undefined);
  const repairedResult = structuredContent(repaired).result as Record<string, unknown>;
  assert.equal(repairedResult.workspaceId, workspaceId);
  assert.equal(repairedResult.repaired, true);
  assert.equal(repairedResult.previousRoot, oldRoot);
  const newRoot = String(repairedResult.root);
  assert.notEqual(newRoot, oldRoot);
  assert.equal(repairedResult.branch, managedBranch);
  assert.equal(repairedResult.targetBranch, targetBranch);
  assert.equal((repairedResult.recovery as Record<string, unknown>).classification, "healthy");

  assert.equal(await readFile(`${newRoot}/unique-recovery.txt`, "utf8"), "managed branch survives\n");
  assert.equal(await gitOutput(newRoot, ["rev-parse", "HEAD"]), managedHead);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${managedBranch}`]), managedHead);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);
  assert.equal(await gitOutput(context.project, ["status", "--porcelain=v1"]), "");

  const inspected = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "inspect", workspaceId },
  });
  const inspection = structuredContent(inspected).inspection as Record<string, unknown>;
  assert.equal(inspection.workspaceId, workspaceId);
  assert.equal(inspection.root, newRoot);
  assert.equal(inspection.state, "active");
  assert.equal((inspection.recovery as Record<string, unknown>).classification, "healthy");

  const tasks = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "get", level: "headers", listId: taskListId },
    },
  });
  const lists = ((structuredContent(tasks).result as Record<string, unknown>).lists ?? []) as Array<Record<string, unknown>>;
  assert.equal(lists[0]?.id, taskListId);
});

test("workspace.recovery refuses repair when the managed branch is missing", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-refuse", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);
  const managedBranch = String(worktree.branch);
  const targetBranch = String(worktree.targetBranch);
  const targetHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]);

  await rm(oldRoot, { recursive: true, force: true });
  await git(context.project, ["worktree", "remove", "--force", oldRoot]);
  await git(context.project, ["branch", "-D", managedBranch]);
  const refsBefore = await managedRefs(context.project);
  const worktreesBefore = await gitOutput(context.project, ["worktree", "list", "--porcelain"]);

  const repaired = await recoveryCall(context.client, workspaceId, "repair");
  assert.equal(repaired.isError, undefined);
  const result = structuredContent(repaired).result as Record<string, unknown>;
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.repaired, false);
  assert.equal((result.recovery as Record<string, unknown>).classification, "manual-intervention");
  assert.deepEqual((result.recovery as Record<string, unknown>).conditions, [
    "backing-missing",
    "managed-branch-missing",
    "git-registration-missing",
  ]);

  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);
  assert.equal(await managedRefs(context.project), refsBefore);
  assert.equal(await gitOutput(context.project, ["worktree", "list", "--porcelain"]), worktreesBefore);
});

test("workspace.recovery is advertised only for managed-worktree Workspaces", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-recovery-checkout");
  const checkoutCatalog = structuredContent(checkout).capabilityCatalog as Array<Record<string, unknown>>;
  assert.equal(checkoutCatalog.some((entry) => entry.name === "workspace.recovery"), false);

  const worktree = await callOpen(context.client, context.project, "chat-recovery-worktree", "worktree");
  const worktreeCatalog = structuredContent(worktree).capabilityCatalog as Array<Record<string, unknown>>;
  assert.equal(worktreeCatalog.some((entry) => entry.name === "workspace.recovery"), true);
});

test("workspace.recovery refuses stale registration that no longer proves managed-branch ownership", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-registration-ownership", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);
  const managedBranch = String(worktree.branch);
  const targetBranch = String(worktree.targetBranch);

  await git(oldRoot, ["switch", "-c", "external/reassigned-worktree"]);
  await rm(oldRoot, { recursive: true, force: true });
  const refsBefore = await managedRefs(context.project);
  const targetHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]);
  const worktreesBefore = await gitOutput(context.project, ["worktree", "list", "--porcelain"]);

  const status = await recoveryCall(context.client, workspaceId, "status");
  assert.equal(status.isError, undefined, allResponseText(status));
  assert.equal(
    ((structuredContent(status).result as Record<string, unknown>).recovery as Record<string, unknown>).classification,
    "recoverable",
  );

  const repaired = await recoveryCall(context.client, workspaceId, "repair");
  assert.equal(repaired.isError, undefined, allResponseText(repaired));
  const result = structuredContent(repaired).result as Record<string, unknown>;
  assert.equal(result.repaired, false);
  assert.equal((result.recovery as Record<string, unknown>).classification, "manual-intervention");
  assert.match(String(result.reason), /does not prove ownership/i);

  assert.equal(await managedRefs(context.project), refsBefore);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);
  assert.equal(await gitOutput(context.project, ["worktree", "list", "--porcelain"]), worktreesBefore);
});

test("workspace.recovery refuses an ambiguous managed-branch worktree candidate without mutation", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-ambiguous", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);
  const managedBranch = String(worktree.branch);
  const targetBranch = String(worktree.targetBranch);
  const externalCandidate = join(dirname(context.project), "external-candidate");

  await rm(oldRoot, { recursive: true, force: true });
  await git(context.project, ["worktree", "add", "--force", externalCandidate, managedBranch]);
  const refsBefore = await managedRefs(context.project);
  const targetHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]);
  const worktreesBefore = await gitOutput(context.project, ["worktree", "list", "--porcelain"]);

  const repaired = await recoveryCall(context.client, workspaceId, "repair");
  assert.equal(repaired.isError, undefined, allResponseText(repaired));
  const result = structuredContent(repaired).result as Record<string, unknown>;
  assert.equal(result.repaired, false);
  assert.equal((result.recovery as Record<string, unknown>).classification, "manual-intervention");
  assert.match(String(result.reason), /another worktree candidate|ambiguous worktree ownership/i);

  assert.equal(await managedRefs(context.project), refsBefore);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);
  assert.equal(await gitOutput(context.project, ["worktree", "list", "--porcelain"]), worktreesBefore);
});

test("workspace.recovery rolls back a temporary backing when persistent session replacement fails", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-rollback", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);
  const managedBranch = String(worktree.branch);
  const targetBranch = String(worktree.targetBranch);

  await writeFile(`${oldRoot}/rollback-preserved.txt`, "preserved branch content\n");
  await git(oldRoot, ["add", "rollback-preserved.txt"]);
  await git(oldRoot, ["commit", "-m", "test: preserve rollback branch"]);
  const refsBefore = await managedRefs(context.project);
  const managedHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${managedBranch}`]);
  const targetHeadBefore = await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]);
  await rm(oldRoot, { recursive: true, force: true });
  const worktreesBefore = await gitOutput(context.project, ["worktree", "list", "--porcelain"]);

  const originalReplace = context.store.replaceWorktreeBacking.bind(context.store);
  context.store.replaceWorktreeBacking = (() => {
    throw new Error("injected recovery persistence failure");
  }) as typeof context.store.replaceWorktreeBacking;
  try {
    const repaired = await recoveryCall(context.client, workspaceId, "repair");
    assert.equal(repaired.isError, true);
    assert.match(allResponseText(repaired), /injected recovery persistence failure/i);
  } finally {
    context.store.replaceWorktreeBacking = originalReplace;
  }

  assert.equal(await managedRefs(context.project), refsBefore);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${managedBranch}`]), managedHeadBefore);
  assert.equal(await gitOutput(context.project, ["rev-parse", `refs/heads/${targetBranch}`]), targetHeadBefore);
  assert.equal(await gitOutput(context.project, ["worktree", "list", "--porcelain"]), worktreesBefore);
});

test("workspace.recovery runs successful AfterTool hooks from the repaired backing", async (t) => {
  const context = await fixture(t, {
    git: true,
    hooks: {
      AfterTool: [{
        matcher: { tool: "capability" },
        handlers: [{
          name: "Record recovery cwd",
          command: "node -e \"require('node:fs').writeFileSync('after-recovery-hook.txt', process.cwd())\"",
          report: false,
        }],
      }],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-recovery-after-hook", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  const oldRoot = String(worktree.path);

  await writeFile(`${oldRoot}/hook-recovery.txt`, "hook recovery\n");
  await git(oldRoot, ["add", "hook-recovery.txt"]);
  await git(oldRoot, ["commit", "-m", "test: recovery after-hook cwd"]);
  await rm(oldRoot, { recursive: true, force: true });

  const repaired = await recoveryCall(context.client, workspaceId, "repair");
  assert.equal(repaired.isError, undefined, allResponseText(repaired));
  const result = structuredContent(repaired).result as Record<string, unknown>;
  const newRoot = String(result.root);
  assert.notEqual(newRoot, oldRoot);
  assert.equal(await readFile(join(newRoot, "after-recovery-hook.txt"), "utf8"), newRoot);
});

test("workspace.recovery remains explicit-member scoped in a Composite Workspace", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-recovery-composite-member", "worktree");
  const memberWorkspaceId = String(structuredContent(opened).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "recovery-composite", context: "none" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: { name: "code", purpose: "Managed-worktree recovery", workspaceId: memberWorkspaceId },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const withoutMember = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.recovery",
      action: "run",
      arguments: { operation: "status" },
    },
  });
  assert.equal(withoutMember.isError, true);
  assert.match(allResponseText(withoutMember), /requires member/i);

  const withMember = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      name: "workspace.recovery",
      action: "run",
      arguments: { operation: "status" },
    },
  });
  assert.equal(withMember.isError, undefined, allResponseText(withMember));
  const result = structuredContent(withMember).result as Record<string, unknown>;
  assert.equal((result.recovery as Record<string, unknown>).classification, "healthy");
});

async function recoveryCall(
  client: Client,
  workspaceId: string,
  operation: "status" | "repair",
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.recovery",
      action: "run",
      arguments: { operation },
    },
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function managedRefs(cwd: string): Promise<string> {
  return gitOutput(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/forgerelay"]);
}
