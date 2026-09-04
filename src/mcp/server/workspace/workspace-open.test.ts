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

test("open_workspace keeps lifecycle flags out of model output and makes repeated card metadata lightweight", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.deepEqual(firstStructured.capabilityFingerprint, {
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
      "workspace.recovery",
      "batch.execute",
      "ui.mcp-app",
    ],
  });
  assert.deepEqual(structuredContent(repeated).capabilityFingerprint, firstStructured.capabilityFingerprint);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const firstText = responseText(first);
  assert.match(firstText, /workspace\.tasks/);
  assert.match(firstText, /proactively/i);
  assert.match(firstText, /do not query it mechanically on every open/i);

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same directory previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /capability guides/);
  assert.match(repeatedText, /workspace\.tasks/);
  assert.match(repeatedText, /proactively/i);
  assert.match(repeatedText, /do not query it mechanically on every open/i);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated) as {
    workspaceReused?: boolean;
    includeBootstrapContext?: boolean;
    presentationRevision?: string;
    agentsFiles?: Array<{ path?: string; content?: string }>;
    availableAgentsFiles?: Array<{ path?: string }>;
    skills?: Array<{ name?: string; description?: string; path?: string }>;
    agentProviders?: Array<{ name?: string }>;
    agents?: Array<{ name?: string }>;
  };
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.equal(typeof card.presentationRevision, "string");
  assert.ok((card.agentsFiles?.length ?? 0) > 0);
  assert.ok(card.agentsFiles?.every((file) => typeof file.path === "string" && file.content === undefined));
  assert.ok(card.availableAgentsFiles?.every((file) => typeof file.path === "string"));
  assert.ok(card.skills?.every((skill) => skill.path === undefined));
  assert.ok(card.agentProviders?.every((provider) => provider.name !== undefined));
  assert.ok(card.agents?.every((agent) => agent.name !== undefined));
});

test("Workspace Panel loads advertised instruction bodies on demand without activating nested context", async (t) => {
  const context = await fixture(t);
  const nested = join(context.project, "panel-preview");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "AGENTS.md"), "panel-only nested instructions\n");
  await writeFile(join(nested, "target.txt"), "target\n");
  await writeFile(join(context.project, "not-an-instruction.txt"), "private workspace file\n");

  const opened = await callOpen(context.client, context.project, "chat-panel-instruction");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const available = structuredContent(opened).availableAgentsFiles as Array<{ path?: string }>;
  assert.equal(available.some((file) => file.path === "panel-preview/AGENTS.md"), true);

  const tools = await context.client.listTools();
  const instructionTool = tools.tools.find((tool) => tool.name === "workspace_instruction");
  assert.deepEqual(
    (instructionTool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility,
    ["app"],
  );

  const detail = await context.client.callTool({
    name: "workspace_instruction",
    arguments: { workspaceId, path: "panel-preview/AGENTS.md" },
  });
  assert.equal(detail.isError, undefined, allResponseText(detail));
  assert.deepEqual(structuredContent(detail), {
    path: "panel-preview/AGENTS.md",
    content: "panel-only nested instructions\n",
    status: "available",
  });

  const rejected = await context.client.callTool({
    name: "workspace_instruction",
    arguments: { workspaceId, path: "not-an-instruction.txt" },
  });
  assert.equal(rejected.isError, true);
  assert.match(allResponseText(rejected), /not advertised for this Workspace/);

  const ordinaryRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "panel-preview/target.txt" },
  });
  assert.equal(ordinaryRead.isError, undefined, allResponseText(ordinaryRead));
  assert.deepEqual(structuredContent(ordinaryRead).agentsFiles, [{
    path: "panel-preview/AGENTS.md",
    content: "panel-only nested instructions\n",
  }]);
});

test("open_workspace context policy suppresses, automatically delivers, and forces bootstrap context", async (t) => {
  const context = await fixture(t);
  const skipped = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, context: "none" },
    _meta: { "openai/session": "chat-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const skippedStructured = structuredContent(skipped);

  assert.equal(typeof skippedStructured.contextFingerprint, "string");
  assert.equal(skippedStructured.agentsFiles, undefined);
  assert.equal(skippedStructured.skills, undefined);

  const automatic = await callOpen(context.client, context.project, "chat-context-policy");
  const automaticStructured = structuredContent(automatic);
  assert.equal(automaticStructured.workspaceId, skippedStructured.workspaceId);
  assert.equal(automaticStructured.contextFingerprint, skippedStructured.contextFingerprint);
  assert.ok(Array.isArray(automaticStructured.agentsFiles));
  assert.ok(Array.isArray(automaticStructured.skills));

  const repeated = await callOpen(context.client, context.project, "chat-context-policy");
  assert.equal(structuredContent(repeated).agentsFiles, undefined);

  const forced = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: automaticStructured.workspaceId, context: "full" },
    _meta: { "openai/session": "chat-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  assert.ok(Array.isArray(structuredContent(forced).agentsFiles));
  assert.match(allResponseText(forced), /context="auto" avoids repeating unchanged bootstrap context/);
});

test("open_workspace creates and resumes an empty Composite Workspace through the normal lifecycle", async (t) => {
  const context = await fixture(t);
  const created = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "research-project", context: "none" },
    _meta: { "openai/session": "chat-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const createdStructured = structuredContent(created);

  assert.match(String(createdStructured.workspaceId), /^cws_[a-f0-9]{10}$/);
  assert.equal(createdStructured.kind, "composite");
  assert.equal(createdStructured.name, "research-project");
  assert.deepEqual(createdStructured.members, []);
  assert.equal(createdStructured.root, undefined);
  assert.equal(createdStructured.mode, undefined);
  assert.match(allResponseText(created), /Composite Workspace/i);
  assert.match(allResponseText(created), /workspace\.tasks/);
  assert.match(allResponseText(created), /proactively/i);
  assert.match(allResponseText(created), /do not query it mechanically on every open/i);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: createdStructured.workspaceId, context: "none" },
    _meta: { "openai/session": "chat-composite-other" },
  } as Parameters<Client["callTool"]>[0]);
  const resumedStructured = structuredContent(resumed);
  assert.equal(resumedStructured.workspaceId, createdStructured.workspaceId);
  assert.equal(resumedStructured.kind, "composite");
  assert.equal(resumedStructured.name, "research-project");
  assert.deepEqual(resumedStructured.members, []);
});

test("Composite Workspace mounts an existing Workspace and requires explicit member routing", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "member.txt"), "member-data\n");
  const ordinary = await callOpen(context.client, context.project, "chat-member-source");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "multi-machine" },
    _meta: { "openai/session": "chat-member-composite" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);

  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Source control and code analysis",
        workspaceId: ordinaryId,
      },
    },
    _meta: { "openai/session": "chat-member-composite" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(mounted.isError, undefined, allResponseText(mounted));
  const mountedStructured = structuredContent(mounted);
  assert.equal(mountedStructured.kind, "composite");
  assert.deepEqual(mountedStructured.members, [{
    name: "code",
    purpose: "Source control and code analysis",
    workspaceId: ordinaryId,
  }]);

  const missingMember = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, path: "member.txt" },
  });
  assert.equal(missingMember.isError, true);
  assert.match(allResponseText(missingMember), /requires member/i);

  const routed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "code", path: "member.txt" },
  });
  assert.equal(routed.isError, undefined);
  assert.match(allResponseText(routed), /member-data/);
  assert.equal((routed._meta as Record<string, unknown> | undefined)?.tool, "read");
  const routedCard = (routed._meta as { card?: Record<string, unknown> } | undefined)?.card;
  assert.equal(routedCard?.workspaceId, compositeId);
  assert.equal(routedCard?.member, "code");
});

test("Composite Workspace can open a path-backed member and explicitly load that member bootstrap", async (t) => {
  const context = await fixture(t);
  await writeFile(join(context.project, "compute.txt"), "compute-data\n");
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "member-definition" },
    _meta: { "openai/session": "chat-member-definition" },
  } as Parameters<Client["callTool"]>[0]);
  const compositeId = String(structuredContent(composite).workspaceId);

  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "compute",
        purpose: "High-performance computation",
        path: context.project,
      },
    },
    _meta: { "openai/session": "chat-member-definition" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(mounted.isError, undefined, allResponseText(mounted));
  const mountedStructured = structuredContent(mounted);
  const members = mountedStructured.members as Array<Record<string, unknown>>;
  assert.equal(members.length, 1);
  assert.equal(members[0]?.name, "compute");
  assert.equal(members[0]?.purpose, "High-performance computation");
  assert.match(String(members[0]?.workspaceId), /^ws_[a-f0-9]{10}$/);
  const memberWorkspaceId = String(members[0]?.workspaceId);

  const updated = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "update",
      member: {
        name: "compute",
        newName: "gpu",
        purpose: "Accelerated computation",
      },
    },
  });
  assert.equal(updated.isError, undefined, allResponseText(updated));
  assert.deepEqual(structuredContent(updated).members, [{
    name: "gpu",
    purpose: "Accelerated computation",
    workspaceId: memberWorkspaceId,
  }]);

  const suppressed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "none" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const suppressedMemberContext = structuredContent(suppressed).memberContext as Record<string, unknown>;
  assert.equal(suppressedMemberContext.includeBootstrapContext, false);
  assert.equal(suppressedMemberContext.agentsFiles, undefined);
  assert.match(String(suppressedMemberContext.instruction), /suppressed.*context=none/i);
  assert.doesNotMatch(String(suppressedMemberContext.instruction), /already delivered/i);

  const automatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const automaticMemberContext = structuredContent(automatic).memberContext as Record<string, unknown>;
  assert.equal(automaticMemberContext.includeBootstrapContext, true);
  assert.ok(Array.isArray(automaticMemberContext.agentsFiles));

  const repeatedAutomatic = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const repeatedMemberContext = structuredContent(repeatedAutomatic).memberContext as Record<string, unknown>;
  assert.equal(repeatedMemberContext.includeBootstrapContext, false);
  assert.match(String(repeatedMemberContext.instruction), /already delivered/i);

  await writeFile(join(context.project, "AGENTS.md"), "updated Composite member instructions\n");
  const incremental = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "auto" },
    _meta: { "openai/session": "chat-member-context-policy" },
  } as Parameters<Client["callTool"]>[0]);
  const incrementalMemberContext = structuredContent(incremental).memberContext as Record<string, unknown>;
  assert.equal(incrementalMemberContext.includeBootstrapContext, true);
  assert.match(JSON.stringify(incrementalMemberContext.agentsFiles), /updated Composite member instructions/);
  assert.equal(incrementalMemberContext.availableAgentsFiles, undefined);
  assert.equal(incrementalMemberContext.skills, undefined);
  assert.equal(incrementalMemberContext.capabilityGuides, undefined);
  assert.equal(incrementalMemberContext.agentProviders, undefined);
  assert.equal(incrementalMemberContext.agents, undefined);
  assert.equal(incrementalMemberContext.skillDiagnostics, undefined);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(closed.isError, undefined, allResponseText(closed));
  assert.equal(structuredContent(closed).status, "closed");

  const reopened = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: compositeId, memberName: "gpu", context: "full" },
    _meta: { "openai/session": "chat-member-bootstrap" },
  } as Parameters<Client["callTool"]>[0]);
  const reopenedStructured = structuredContent(reopened);
  const memberContext = reopenedStructured.memberContext as Record<string, unknown>;
  assert.equal(reopenedStructured.workspaceId, compositeId);
  assert.equal(memberContext.member, "gpu");
  assert.equal(memberContext.workspaceId, compositeId);
  assert.equal(memberContext.root, context.project);
  assert.equal(memberContext.includeBootstrapContext, true);
  assert.ok(Array.isArray(memberContext.agentsFiles));
  assert.match(JSON.stringify(memberContext.agentsFiles), /updated Composite member instructions/);
  assert.ok(Array.isArray(memberContext.capabilityGuides));
  assert.ok(Array.isArray(memberContext.agentProviders));
  assert.ok(Array.isArray(memberContext.agents));

  const ordinaryBootstrap = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: memberWorkspaceId, context: "full" },
    _meta: { "openai/session": "chat-member-bootstrap-ordinary" },
  } as Parameters<Client["callTool"]>[0]);
  const ordinaryBootstrapStructured = structuredContent(ordinaryBootstrap);
  assert.deepEqual(memberContext.capabilityGuides, ordinaryBootstrapStructured.capabilityGuides);
  assert.deepEqual(memberContext.agentProviders, ordinaryBootstrapStructured.agentProviders);
  assert.deepEqual(memberContext.agents, ordinaryBootstrapStructured.agents);

  const routed = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "gpu", path: "compute.txt" },
  });
  assert.match(allResponseText(routed), /compute-data/);

  const ordinaryMember = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, member: "gpu", path: "compute.txt" },
  });
  assert.equal(ordinaryMember.isError, true);
  assert.match(allResponseText(ordinaryMember), /not composite/i);

  const removed = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "remove",
      member: { name: "gpu" },
    },
  });
  assert.equal(removed.isError, undefined, allResponseText(removed));
  assert.deepEqual(structuredContent(removed).members, []);

  const removedRoute = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: compositeId, member: "gpu", path: "compute.txt" },
  });
  assert.equal(removedRoute.isError, true);
  assert.match(allResponseText(removedRoute), /has no member gpu/i);

  const memberStillOpen = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: memberWorkspaceId, path: "compute.txt" },
  });
  assert.equal(memberStillOpen.isError, undefined, allResponseText(memberStillOpen));
  assert.match(allResponseText(memberStillOpen), /compute-data/);
});

test("Composite Workspace explicitly routes filesystem, process, and capability surfaces to one member", async (t) => {
  const context = await fixture(t);
  const ordinary = await callOpen(context.client, context.project, "chat-composite-surfaces-member");
  const ordinaryId = String(structuredContent(ordinary).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "surface-routing" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  const mounted = await context.client.callTool({
    name: "open_workspace",
    arguments: {
      action: "member",
      workspaceId: compositeId,
      memberAction: "add",
      member: {
        name: "code",
        purpose: "Source mutations and verification",
        workspaceId: ordinaryId,
      },
    },
  });
  assert.equal(mounted.isError, undefined, allResponseText(mounted));

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId: compositeId, member: "code", path: "routed.txt", content: "before\n" },
  });
  assert.equal(written.isError, undefined, allResponseText(written));
  assert.equal((written._meta as { card?: Record<string, unknown> } | undefined)?.card?.workspaceId, compositeId);

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId: compositeId,
      member: "code",
      path: "routed.txt",
      edits: [{ oldText: "before", newText: "after" }],
    },
  });
  assert.equal(edited.isError, undefined, allResponseText(edited));

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId: compositeId, member: "code", path: "routed.txt", newPath: "renamed.txt" },
  });
  assert.equal(renamed.isError, undefined, allResponseText(renamed));

  const process = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId: compositeId, member: "code", command: "cat renamed.txt" },
  });
  assert.equal(process.isError, undefined, allResponseText(process));
  assert.match(allResponseText(process), /after/);
  assert.equal((process._meta as { card?: Record<string, unknown> } | undefined)?.card?.workspaceId, compositeId);
  assert.equal((process._meta as { card?: Record<string, unknown> } | undefined)?.card?.member, "code");

  const capability = await context.client.callTool({
    name: "capability",
    arguments: { workspaceId: compositeId, member: "code", name: "hooks.check", action: "describe" },
  });
  assert.equal(capability.isError, undefined, allResponseText(capability));
  assert.match(allResponseText(capability), /hooks\.check/);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId: compositeId, member: "code", path: "renamed.txt" },
  });
  assert.equal(deleted.isError, undefined, allResponseText(deleted));
});

test("Composite Workspace aggregates member Activities into one Host Turn without changing audit ownership", async (t) => {
  const context = await fixture(t);
  const secondProject = join(dirname(context.project), "second-project");
  await mkdir(secondProject, { recursive: true });
  await writeFile(join(secondProject, "AGENTS.md"), "second project instructions\n");
  await writeFile(join(context.project, "code.txt"), "code-member\n");
  await writeFile(join(secondProject, "data.txt"), "data-member\n");

  const codeWorkspace = await callOpen(context.client, context.project, "chat-composite-activity-code");
  const dataWorkspace = await callOpen(context.client, secondProject, "chat-composite-activity-data");
  const codeWorkspaceId = String(structuredContent(codeWorkspace).workspaceId);
  const dataWorkspaceId = String(structuredContent(dataWorkspace).workspaceId);
  const composite = await context.client.callTool({
    name: "open_workspace",
    arguments: { kind: "composite", name: "activity-aggregate" },
  });
  const compositeId = String(structuredContent(composite).workspaceId);
  for (const member of [
    { name: "code", purpose: "Source work", workspaceId: codeWorkspaceId },
    { name: "data", purpose: "Dataset work", workspaceId: dataWorkspaceId },
  ]) {
    const mounted = await context.client.callTool({
      name: "open_workspace",
      arguments: { action: "member", workspaceId: compositeId, memberAction: "add", member },
    });
    assert.equal(mounted.isError, undefined, allResponseText(mounted));
  }

  const panel = await context.client.callTool({
    name: "activity_panel",
    arguments: { workspaceId: compositeId },
  });
  assert.equal(panel.isError, undefined, allResponseText(panel));
  const turnId = String(structuredContent(panel).turnId);

  for (const [member, path] of [["code", "code.txt"], ["data", "data.txt"]] as const) {
    const read = await context.client.callTool({
      name: "read",
      arguments: { workspaceId: compositeId, member, path },
    });
    assert.equal(read.isError, undefined, allResponseText(read));
  }

  const snapshotResult = await context.client.callTool({
    name: "activity_snapshot",
    arguments: { turnId },
  });
  assert.equal(snapshotResult.isError, undefined, allResponseText(snapshotResult));
  assert.equal(structuredContent(snapshotResult).activities, undefined);
  const indexResult = await context.client.callTool({
    name: "activity_index",
    arguments: { turnId },
  });
  assert.equal(indexResult.isError, undefined, allResponseText(indexResult));
  const activities = structuredContent(indexResult).activities as Array<Record<string, unknown>>;
  assert.equal(activities.length, 2);
  assert.deepEqual(activities.map((activity) => activity.member), ["code", "data"]);
  assert.deepEqual(activities.map((activity) => activity.workspaceId), [codeWorkspaceId, dataWorkspaceId]);

  const auditRecords = activities.map((activity) => context.auditStore.getActivity(String(activity.activityId)));
  assert.equal(auditRecords[0]?.turnId, turnId);
  assert.equal(auditRecords[0]?.workspace.id, codeWorkspaceId);
  assert.equal(auditRecords[1]?.turnId, turnId);
  assert.equal(auditRecords[1]?.workspace.id, dataWorkspaceId);
});

