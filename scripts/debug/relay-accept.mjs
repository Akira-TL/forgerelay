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
import { debugRoot, repoRoot } from "./runtime.mjs";

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
const gatewayOwnerToken = randomBytes(32).toString("base64url");
const executionOwnerToken = randomBytes(32).toString("base64url");
const bootstrapSecret = "RELAY_ACCEPTANCE_BOOTSTRAP_SECRET";
const checkoutTaskBody = "RELAY_ACCEPTANCE_EXECUTION_TASK_BODY";
const worktreeTaskBody = "RELAY_ACCEPTANCE_WORKTREE_TASK_BODY";
const compositeMemberTaskBody = "RELAY_ACCEPTANCE_COMPOSITE_MEMBER_TASK_BODY";
const compositeTaskBody = "RELAY_ACCEPTANCE_COMPOSITE_OWN_TASK_BODY";

await assertPortsFree([gatewayPort, executionPort]);
rmSync(acceptanceRoot, { recursive: true, force: true });
mkdirSync(gatewayLocalProject, { recursive: true });
mkdirSync(executionCheckout, { recursive: true });
mkdirSync(gatewayConfigDir, { recursive: true });
mkdirSync(executionConfigDir, { recursive: true });
writeFileSync(join(gatewayLocalProject, "sentinel.txt"), "gateway-local-content\n");
writeFileSync(join(executionCheckout, "sentinel.txt"), "execution-remote-content\n");
writeFileSync(join(executionCheckout, "AGENTS.md"), `${bootstrapSecret}\n`);
setupGitProject(executionWorktreeSource);

writeAuthFile(gatewayConfigDir, gatewayOwnerToken, "relay-acceptance-gateway");
writeAuthFile(executionConfigDir, executionOwnerToken, "relay-acceptance-execution");

const executionEnv = instanceEnv({
  port: executionPort,
  baseUrl: executionBaseUrl,
  configDir: executionConfigDir,
  stateDir: executionStateDir,
  worktreeRoot: executionWorktreeRoot,
  allowedRoot: executionProjects,
  ownerToken: executionOwnerToken,
});
const gatewayEnv = instanceEnv({
  port: gatewayPort,
  baseUrl: gatewayBaseUrl,
  configDir: gatewayConfigDir,
  stateDir: gatewayStateDir,
  worktreeRoot: gatewayWorktreeRoot,
  allowedRoot: gatewayProjects,
  ownerToken: gatewayOwnerToken,
});

const execution = spawnServer(executionEnv, "Execution 7678");
let gateway;
let completed = false;

try {
  await waitForHealth(execution, executionBaseUrl, "Execution 7678");
  pass("execution health", executionBaseUrl);

  const authenticated = runCli(
    ["auth", `127.0.0.1:${executionPort}`, "--token", executionOwnerToken, "--alias", "execution"],
    { ...cleanProductEnv(), FORGERELAY_CONFIG_DIR: gatewayConfigDir },
  );
  assert.equal(authenticated.status, 0, authenticated.stderr || authenticated.stdout);
  pass("Gateway remote auth", "CLI auth route to isolated 7678 Execution");

  const gatewayAuth = JSON.parse(readFileSync(join(gatewayConfigDir, "auth.json"), "utf8"));
  const remoteRecord = gatewayAuth.remotes?.execution;
  assert.ok(remoteRecord?.accessToken);
  assert.ok(remoteRecord?.refreshToken);
  assert.equal(remoteRecord?.target, executionBaseUrl);

  gateway = spawnServer(gatewayEnv, "Gateway 7677");
  await waitForHealth(gateway, gatewayBaseUrl, "Gateway 7677");
  pass("gateway health", gatewayBaseUrl);

  const oauth = authorizeHost(gatewayBaseUrl, gatewayMcpUrl, gatewayOwnerToken);
  const sessionA = initializeSession(gatewayMcpUrl, oauth.accessToken, 1, "relay-acceptance-a");
  const sessionB = initializeSession(gatewayMcpUrl, oauth.accessToken, 2, "relay-acceptance-b");
  pass("Gateway OAuth/MCP", "two real HTTP MCP sessions initialized on 7677");

  let requestId = 10;
  const nextId = () => requestId++;
  const conversationA = { "openai/session": "relay-acceptance-conversation-a" };
  const conversationB = { "openai/session": "relay-acceptance-conversation-b" };

  const openedA = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    path: executionCheckout,
    relay: "execution",
    context: "none",
  }, conversationA);
  assertToolOk(openedA, "open relayed checkout A");
  const checkoutRelayId = openedA.structuredContent.workspaceId;
  assert.match(checkoutRelayId, /^rws_/);

  const openedB = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    path: executionCheckout,
    relay: "execution",
    context: "none",
  }, conversationB);
  assertToolOk(openedB, "open relayed checkout B");
  assert.equal(openedB.structuredContent.workspaceId, checkoutRelayId);
  pass("relay persistent identity", `two Gateway conversations reused ${checkoutRelayId}`);

  const checkoutList = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: checkoutRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Relay checkout acceptance" },
  }, conversationA);
  assertToolOk(checkoutList, "create relayed checkout Task List");
  const checkoutListId = checkoutList.structuredContent.result.lists[0].id;
  const checkoutTask = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: checkoutRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: checkoutListId,
      subject: "Verify real Relay Task ownership",
      content: checkoutTaskBody,
      status: "in_progress",
    },
  }, conversationA);
  assertToolOk(checkoutTask, "create relayed checkout Task");

  const checkoutTaskFile = findTaskStateFile(executionStateDir, checkoutTaskBody);
  assert.ok(checkoutTaskFile, "Execution Task state file was not found");
  const checkoutExecutionWorkspaceId = checkoutTaskFile.split("/").at(-2);
  assert.match(checkoutExecutionWorkspaceId, /^ws_[0-9a-f]{10}$/);
  assertTaskBodyAbsentFromGateway(checkoutTaskBody);
  pass("Execution-owned Task truth", `${checkoutExecutionWorkspaceId} owns the Task state; Gateway has no shadow copy`);

  for (let index = 0; index < 2; index += 1) {
    const read = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "read", {
      workspaceId: checkoutRelayId,
      path: "sentinel.txt",
    }, conversationB);
    assertToolOk(read, "pre-reminder relayed read");
    assert.doesNotMatch(toolText(read), /Reminder: this Workspace has unfinished active Tasks/);
  }
  const reminderRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "read", {
    workspaceId: checkoutRelayId,
    path: "sentinel.txt",
  }, conversationB);
  assertToolOk(reminderRead, "relayed reminder read");
  assert.match(toolText(reminderRead), /Reminder: this Workspace has unfinished active Tasks/);
  assert.equal(toolText(reminderRead).includes(checkoutTaskBody), false);
  pass("Relay Task reminder", "owning Execution emitted a body-free reminder after 3 semantic calls");

  const closedCheckout = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "close_workspace", {
    workspaceId: checkoutRelayId,
  }, conversationA);
  assertToolOk(closedCheckout, "close relayed checkout");
  assert.equal(closedCheckout.structuredContent.action, "close");

  const inspectedCheckout = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: checkoutRelayId,
  }, conversationB);
  assertToolOk(inspectedCheckout, "inspect closed relayed checkout");
  assert.equal(inspectedCheckout.structuredContent.inspection.state, "closed");
  assert.equal(inspectedCheckout.structuredContent.inspection.status, "closed");
  assert.equal(inspectedCheckout.structuredContent.inspection.taskSummary.lists[0].unfinishedTaskCount, 1);
  assertSafeRelayInspection(inspectedCheckout, {
    executionWorkspaceId: checkoutExecutionWorkspaceId,
    remoteRecord,
    taskBodies: [checkoutTaskBody],
  });

  const reopenedCheckout = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    workspaceId: checkoutRelayId,
    context: "none",
  }, conversationB);
  assertToolOk(reopenedCheckout, "reopen relayed checkout");
  assert.equal(reopenedCheckout.structuredContent.workspaceId, checkoutRelayId);
  const restoredCheckoutTasks = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "capability", {
    workspaceId: checkoutRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get", level: "headers", listId: checkoutListId },
  }, conversationB);
  assertToolOk(restoredCheckoutTasks, "restore relayed checkout Tasks");
  assert.equal(restoredCheckoutTasks.structuredContent.result.lists[0].tasks[0].subject, "Verify real Relay Task ownership");
  assert.equal("content" in restoredCheckoutTasks.structuredContent.result.lists[0].tasks[0], false);

  const deletedCheckout = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "close_workspace", {
    workspaceId: checkoutRelayId,
    action: "delete",
  }, conversationB);
  assertToolOk(deletedCheckout, "delete relayed checkout");
  assert.equal(deletedCheckout.structuredContent.action, "delete");
  assert.equal(readFileSync(join(executionCheckout, "sentinel.txt"), "utf8"), "execution-remote-content\n");
  assert.equal(existsSync(checkoutTaskFile), false);
  const deletedCheckoutInspection = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: checkoutRelayId,
  }, conversationA);
  assert.equal(deletedCheckoutInspection.isError, true);

  const freshCheckout = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    path: executionCheckout,
    relay: "execution",
    context: "none",
  }, conversationA);
  assertToolOk(freshCheckout, "recreate relayed checkout after delete");
  const compositeRelayMemberId = freshCheckout.structuredContent.workspaceId;
  assert.match(compositeRelayMemberId, /^rws_/);
  assert.notEqual(compositeRelayMemberId, checkoutRelayId);
  pass("relay close/reopen/delete", "close preserved route, reopen reused it, delete removed it");

  const worktreeOpened = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    path: executionWorktreeSource,
    relay: "execution",
    mode: "worktree",
    context: "none",
  }, conversationA);
  assertToolOk(worktreeOpened, "open relayed managed worktree");
  const worktreeRelayId = worktreeOpened.structuredContent.workspaceId;
  const firstWorktreeRoot = worktreeOpened.structuredContent.root;
  assert.match(worktreeRelayId, /^rws_/);
  assert.notEqual(firstWorktreeRoot, executionWorktreeSource);

  const worktreeList = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: worktreeRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Relay worktree acceptance" },
  }, conversationA);
  assertToolOk(worktreeList, "create relayed worktree Task List");
  const worktreeListId = worktreeList.structuredContent.result.lists[0].id;
  const worktreeTask = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: worktreeRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: worktreeListId,
      subject: "Survive real managed finalize",
      content: worktreeTaskBody,
      status: "in_progress",
    },
  }, conversationA);
  assertToolOk(worktreeTask, "create relayed worktree Task");
  const worktreeTaskFile = findTaskStateFile(executionStateDir, worktreeTaskBody);
  assert.ok(worktreeTaskFile, "Execution managed-worktree Task state file was not found");
  const worktreeExecutionWorkspaceId = worktreeTaskFile.split("/").at(-2);
  assertTaskBodyAbsentFromGateway(worktreeTaskBody);

  const worktreeWrite = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "write", {
    workspaceId: worktreeRelayId,
    path: "relay-acceptance.txt",
    content: "real managed Relay acceptance\n",
  }, conversationA);
  assertToolOk(worktreeWrite, "write relayed managed worktree");

  const worktreeClosed = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "close_workspace", {
    workspaceId: worktreeRelayId,
    commitMessage: "TEST: (relay) finalize real managed worktree",
  }, conversationA);
  assertToolOk(worktreeClosed, "close/finalize relayed managed worktree");
  assert.equal(existsSync(firstWorktreeRoot), false);
  assert.equal(readFileSync(join(executionWorktreeSource, "relay-acceptance.txt"), "utf8"), "real managed Relay acceptance\n");
  assert.equal(existsSync(worktreeTaskFile), true);

  const inspectedWorktree = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: worktreeRelayId,
  }, conversationB);
  assertToolOk(inspectedWorktree, "inspect closed relayed managed worktree");
  assert.equal(inspectedWorktree.structuredContent.inspection.state, "closed");
  assert.equal(inspectedWorktree.structuredContent.inspection.mode, "worktree");
  assert.equal(inspectedWorktree.structuredContent.inspection.managed, true);
  assert.equal(inspectedWorktree.structuredContent.inspection.rootValid, false);
  assertSafeRelayInspection(inspectedWorktree, {
    executionWorkspaceId: worktreeExecutionWorkspaceId,
    remoteRecord,
    taskBodies: [worktreeTaskBody],
  });

  const worktreeReopened = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    workspaceId: worktreeRelayId,
    context: "none",
  }, conversationB);
  assertToolOk(worktreeReopened, "reopen relayed managed worktree");
  assert.equal(worktreeReopened.structuredContent.workspaceId, worktreeRelayId);
  assert.notEqual(worktreeReopened.structuredContent.root, firstWorktreeRoot);
  const worktreeRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "read", {
    workspaceId: worktreeRelayId,
    path: "relay-acceptance.txt",
  }, conversationB);
  assertToolOk(worktreeRead, "read reopened relayed managed worktree");
  assert.match(toolText(worktreeRead), /real managed Relay acceptance/);
  const restoredWorktreeTasks = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "capability", {
    workspaceId: worktreeRelayId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get", level: "headers", listId: worktreeListId },
  }, conversationB);
  assertToolOk(restoredWorktreeTasks, "restore relayed worktree Tasks");
  assert.equal(restoredWorktreeTasks.structuredContent.result.lists[0].tasks[0].subject, "Survive real managed finalize");

  const worktreeDeleted = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "close_workspace", {
    workspaceId: worktreeRelayId,
    action: "delete",
    commitMessage: "TEST: (relay) delete real managed worktree",
  }, conversationB);
  assertToolOk(worktreeDeleted, "delete relayed managed worktree");
  assert.equal(existsSync(worktreeTaskFile), false);
  pass("managed-worktree Relay parity", "finalize removed backing, reopen kept rws/Task identity, delete removed state");

  const localOpened = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    path: gatewayLocalProject,
    context: "none",
  }, conversationA);
  assertToolOk(localOpened, "open local Composite member");
  const localWorkspaceId = localOpened.structuredContent.workspaceId;

  const memberList = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: compositeRelayMemberId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Composite relay member acceptance" },
  }, conversationA);
  assertToolOk(memberList, "create Composite relay member Task List");
  const memberListId = memberList.structuredContent.result.lists[0].id;
  const memberTask = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: compositeRelayMemberId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: memberListId,
      subject: "Remote Composite member Task",
      content: compositeMemberTaskBody,
      status: "in_progress",
    },
  }, conversationA);
  assertToolOk(memberTask, "create Composite relay member Task");
  const memberTaskFile = findTaskStateFile(executionStateDir, compositeMemberTaskBody);
  assert.ok(memberTaskFile, "Execution Composite-member Task state file was not found");
  const memberExecutionWorkspaceId = memberTaskFile.split("/").at(-2);
  assertTaskBodyAbsentFromGateway(compositeMemberTaskBody);

  const compositeOpened = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
    kind: "composite",
    name: `relay-acceptance-${randomUUID().slice(0, 8)}`,
    context: "none",
  }, conversationA);
  assertToolOk(compositeOpened, "open Composite Workspace");
  const compositeId = compositeOpened.structuredContent.workspaceId;

  for (const member of [
    { name: "local", purpose: "Gateway local member", workspaceId: localWorkspaceId },
    { name: "remote", purpose: "Execution Relay member", workspaceId: compositeRelayMemberId },
  ]) {
    const mounted = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "open_workspace", {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member,
    }, conversationA);
    assertToolOk(mounted, `mount Composite member ${member.name}`);
  }

  const localRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "read", {
    workspaceId: compositeId,
    member: "local",
    path: "sentinel.txt",
  }, conversationA);
  assertToolOk(localRead, "read local Composite member");
  assert.match(toolText(localRead), /gateway-local-content/);

  const remoteRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "read", {
    workspaceId: compositeId,
    member: "remote",
    path: "sentinel.txt",
  }, conversationA);
  assertToolOk(remoteRead, "read relayed Composite member");
  assert.match(toolText(remoteRead), /execution-remote-content/);
  assert.doesNotMatch(toolText(remoteRead), /gateway-local-content/);

  const compositeList = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: compositeId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Composite own acceptance" },
  }, conversationA);
  assertToolOk(compositeList, "create Composite-owned Task List");
  const compositeListId = compositeList.structuredContent.result.lists[0].id;
  const compositeTask = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "capability", {
    workspaceId: compositeId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: compositeListId,
      subject: "Composite own Task",
      content: compositeTaskBody,
      status: "in_progress",
    },
  }, conversationA);
  assertToolOk(compositeTask, "create Composite-owned Task");
  const compositeTaskFile = findTaskStateFile(gatewayStateDir, compositeTaskBody);
  assert.ok(compositeTaskFile, "Gateway Composite-owned Task state file was not found");
  assert.equal(compositeTaskFile.split("/").at(-2), compositeId);
  assert.equal(readFileSync(memberTaskFile, "utf8").includes(compositeTaskBody), false);

  const compositeInspection = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: compositeId,
  }, conversationB);
  assertToolOk(compositeInspection, "inspect Composite Workspace");
  assert.equal(compositeInspection.structuredContent.inspection.taskSummary.lists[0].unfinishedTaskCount, 1);
  assert.equal(JSON.stringify(compositeInspection).includes(compositeMemberTaskBody), false);

  const memberInspection = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: compositeRelayMemberId,
  }, conversationB);
  assertToolOk(memberInspection, "inspect relayed Composite member");
  assertSafeRelayInspection(memberInspection, {
    executionWorkspaceId: memberExecutionWorkspaceId,
    remoteRecord,
    taskBodies: [compositeMemberTaskBody],
  });

  const closedMember = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "close_workspace", {
    workspaceId: compositeRelayMemberId,
  }, conversationB);
  assertToolOk(closedMember, "close relayed Composite member");
  const closedMemberRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "read", {
    workspaceId: compositeId,
    member: "remote",
    path: "sentinel.txt",
  }, conversationA);
  assert.equal(closedMemberRead.isError, true);

  const inspectedClosedMember = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    action: "inspect",
    workspaceId: compositeRelayMemberId,
  }, conversationB);
  assertToolOk(inspectedClosedMember, "inspect closed relayed Composite member");
  assert.equal(inspectedClosedMember.structuredContent.inspection.state, "closed");
  assert.equal(inspectedClosedMember.structuredContent.inspection.taskSummary.lists[0].unfinishedTaskCount, 1);

  const reopenedMember = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "open_workspace", {
    workspaceId: compositeRelayMemberId,
    context: "none",
  }, conversationB);
  assertToolOk(reopenedMember, "reopen relayed Composite member");
  assert.equal(reopenedMember.structuredContent.workspaceId, compositeRelayMemberId);
  const reopenedMemberRead = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "read", {
    workspaceId: compositeId,
    member: "remote",
    path: "sentinel.txt",
  }, conversationA);
  assertToolOk(reopenedMemberRead, "read reopened relayed Composite member");
  assert.match(toolText(reopenedMemberRead), /execution-remote-content/);
  const restoredMemberTasks = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "capability", {
    workspaceId: compositeRelayMemberId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get", level: "headers", listId: memberListId },
  }, conversationB);
  assertToolOk(restoredMemberTasks, "restore relayed Composite member Tasks");
  assert.equal(restoredMemberTasks.structuredContent.result.lists[0].tasks[0].subject, "Remote Composite member Task");
  assertTaskBodyAbsentFromGateway(compositeMemberTaskBody);
  pass("Composite local + Relay member", "member execution/lifecycle/Task truth stayed with owning Workspace");

  const deleteComposite = callTool(gatewayMcpUrl, oauth.accessToken, sessionA, nextId(), "close_workspace", {
    workspaceId: compositeId,
    action: "delete",
  }, conversationA);
  assertToolOk(deleteComposite, "delete Composite Workspace");
  const deleteRemoteMember = callTool(gatewayMcpUrl, oauth.accessToken, sessionB, nextId(), "close_workspace", {
    workspaceId: compositeRelayMemberId,
    action: "delete",
  }, conversationB);
  assertToolOk(deleteRemoteMember, "delete relayed Composite member Workspace");

  writeFileSync(join(acceptanceRoot, "result.json"), `${JSON.stringify({
    passed: true,
    gateway: gatewayBaseUrl,
    execution: executionBaseUrl,
    ports: [gatewayPort, executionPort],
    verified: [
      "persistent relay checkout identity across Gateway conversations",
      "Execution-owned Task state and body-free reminders",
      "safe relayed inspection projection",
      "close/reopen/delete parity",
      "managed-worktree finalize/reopen/delete parity",
      "Composite local + relayed member lifecycle and Task ownership",
      "no 7676 interaction",
    ],
  }, null, 2)}\n`);
  completed = true;
} catch (error) {
  console.error("\nForgeRelay 7677/7678 Relay acceptance failed.");
  throw error;
} finally {
  if (gateway) await stopServer(gateway);
  await stopServer(execution);
}

if (completed) {
  console.log("\nForgeRelay 7677/7678 Relay acceptance passed.");
  console.log(`Artifacts: ${acceptanceRoot}`);
}

function cleanProductEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    name !== "HOST"
    && name !== "PORT"
    && !name.startsWith("FORGERELAY_")
  ));
}

function instanceEnv({ port, baseUrl, configDir, stateDir, worktreeRoot, allowedRoot, ownerToken }) {
  return {
    ...cleanProductEnv(),
    HOST: "127.0.0.1",
    PORT: String(port),
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_PUBLIC_BASE_URL: baseUrl,
    FORGERELAY_ALLOWED_ROOTS: allowedRoot,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_WORKTREE_ROOT: worktreeRoot,
    FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
    FORGERELAY_TOOL_MODE: "full",
    FORGERELAY_WIDGETS: "off",
    FORGERELAY_SKILLS: "0",
    FORGERELAY_SUBAGENTS: "0",
    FORGERELAY_ARTIFACTS: "0",
    FORGERELAY_TASK_REMINDER_INTERVAL: "3",
    FORGERELAY_LOG_LEVEL: process.env.FORGERELAY_LOG_LEVEL ?? "warn",
    FORGERELAY_LOG_FORMAT: process.env.FORGERELAY_LOG_FORMAT ?? "pretty",
  };
}

function writeAuthFile(configDir, ownerToken, instanceId) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "auth.json"), `${JSON.stringify({ ownerToken, instanceId }, null, 2)}\n`, { mode: 0o600 });
}

function spawnServer(env, label) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("exit", (code, signal) => {
    if (code && code !== 0) console.error(`${label} exited with code ${code}${signal ? ` (${signal})` : ""}`);
  });
  return child;
}

function runCli(args, env) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function authorizeHost(baseUrl, mcpUrl, ownerToken) {
  const metadata = jsonRequest(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(metadata.status, 200);
  const redirectUri = `${baseUrl}/debug/relay-callback`;
  const registration = jsonRequest(metadata.json.registration_endpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ForgeRelay 7677/7678 Relay acceptance",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(registration.status, 201);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = curlRequest({
    method: "POST",
    url: metadata.json.authorization_endpoint,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: registration.json.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "forgerelay",
      resource: mcpUrl,
      state: "forgerelay-relay-acceptance",
      owner_token: ownerToken,
    }).toString(),
  });
  assert.equal(authorization.status, 302);
  const redirect = new URL(authorization.headers.get("location"));
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "forgerelay-relay-acceptance");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const token = jsonRequest(metadata.json.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.json.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcpUrl,
    }).toString(),
  });
  assert.equal(token.status, 200);
  assert.ok(token.json.access_token);
  return { accessToken: token.json.access_token };
}

function initializeSession(mcpUrl, accessToken, id, clientName) {
  const initialized = mcpRequest(mcpUrl, accessToken, undefined, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const notification = curlRequest({
    method: "POST",
    url: mcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);
  return sessionId;
}

function callTool(mcpUrl, accessToken, sessionId, id, name, args, meta) {
  const message = mcpRequest(mcpUrl, accessToken, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    },
  }).message;
  assert.equal(message.id, id);
  assert.ok(message.result, `tool ${name} did not return a result`);
  return message.result;
}

function mcpRequest(mcpUrl, accessToken, sessionId, request) {
  const response = curlRequest({
    method: "POST",
    url: mcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, response.body);
  return { response, message: parseMcpMessage(response.body, request.id) };
}

function mcpHeaders(accessToken, sessionId) {
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function parseMcpMessage(body, expectedId) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const messages = dataLines.length > 0
    ? dataLines.map((line) => JSON.parse(line))
    : [JSON.parse(body)];
  return messages.find((message) => message.id === expectedId) ?? messages[0];
}

function jsonRequest(url, options = {}) {
  const response = curlRequest({
    method: options.method ?? "GET",
    url,
    headers: options.headers,
    body: options.body,
  });
  return { ...response, json: JSON.parse(response.body) };
}

function curlRequest({ method = "GET", url, headers = {}, body }) {
  const marker = `__FORGERELAY_RELAY_ACCEPT_STATUS_${randomUUID()}__`;
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "20",
    "--request",
    method,
    "--dump-header",
    "-",
    "--output",
    "-",
    "--write-out",
    `\n${marker}%{http_code}`,
  ];
  for (const [name, value] of Object.entries(headers)) args.push("--header", `${name}: ${value}`);
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push(url);
  const result = spawnSync("curl", args, {
    cwd: repoRoot,
    input: body,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`curl ${method} ${url} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }

  const statusMarker = `\n${marker}`;
  const markerIndex = result.stdout.lastIndexOf(statusMarker);
  assert.notEqual(markerIndex, -1, `curl response did not contain status marker for ${url}`);
  const rawResponse = result.stdout.slice(0, markerIndex);
  const status = Number(result.stdout.slice(markerIndex + statusMarker.length).trim());
  const separator = rawResponse.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const headerEnd = rawResponse.indexOf(separator);
  assert.notEqual(headerEnd, -1, `curl response did not contain headers for ${url}`);
  const headerBlock = rawResponse.slice(0, headerEnd);
  const responseBody = rawResponse.slice(headerEnd + separator.length);
  const responseHeaders = new Map();
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers: responseHeaders, body: responseBody };
}

async function waitForHealth(child, baseUrl, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited before health check: ${child.exitCode}`);
    try {
      const response = jsonRequest(`${baseUrl}/healthz`);
      if (response.status === 200) return response.json;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`${label} did not become healthy at ${baseUrl}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function assertPortsFree(ports) {
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

function setupGitProject(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "Relay managed worktree acceptance\n");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "forgerelay-debug@example.com"]);
  runGit(root, ["config", "user.name", "ForgeRelay Debug"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial Relay acceptance commit"]);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function taskStateFiles(stateDir) {
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

function findTaskStateFile(stateDir, needle) {
  return taskStateFiles(stateDir).find((path) => readFileSync(path, "utf8").includes(needle));
}

function assertTaskBodyAbsentFromGateway(body) {
  const leaked = taskStateFiles(gatewayStateDir).filter((path) => readFileSync(path, "utf8").includes(body));
  assert.deepEqual(leaked, [], `Gateway stored an Execution-owned Task body in: ${leaked.join(", ")}`);
}

function assertSafeRelayInspection(result, { executionWorkspaceId, remoteRecord, taskBodies }) {
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

function assertToolOk(result, label) {
  assert.equal(result.isError, undefined, `${label}: ${toolText(result)}`);
}

function toolText(result) {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

function pass(label, detail) {
  console.log(`PASS ${label}: ${detail}`);
}
