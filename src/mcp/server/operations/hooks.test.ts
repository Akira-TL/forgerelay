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
import { ActivityAuditStore } from "../../../activity/audit-store.js";
import { BashOutputStore } from "../../../activity/bash-output-store.js";
import { HostTurnStore } from "../../../activity/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/lifecycle.js";
import { ActivityQueryService } from "../../../activity/query-service.js";
import { buildCapabilityFingerprint } from "../../../capabilities.js";
import { loadConfig } from "../../../config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { openDatabase } from "../../../db/client.js";
import type { IncomingArtifactAdapter } from "../../../incoming-artifacts.js";
import { createReviewCheckpointManager } from "../../../review-checkpoints.js";
import { ProcessManager } from "../../../process-sessions.js";
import { authenticateRemote, withRemoteMcpClient } from "../../../remote-auth.js";
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
} from "../../../test-support/server-fixture.js";
import { SqliteWorkspaceStore } from "../../../workspace-store.js";
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

test("tool hooks observe success, failure, and file changes through the MCP surface", async (t) => {
  const recordCommand = `node -e "require('node:fs').appendFileSync('tool-hooks.log', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`;
  const handler = { command: recordCommand, timeoutSeconds: 30 };
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [handler],
      AfterTool: [handler],
      AfterToolFailure: [handler],
      AfterFileChange: [handler],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hooks");
  const workspaceId = String(structuredContent(opened).workspaceId);

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "hooked.txt", content: "hello\n" },
  });
  await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "hooked.txt", newPath: "renamed.txt" },
  });
  await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "renamed.txt" },
  });
  const failedEdit = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "hooked.txt",
      edits: [{ oldText: "missing", newText: "replacement" }],
    },
  });

  assert.equal(failedEdit.isError, true);
  assert.equal(
    (await readFile(join(context.project, "tool-hooks.log"), "utf8")).replace(/\r\n/g, "\n"),
    [
      "BeforeTool:write",
      "AfterTool:write",
      "AfterFileChange:write",
      "BeforeTool:rename",
      "AfterTool:rename",
      "AfterFileChange:rename",
      "BeforeTool:delete",
      "AfterTool:delete",
      "AfterFileChange:delete",
      "BeforeTool:edit",
      "AfterToolFailure:edit",
      "",
    ].join("\n"),
  );
});

test("WorkspaceOpen hook reports are visible on the open_workspace result", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks.json"),
    JSON.stringify({
      WorkspaceOpen: [
        {
          name: "Project workspace bootstrap",
          command: "node -e \"process.exit(0)\"",
        },
      ],
    }),
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-open-report");
  assert.match(
    allResponseText(opened),
    /Project workspace bootstrap \(WorkspaceOpen, project\) passed/,
  );
});

test("read lazily surfaces deep workspace instructions after bounded open discovery", async (t) => {
  const context = await fixture(t);
  const deepDir = join(context.project, "level-1", "level-2", "level-3");
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, "AGENTS.md"), "deep instructions\n");
  await writeFile(join(deepDir, "target.txt"), "target content\n");

  const opened = await callOpen(context.client, context.project, "chat-lazy-instructions");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const availableAgentsFiles = structuredContent(opened).availableAgentsFiles as Array<{ path?: string }> | undefined;
  assert.equal(
    availableAgentsFiles?.some((file) => file.path === "level-1/level-2/level-3/AGENTS.md") ?? false,
    false,
  );

  const firstRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "level-1/level-2/level-3/target.txt" },
  });
  assert.equal(firstRead.isError, undefined, allResponseText(firstRead));
  assert.match(allResponseText(firstRead), /Workspace instructions discovered for this path/);
  assert.match(allResponseText(firstRead), /deep instructions/);
  assert.deepEqual(structuredContent(firstRead).agentsFiles, [{
    path: "level-1/level-2/level-3/AGENTS.md",
    content: "deep instructions\n",
  }]);

  const secondRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "level-1/level-2/level-3/target.txt" },
  });
  assert.equal(structuredContent(secondRead).agentsFiles, undefined);
  assert.doesNotMatch(allResponseText(secondRead), /Workspace instructions discovered for this path/);
});

test("side-effect tools stop before mutation when lazy instructions are discovered", async (t) => {
  const context = await fixture(t);
  const deepDir = join(context.project, "write-level-1", "write-level-2", "write-level-3");
  await mkdir(deepDir, { recursive: true });
  await writeFile(join(deepDir, "AGENTS.md"), "write deep instructions\n");
  const target = join(deepDir, "created.txt");

  const opened = await callOpen(context.client, context.project, "chat-lazy-write-instructions");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const firstWrite = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "write-level-1/write-level-2/write-level-3/created.txt",
      content: "created after instructions\n",
    },
  });
  assert.equal(firstWrite.isError, true);
  assert.match(allResponseText(firstWrite), /write deep instructions/);
  assert.match(allResponseText(firstWrite), /No mutation or command was executed/);
  await assert.rejects(() => readFile(target, "utf8"), /ENOENT/);

  const secondWrite = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "write-level-1/write-level-2/write-level-3/created.txt",
      content: "created after instructions\n",
    },
  });
  assert.equal(secondWrite.isError, undefined, allResponseText(secondWrite));
  assert.equal(await readFile(target, "utf8"), "created after instructions\n");
});

test("invalid project hooks stay visible and can be repaired through ForgeRelay", async (t) => {
  const context = await fixture(t);
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "repaired-project-hook.json"),
    "{ invalid json\n",
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-repair");
  const workspaceId = String(structuredContent(opened).workspaceId);
  assert.match(allResponseText(opened), /Project hooks config.*failed/);

  const repairedConfig = JSON.stringify({
    event: "BeforeTool",
    matcher: { tool: "bash", commandRegex: "^printf repaired$" },
    command: "node -e \"process.exit(0)\"",
  });
  const repaired = await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: ".forgerelay/hooks/repaired-project-hook.json",
      content: `${repairedConfig}\n`,
    },
  });
  assert.equal(repaired.isError, undefined);

  const shell = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, command: "printf repaired" },
  });
  assert.match(
    allResponseText(shell),
    /repaired-project-hook \(BeforeTool, project\) passed/,
  );
});

test("global and project hook rules compose for the same tool call", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [
        {
          matcher: { tool: "bash", commandRegex: "^printf scoped-hooks$" },
          handlers: [
            {
              name: "Global bash check",
              command: "node -e \"process.exit(0)\"",
            },
          ],
        },
      ],
    },
  });
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "project-bash-check.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "^printf scoped-hooks$" },
      command: "node -e \"process.exit(0)\"",
    }),
  );

  const opened = await callOpen(context.client, context.project, "chat-hook-scopes");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: { workspaceId, command: "printf scoped-hooks" },
  });
  const visible = allResponseText(shell);

  assert.match(visible, /Global bash check \(BeforeTool, global\) passed/);
  assert.match(visible, /project-bash-check \(BeforeTool, project\) passed/);
});

test("reported hooks are visible to the MCP agent while report false stays silent", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [
        {
          matcher: { tool: "write" },
          handlers: [
            {
              name: "Write preflight",
              command: "node -e \"process.exit(0)\"",
            },
          ],
        },
      ],
      AfterTool: [
        {
          matcher: { tool: "write" },
          handlers: [
            {
              name: "Silent write observer",
              command: "node -e \"process.exit(0)\"",
              report: false,
            },
          ],
        },
      ],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hook-report");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "reported.txt", content: "hello\n" },
  });
  const visible = allResponseText(written);
  const structuredVisible = String(structuredContent(written).result);

  assert.match(visible, /Hook results:/);
  assert.match(visible, /Write preflight.*passed/);
  assert.doesNotMatch(visible, /Silent write observer/);
  assert.match(structuredVisible, /Hook results:/);
  assert.match(structuredVisible, /Write preflight.*passed/);
  assert.doesNotMatch(structuredVisible, /Silent write observer/);
});

test("BeforeTool hook failure prevents the tool operation", async (t) => {
  const context = await fixture(t, {
    hooks: {
      BeforeTool: [{
        name: "Silent blocking policy",
        command: `node -e "if (process.env.FORGERELAY_TOOL_NAME === 'write') process.exit(13)"`,
        timeoutSeconds: 30,
        report: false,
      }],
      AfterToolFailure: [{
        command: `node -e "require('node:fs').appendFileSync('blocked-hook.log', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_TOOL_NAME + '\\n')"`,
        timeoutSeconds: 30,
      }],
    },
  });
  const opened = await callOpen(context.client, context.project, "chat-hook-block");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const blocked = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "blocked.txt", content: "must not exist\n" },
  });
  assert.equal(blocked.isError, true);
  assert.match(allResponseText(blocked), /Silent blocking policy.*failed/);
  assert.match(allResponseText(blocked), /exited with code 13/);
  await assert.rejects(() => readFile(join(context.project, "blocked.txt"), "utf8"), /ENOENT/);
  assert.equal(
    (await readFile(join(context.project, "blocked-hook.log"), "utf8")).replace(/\r\n/g, "\n"),
    "AfterToolFailure:write\n",
  );
  const activity = context.auditStore.getActivity("act_test_1");
  assert.equal(activity?.tool, "write");
  assert.equal(activity?.state, "blocked");
  assert.equal(activity?.workspace.id, workspaceId);
  assert.match(activity?.error ?? "", /Silent blocking policy.*failed/);
});

