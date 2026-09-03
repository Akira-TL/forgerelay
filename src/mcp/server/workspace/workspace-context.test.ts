import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import { buildCapabilityFingerprint } from "../core/capabilities.js";
import { loadConfig } from "../../../runtime/config/config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../runtime/state/db/client.js";
import type { IncomingArtifactAdapter } from "../../artifacts/incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { ProcessManager } from "../../process/process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../../workspaces/relay/auth/remote-auth.js";
import { createMcpServer, createServer } from "../../../server.js";
import {
  allResponseText,
  callOpen,
  fixture,
  git,
  responseCard,
  responseText,
  structuredContent,
  waitForCompletedProcess,
  waitForToolText,
} from "../../../runtime/testing/server-fixture.js";
import { SqliteWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceRegistry } from "../../../workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const canonicalToolNames = [
  "open_workspace",
  "activity_panel",
  "activity_snapshot",
  "activity_index",
  "activity_detail",
  "activity_output",
  "workspace_instruction",
  "capability",
  "close_workspace",
  "read",
  "write",
  "edit",
  "rename",
  "delete",
  "bash",
] as const;

test("capability fingerprint reports optional feature availability without copying tools/list", async (t) => {
  const context = await fixture(t, {
    env: {
      FORGERELAY_ARTIFACTS: "1",
      FORGERELAY_SUBAGENTS: "1",
      FORGERELAY_WIDGETS: "changes",
    },
  });

  assert.deepEqual(
    buildCapabilityFingerprint(context.config, packageJson.version, { artifactDownloadSupported: true }),
    {
      version: packageJson.version,
      toolMode: "full",
      capabilities: [
        "workspace.close",
        "worktree.managed",
        "filesystem.rename-move",
        "filesystem.delete",
        "process.lifecycle",
        "hooks.lifecycle",
        "capability-guides.read",
        "code.intelligence",
        "workspace.tasks",
        "batch.execute",
        "subagent.session",
        "artifact.native-download",
        "ui.mcp-app",
        "review.changes",
      ],
    },
  );
  assert.equal(
    buildCapabilityFingerprint(context.config, packageJson.version, { artifactDownloadSupported: false })
      .capabilities.includes("artifact.native-download"),
    false,
  );

  const optionalTools = await context.client.listTools();
  assert.deepEqual(optionalTools.tools.map((tool) => tool.name), canonicalToolNames);

  const opened = await callOpen(context.client, context.project, "chat-optional-guides");
  const openedStructured = structuredContent(opened);
  const guides = openedStructured.capabilityGuides as Array<Record<string, unknown>>;
  assert.deepEqual(guides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "subagents",
    "artifacts-review",
    "host-integration",
    "shell-processes",
    "code-intelligence",
    "workspace-tasks",
    "batch-execution",
  ]);

  for (const [name, firstPattern, secondPattern] of [
    ["subagents", /subagent\.session/, /first-class Subagent/],
    ["artifacts-review", /artifact\.download/, /review\.changes/],
    ["code-intelligence", /definition/, /Language server/],
  ] as const) {
    const guide = guides.find((candidate) => candidate.name === name);
    assert.ok(guide);
    const readGuide = await context.client.callTool({
      name: "read",
      arguments: { workspaceId: openedStructured.workspaceId, path: guide.path },
    });
    assert.equal(readGuide.isError, undefined);
    assert.match(allResponseText(readGuide), firstPattern);
    assert.match(allResponseText(readGuide), secondPattern);
  }
});

test("open_workspace advertises capability guides that read can load on demand", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-guides");
  const firstStructured = structuredContent(first);
  const guides = firstStructured.capabilityGuides as Array<Record<string, unknown>>;

  assert.deepEqual(guides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "host-integration",
    "shell-processes",
    "code-intelligence",
    "workspace-tasks",
    "batch-execution",
  ]);
  assert.match(String(guides[0]?.description), /Hook/);
  assert.match(String(guides[0]?.whenToRead), /Hook/);
  assert.match(String(guides[0]?.path), /capabilities\/lifecycle-hooks\/GUIDE\.md$/);
  assert.match(String(guides[1]?.path), /capabilities\/workspace\/managed-worktrees\/GUIDE\.md$/);
  assert.match(String(guides[2]?.path), /capabilities\/host-integration\/GUIDE\.md$/);
  assert.match(String(guides[3]?.path), /capabilities\/shell-processes\/GUIDE\.md$/);
  assert.match(String(guides[4]?.path), /capabilities\/code-intelligence\/GUIDE\.md$/);
  assert.match(String(guides[5]?.path), /capabilities\/workspace\/workspace-tasks\/GUIDE\.md$/);
  assert.match(String(guides[6]?.path), /capabilities\/batch-execution\/GUIDE\.md$/);

  const guideExpectations = [
    [0, /BeforeTool/, /BeforeWorktreeClose/],
    [2, /oauth-protected-resource/, /Failed to fetch template/],
    [3, /action="process"/, /tty: true/],
    [4, /definition/, /Language server/],
    [5, /workspace\.tasks/, /current Workspace|当前 Workspace/],
    [6, /1–100 tasks|1-100 tasks/, /bash\.run/],
  ] as const;
  for (const [index, firstPattern, secondPattern] of guideExpectations) {
    const readGuide = await context.client.callTool({
      name: "read",
      arguments: {
        workspaceId: firstStructured.workspaceId,
        path: guides[index]?.path,
      },
    });
    assert.equal(readGuide.isError, undefined);
    assert.match(allResponseText(readGuide), firstPattern);
    assert.match(allResponseText(readGuide), secondPattern);
  }

  const repeated = await callOpen(context.client, context.project, "chat-guides");
  assert.equal(structuredContent(repeated).capabilityGuides, undefined);
});

test("open_workspace hides skill filesystem paths and read loads skills through skills://", async (t) => {
  const context = await fixture(t);
  const skillDir = join(context.project, ".agents", "skills", "hidden-path-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: hidden-path-skill",
    "description: Loads without exposing its filesystem path.",
    "---",
    "skill entry body",
  ].join("\n"));
  await writeFile(join(skillDir, "reference.md"), "skill reference body\n");

  const duplicateSkillDir = join(context.config.agentDir, "skills", "hidden-path-skill");
  await mkdir(duplicateSkillDir, { recursive: true });
  await writeFile(join(duplicateSkillDir, "SKILL.md"), [
    "---",
    "name: hidden-path-skill",
    "description: Lower-priority duplicate.",
    "---",
    "duplicate body",
  ].join("\n"));

  const opened = await callOpen(context.client, context.project, "chat-skill-uri");
  const openedStructured = structuredContent(opened);
  const skills = openedStructured.skills as Array<Record<string, unknown>>;
  const skill = skills.find((candidate) => candidate.name === "hidden-path-skill");
  assert.deepEqual(skill, {
    name: "hidden-path-skill",
    description: "Loads without exposing its filesystem path.",
  });
  assert.equal("path" in skill!, false);
  assert.doesNotMatch(allResponseText(opened), /hidden-path-skill\/SKILL\.md/);

  const cardSkills = responseCard(opened).skills as Array<Record<string, unknown>>;
  const cardSkill = cardSkills.find((candidate) => candidate.name === "hidden-path-skill");
  assert.ok(cardSkill);
  assert.equal("path" in cardSkill, false);

  const diagnostics = openedStructured.skillDiagnostics as Array<Record<string, unknown>>;
  const collision = diagnostics.find((diagnostic) => diagnostic.type === "collision");
  assert.ok(collision);
  assert.equal("path" in collision, false);
  assert.doesNotMatch(JSON.stringify(collision), /winnerPath|loserPath|SKILL\.md|\.agents\/skills/);

  const workspaceId = String(openedStructured.workspaceId);
  const entry = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "skills://hidden-path-skill" },
  });
  assert.equal(entry.isError, undefined);
  assert.match(allResponseText(entry), /skill entry body/);

  const reference = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "skills://hidden-path-skill/reference.md" },
  });
  assert.equal(reference.isError, undefined);
  assert.match(allResponseText(reference), /skill reference body/);
});

test("different MCP conversations share one canonical checkout Workspace id and can explicitly resume it", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(resumed).workspaceId, firstId);

  const repeated = await callOpen(context.client, context.project, "chat-2");
  assert.equal(structuredContent(repeated).workspaceId, firstId);
});

test("open_workspace resolves a historical Workspace alias to the canonical Workspace id", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-canonical");
  const canonicalId = String(structuredContent(opened).workspaceId);
  const legacyAliasId = "ws_bbbbbbbbbb";
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      insert into workspace_session_aliases (alias_id, workspace_session_id)
      values (?, ?)
    `).run(legacyAliasId, canonicalId);
  } finally {
    database.close();
  }

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: legacyAliasId, context: "none" },
    _meta: { "openai/session": "chat-legacy-alias" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(resumed.isError, undefined, allResponseText(resumed));
  assert.equal(structuredContent(resumed).workspaceId, canonicalId);
  assert.doesNotMatch(allResponseText(resumed), new RegExp(legacyAliasId));
});

test("open_workspace reuses a stale checkout instead of reporting a duplicate logical Workspace", async (t) => {
  const context = await fixture(t);
  const old = await callOpen(context.client, context.project, "chat-old");
  const oldId = String(structuredContent(old).workspaceId);
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(), oldId);
  } finally {
    database.close();
  }

  const current = await callOpen(context.client, context.project, "chat-current");
  const stale = structuredContent(current).staleWorkspaces as Array<Record<string, unknown>>;
  assert.equal(structuredContent(current).workspaceId, oldId);
  assert.deepEqual(stale, []);
  assert.doesNotMatch(allResponseText(current), /Idle logical workspaces.*>2 days/);
});

test("idle GC keeps an unbound checkout Workspace identity reachable through MCP", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const workspaceId = String(structuredContent(first).workspaceId);
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(), workspaceId);
  } finally {
    database.close();
  }

  const reopened = await callOpen(context.client, context.project);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, workspaceId);

  const listed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId },
  });
  const inventory = structuredContent(listed).workspaces as Array<Record<string, unknown>>;
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0]?.workspaceId, workspaceId);
});

test("close_workspace preserves, reopens, and explicitly deletes a checkout Workspace", async (t) => {
  const context = await fixture(t);
  const sentinel = join(context.project, "workspace-delete-sentinel.txt");
  await writeFile(sentinel, "preserve checkout\n");
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.equal(secondId, firstId);
  const legacyAliasId = "ws_cccccccccc";
  const database = openDatabase(context.stateDir);
  try {
    database.sqlite.prepare(`
      insert into workspace_session_aliases (alias_id, workspace_session_id)
      values (?, ?)
    `).run(legacyAliasId, firstId);
  } finally {
    database.close();
  }

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: legacyAliasId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).workspaceId, firstId);
  assert.equal(structuredContent(closed).action, "close");
  assert.doesNotMatch(allResponseText(closed), new RegExp(legacyAliasId));
  assert.match(allResponseText(closed), /preserved/i);
  assert.match(allResponseText(closed), /Physical project files were not removed/);

  const listedClosed = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId: legacyAliasId },
  });
  const closedInventory = structuredContent(listedClosed).workspaces as Array<Record<string, unknown>>;
  assert.equal(closedInventory.length, 1);
  assert.equal(closedInventory[0]?.workspaceId, firstId);
  assert.equal(closedInventory[0]?.state, "closed");
  assert.equal(closedInventory[0]?.status, "closed");

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: firstId, path: "AGENTS.md" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId, context: "none" },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(reopened.isError, undefined, allResponseText(reopened));
  assert.equal(structuredContent(reopened).workspaceId, firstId);

  const reclosed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: firstId, action: "close" },
  });
  assert.equal(reclosed.isError, undefined, allResponseText(reclosed));

  const deleted = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: legacyAliasId, action: "delete" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
  assert.equal(structuredContent(deleted).workspaceId, firstId);
  assert.equal(structuredContent(deleted).action, "delete");
  assert.doesNotMatch(allResponseText(deleted), new RegExp(legacyAliasId));
  assert.match(allResponseText(deleted), /deleted ForgeRelay Workspace/i);
  assert.equal((await stat(context.project)).isDirectory(), true);
  assert.equal(await readFile(sentinel, "utf8"), "preserve checkout\n");

  const listedDeleted = await context.client.callTool({
    name: "open_workspace",
    arguments: { action: "list", workspaceId: firstId },
  });
  assert.equal(
    (structuredContent(listedDeleted).workspaces as Array<Record<string, unknown>>).length,
    0,
  );

  const replacement = await callOpen(context.client, context.project, "chat-1");
  assert.notEqual(structuredContent(replacement).workspaceId, firstId);
});

test("concurrent checkout opens return one full context and one reuse instruction", async (t) => {
  const context = await fixture(t);
  const [first, second] = await Promise.all([
    callOpen(context.client, context.project, "chat-1"),
    callOpen(context.client, context.project, "chat-1"),
  ]);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.equal(
    [first, second].filter((result) => Array.isArray(structuredContent(result).agentsFiles)).length,
    1,
  );
  assert.equal(
    [first, second].filter((result) => responseText(result).includes("Workspace already open as")).length,
    1,
  );
});

test("worktree mode reuses by default and only creates another worktree explicitly", async (t) => {
  const context = await fixture(t, { git: true });
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const firstWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const repeatedWorktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const freshWorktree = await callOpen(context.client, context.project, "chat-1", "worktree", true);
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(firstWorktree).workspaceId, structuredContent(repeatedWorktree).workspaceId);
  assert.notEqual(structuredContent(firstWorktree).workspaceId, structuredContent(freshWorktree).workspaceId);
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);

  const firstStructured = structuredContent(firstWorktree);
  assert.equal(firstStructured.mode, "worktree");
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.match(responseText(firstWorktree), /Opened isolated worktree workspace/);

  const repeatedStructured = structuredContent(repeatedWorktree);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.match(responseText(repeatedWorktree), /Workspace already open as/);

  const freshStructured = structuredContent(freshWorktree);
  assert.ok(Array.isArray(freshStructured.agentsFiles));
  assert.ok(Array.isArray(freshStructured.worktrees));
  assert.equal((freshStructured.worktrees as unknown[]).length, 2);

  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same directory previously opened/);
});

test("top-level work tools share the persistent Activity lifecycle while Bash process control does not create a duplicate Activity", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-activity-lifecycle");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const callWork = (name: string, args: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: args,
    _meta: { "openai/session": "chat-activity-lifecycle" },
  } as Parameters<Client["callTool"]>[0]);

  const read = await callWork("read", { workspaceId, path: "AGENTS.md" });
  assert.equal(read.isError, undefined);
  const written = await callWork("write", { workspaceId, path: "activity.txt", content: "before\n" });
  assert.equal(written.isError, undefined);
  const edited = await callWork("edit", {
    workspaceId,
    path: "activity.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });
  assert.equal(edited.isError, undefined);
  const renamed = await callWork("rename", { workspaceId, path: "activity.txt", newPath: "activity-renamed.txt" });
  assert.equal(renamed.isError, undefined);
  const deleted = await callWork("delete", { workspaceId, path: "activity-renamed.txt" });
  assert.equal(deleted.isError, undefined);
  const capability = await callWork("capability", {
    workspaceId,
    name: "hooks.check",
    action: "describe",
  });
  assert.equal(capability.isError, undefined);

  const started = await callWork("bash", {
    workspaceId,
    action: "run",
    command: "node -e \"setTimeout(() => {}, 150)\"",
    yieldTimeMs: 0,
  });
  assert.equal(started.isError, undefined);
  const processId = structuredContent(started).processId;
  assert.equal(typeof processId, "number");
  assert.equal(structuredContent(started).running, true);

  const polled = await callWork("bash", {
    workspaceId,
    action: "process",
    processId,
    yieldTimeMs: 1_000,
  });
  assert.equal(polled.isError, undefined);

  const finalRead = await callWork("read", { workspaceId, path: "AGENTS.md" });
  assert.equal(finalRead.isError, undefined);

  const expected = [
    ["act_test_1", "read", "done"],
    ["act_test_2", "write", "done"],
    ["act_test_3", "edit", "done"],
    ["act_test_4", "rename", "done"],
    ["act_test_5", "delete", "done"],
    ["act_test_6", "capability", "done"],
    ["act_test_7", "bash", "returned"],
    ["act_test_8", "bash_result", "done"],
    ["act_test_9", "read", "done"],
  ] as const;
  for (const [activityId, tool, state] of expected) {
    const activity = context.auditStore.getActivity(activityId);
    assert.equal(activity?.tool, tool, activityId);
    assert.equal(activity?.state, state, activityId);
    assert.equal(activity?.workspace.id, workspaceId, activityId);
    assert.equal(activity?.conversationScopeId, "chat-activity-lifecycle", activityId);
  }
  assert.deepEqual(context.auditStore.getActivity("act_test_2")?.request, {
    workspaceId,
    path: "activity.txt",
    content: "before\n",
  });
  assert.equal(context.auditStore.getActivity("act_test_10"), undefined);
});

