import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../../../runtime/testing/server-fixture.js";

test("workspace.conversation-health guides checkpoint and rotation across Host conversations", async (t) => {
  const context = await fixture(t, { git: true });
  const conversationA = "conversation-health-a";
  const opened = await callOpen(context.client, context.project, conversationA);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const catalog = structuredContent(opened).capabilityCatalog as Array<{ name?: string }>;
  assert.equal(catalog.some((entry) => entry.name === "workspace.conversation-health"), true);

  await beginHostTurns(context.client, workspaceId, conversationA, 11);
  const healthyBeforeCheckpointThreshold = await healthCall(
    context.client,
    workspaceId,
    conversationA,
  );
  assert.equal(healthyBeforeCheckpointThreshold.status, "healthy");
  assert.equal(
    (healthyBeforeCheckpointThreshold.metrics as Record<string, unknown>).hostTurnCount,
    11,
  );

  await beginHostTurns(context.client, workspaceId, conversationA, 1);
  const checkpointRecommended = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(checkpointRecommended.status, "checkpoint-recommended");
  assert.equal(checkpointRecommended.recommendedAction, "checkpoint");
  assert.deepEqual(checkpointRecommended.policy, {
    checkpointTurnThreshold: 12,
    rotationTurnThreshold: 24,
    checkpointFreshTurnWindow: 8,
  });
  assert.deepEqual(checkpointRecommended.metrics, {
    hostTurnCount: 12,
    turnsSinceLatestCheckpoint: 12,
  });
  assert.deepEqual(checkpointRecommended.reasons, [
    "host_turn_count_checkpoint_threshold",
    "checkpoint_missing",
  ]);

  const listCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: { operation: "list.create", name: "Patch release" },
    },
    _meta: { "openai/session": conversationA },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(listCreated.isError, undefined, allResponseText(listCreated));
  const listId = String(
    ((structuredContent(listCreated).result as Record<string, unknown>).lists as Array<Record<string, unknown>>)[0]?.id,
  );
  const taskCreated = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.tasks",
      action: "run",
      arguments: {
        operation: "task.create",
        listId,
        subject: "Verify 1.3.3",
        content: "Keep this detail out of bounded handoff metadata.",
        status: "in_progress",
      },
    },
    _meta: { "openai/session": conversationA },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(taskCreated.isError, undefined, allResponseText(taskCreated));

  await writeFile(join(context.project, "handoff.txt"), "durable working tree state\n");
  const firstCheckpoint = await checkpointCall(
    context.client,
    workspaceId,
    conversationA,
    "conversation health boundary",
  );
  const firstCheckpointId = String(firstCheckpoint.id);

  const healthyAfterCheckpoint = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(healthyAfterCheckpoint.status, "healthy");
  assert.equal(healthyAfterCheckpoint.recommendedAction, "continue");
  assert.equal(
    (healthyAfterCheckpoint.latestCheckpoint as Record<string, unknown>).id,
    firstCheckpointId,
  );
  assert.equal(
    (healthyAfterCheckpoint.metrics as Record<string, unknown>).turnsSinceLatestCheckpoint,
    0,
  );

  await beginHostTurns(context.client, workspaceId, conversationA, 8);
  const freshWindowBoundary = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(freshWindowBoundary.status, "healthy");
  assert.equal(freshWindowBoundary.recommendedAction, "continue");
  assert.equal((freshWindowBoundary.metrics as Record<string, unknown>).hostTurnCount, 20);
  assert.equal(
    (freshWindowBoundary.metrics as Record<string, unknown>).turnsSinceLatestCheckpoint,
    8,
  );
  assert.deepEqual(freshWindowBoundary.reasons, ["checkpoint_recent"]);

  await beginHostTurns(context.client, workspaceId, conversationA, 1);
  const staleWindowBoundary = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(staleWindowBoundary.status, "checkpoint-recommended");
  assert.equal(staleWindowBoundary.recommendedAction, "checkpoint");
  assert.equal((staleWindowBoundary.metrics as Record<string, unknown>).hostTurnCount, 21);
  assert.equal(
    (staleWindowBoundary.metrics as Record<string, unknown>).turnsSinceLatestCheckpoint,
    9,
  );
  assert.deepEqual(staleWindowBoundary.reasons, [
    "host_turn_count_checkpoint_threshold",
    "checkpoint_stale",
  ]);

  await beginHostTurns(context.client, workspaceId, conversationA, 2);
  const beforeRotation = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(beforeRotation.status, "checkpoint-recommended");
  assert.equal(beforeRotation.recommendedAction, "checkpoint");
  assert.equal((beforeRotation.metrics as Record<string, unknown>).hostTurnCount, 23);

  await beginHostTurns(context.client, workspaceId, conversationA, 1);
  const rotationNeedsCheckpoint = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(rotationNeedsCheckpoint.status, "rotation-recommended");
  assert.equal(rotationNeedsCheckpoint.recommendedAction, "checkpoint-and-rotate");
  assert.equal(
    (rotationNeedsCheckpoint.metrics as Record<string, unknown>).hostTurnCount,
    24,
  );
  assert.equal(
    (rotationNeedsCheckpoint.metrics as Record<string, unknown>).turnsSinceLatestCheckpoint,
    12,
  );
  assert.deepEqual(rotationNeedsCheckpoint.reasons, [
    "host_turn_count_rotation_threshold",
    "checkpoint_stale",
  ]);

  const rotationCheckpoint = await checkpointCall(
    context.client,
    workspaceId,
    conversationA,
    "rotate conversation",
  );
  const rotationCheckpointId = String(rotationCheckpoint.id);
  const readyToRotate = await healthCall(context.client, workspaceId, conversationA);
  assert.equal(readyToRotate.status, "rotation-recommended");
  assert.equal(readyToRotate.recommendedAction, "rotate");
  assert.deepEqual(readyToRotate.reasons, [
    "host_turn_count_rotation_threshold",
    "checkpoint_recent",
  ]);

  const activeTasks = readyToRotate.activeTasks as Array<Record<string, unknown>>;
  assert.equal(activeTasks.length, 1);
  assert.equal(activeTasks[0]?.listName, "Patch release");
  assert.equal(activeTasks[0]?.subject, "Verify 1.3.3");
  assert.equal(activeTasks[0]?.status, "in_progress");
  assert.equal(JSON.stringify(activeTasks).includes("Keep this detail out"), false);
  const git = readyToRotate.git as Record<string, unknown>;
  assert.equal(git.dirty, true);
  assert.equal(git.changedFiles, 1);
  assert.match(String(git.head), /^[a-f0-9]{40,64}$/);

  const reopened = await callOpen(context.client, context.project, "conversation-health-b");
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);
  await beginHostTurns(context.client, workspaceId, "conversation-health-b", 1);
  const recovered = await healthCall(
    context.client,
    workspaceId,
    "conversation-health-b",
  );
  assert.equal(recovered.status, "healthy");
  assert.equal((recovered.metrics as Record<string, unknown>).hostTurnCount, 1);
  assert.equal(
    (recovered.latestCheckpoint as Record<string, unknown>).id,
    rotationCheckpointId,
  );
  assert.deepEqual(recovered.activeTasks, activeTasks);
  assert.deepEqual(recovered.git, git);
});

test("Composite workspace.conversation-health requires and scopes through an explicit member", async (t) => {
  const context = await fixture(t, { git: true });
  const memberOpened = await callOpen(
    context.client,
    context.project,
    "conversation-health-composite-member",
  );
  const memberWorkspaceId = String(structuredContent(memberOpened).workspaceId);
  const compositeOpened = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      kind: "composite",
      name: "conversation-health-composite",
      context: "none",
    },
  });
  const compositeId = String(structuredContent(compositeOpened).workspaceId);
  const added = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Conversation health target",
        workspaceId: memberWorkspaceId,
      },
    },
  });
  assert.equal(added.isError, undefined, allResponseText(added));

  const withoutMember = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      name: "workspace.conversation-health",
      action: "run",
      arguments: {},
    },
    _meta: { "openai/session": "conversation-health-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(withoutMember.isError, true);
  assert.match(allResponseText(withoutMember), /requires member/i);

  await beginHostTurns(
    context.client,
    compositeId,
    "conversation-health-composite",
    12,
  );

  const memberHealth = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      name: "workspace.conversation-health",
      action: "run",
      arguments: {},
    },
    _meta: { "openai/session": "conversation-health-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(memberHealth.isError, undefined, allResponseText(memberHealth));
  const result = structuredContent(memberHealth).result as Record<string, unknown>;
  assert.equal(result.workspaceId, compositeId);
  assert.equal(result.status, "checkpoint-recommended");
  assert.equal(result.recommendedAction, "checkpoint");
  assert.equal((result.metrics as Record<string, unknown>).hostTurnCount, 12);
  assert.match(String((result.git as Record<string, unknown>).head), /^[a-f0-9]{40,64}$/);
});

async function beginHostTurns(
  client: Client,
  workspaceId: string,
  conversationScopeId: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const panel = await client.callTool({
      name: "activity_panel",
      arguments: { workspaceId },
      _meta: { "openai/session": conversationScopeId },
    } as Parameters<Client["callTool"]>[0]);
    assert.equal(panel.isError, undefined, allResponseText(panel));
  }
}

async function healthCall(
  client: Client,
  workspaceId: string,
  conversationScopeId: string,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.conversation-health",
      action: "run",
      arguments: {},
    },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(response.isError, undefined, allResponseText(response));
  return structuredContent(response).result as Record<string, unknown>;
}

async function checkpointCall(
  client: Client,
  workspaceId: string,
  conversationScopeId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "workspace.checkpoint",
      action: "run",
      arguments: { operation: "create", name },
    },
    _meta: { "openai/session": conversationScopeId },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(response.isError, undefined, allResponseText(response));
  return (
    (structuredContent(response).result as Record<string, unknown>).checkpoint as Record<string, unknown>
  );
}
