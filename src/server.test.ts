import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { parseHookConfig, type HookConfigInput } from "./hooks.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

test("MCP instructions separate capability contract from configurable workflow policy", async (t) => {
  const defaultContext = await fixture(t);
  const defaultInstructions = defaultContext.client.getInstructions() ?? "";
  const defaultTools = await defaultContext.client.listTools();
  assert.equal(defaultContext.client.getServerVersion()?.version, packageJson.version);
  const shellTool = defaultTools.tools.find((tool) => tool.name === "bash");
  const writeStdinTool = defaultTools.tools.find((tool) => tool.name === "write_stdin");
  const openWorkspaceTool = defaultTools.tools.find((tool) => tool.name === "open_workspace");
  const shellToolMeta = shellTool?._meta as {
    ui?: { resourceUri?: string; visibility?: string[] };
    "openai/outputTemplate"?: string;
  } | undefined;
  const shellInputProperties = (shellTool?.inputSchema as {
    properties?: Record<string, { description?: string }>;
  } | undefined)?.properties;

  assert.match(defaultInstructions, /Default to the user's existing checkout/);
  assert.match(defaultInstructions, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(defaultInstructions, /close_worktree/);
  assert.match(defaultInstructions, /close_workspace/);
  assert.match(defaultInstructions, /write_stdin/);
  assert.match(defaultInstructions, /Shell commands may modify ordinary project files/);
  assert.match(defaultInstructions, /\/etc\/sudoers/);
  assert.match(defaultInstructions, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(defaultInstructions, /Do not create or modify files with bash/);
  assert.equal(openWorkspaceTool?.annotations?.readOnlyHint, false);
  assert.equal(openWorkspaceTool?.annotations?.destructiveHint, false);
  assert.match(shellTool?.description ?? "", /local user's authority/);
  assert.match(shellTool?.description ?? "", /may modify ordinary project files/);
  assert.match(shellTool?.description ?? "", /\/etc\/sudoers/);
  assert.match(shellTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.match(shellTool?.description ?? "", /external device or hardware mutations/);
  assert.match(shellTool?.description ?? "", /explicitly asks for the actual device-changing operation/);
  assert.match(shellTool?.description ?? "", /waits up to 300 seconds/);
  assert.match(shellTool?.description ?? "", /write_stdin/);
  assert.doesNotMatch(shellTool?.description ?? "", /Do not use bash to create, move, rename, or delete project files/);
  assert.doesNotMatch(shellTool?.description ?? "", /Use only for/);
  assert.equal(
    shellInputProperties?.command?.description,
    "Shell command to run with the local user's authority.",
  );
  assert.equal(shellInputProperties?.timeout, undefined);
  const writeStdinInputProperties = (writeStdinTool?.inputSchema as {
    properties?: Record<string, { description?: string }>;
  } | undefined)?.properties;
  assert.match(writeStdinInputProperties?.processId?.description ?? "", /Canonical process identifier/);
  assert.match(writeStdinInputProperties?.sessionId?.description ?? "", /Deprecated alias for processId/);
  assert.match(
    shellToolMeta?.ui?.resourceUri ?? "",
    /^ui:\/\/forgerelay\/workspace-app-(?:[0-9a-f]{12}|\d+\.\d+\.\d+)\.html$/,
  );
  assert.deepEqual(shellToolMeta?.ui?.visibility, ["model", "app"]);
  assert.equal(shellToolMeta?.["openai/outputTemplate"], shellToolMeta?.ui?.resourceUri);
  assert.ok(defaultTools.tools.some((tool) => tool.name === "write_stdin"));
  assert.ok(defaultTools.tools.some((tool) => tool.name === "close_workspace"));

  const overrideContext = await fixture(t, {
    env: {
      DEVSPACE_WORKFLOW_INSTRUCTIONS: "Follow repository-defined development and Git workflows.",
      DEVSPACE_APPEND_INSTRUCTIONS: "Preserve the capability contract.",
    },
  });
  const overrideInstructions = overrideContext.client.getInstructions() ?? "";

  assert.match(overrideInstructions, /Default to the user's existing checkout/);
  assert.match(overrideInstructions, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(overrideInstructions, /close_worktree/);
  assert.match(overrideInstructions, /close_workspace/);
  assert.match(overrideInstructions, /Follow instructions returned by open_workspace/);
  assert.match(overrideInstructions, /Follow repository-defined development and Git workflows\./);
  assert.match(overrideInstructions, /Preserve the capability contract\./);
  assert.match(overrideInstructions, /Shell commands may modify ordinary project files/);
  assert.match(overrideInstructions, /\/etc\/sudoers/);
  assert.doesNotMatch(overrideInstructions, /Do not create or modify files with bash/);

  const codexContext = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });
  const codexTools = await codexContext.client.listTools();
  const execCommandTool = codexTools.tools.find((tool) => tool.name === "exec_command");
  assert.match(execCommandTool?.description ?? "", /may modify ordinary project files/);
  assert.match(execCommandTool?.description ?? "", /\/etc\/sudoers/);
  assert.match(execCommandTool?.description ?? "", /configuration files through shell only when the user's request explicitly calls for that configuration change/);
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
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
      "process.write-stdin",
      "inspection.search-tools",
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

  const repeatedText = responseText(repeated);
  assert.match(repeatedText, /Workspace already open as/);
  assert.match(repeatedText, /same directory previously opened/);
  assert.match(repeatedText, /Reuse this workspaceId for subsequent tool calls/);
  assert.match(repeatedText, /previously provided for this workspace/);
  assert.match(repeatedText, /not repeated here/);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace advertises capability guides that read can load on demand", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-guides");
  const firstStructured = structuredContent(first);
  const guides = firstStructured.capabilityGuides as Array<Record<string, unknown>>;

  assert.deepEqual(guides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
  ]);
  assert.match(String(guides[0]?.description), /Hook/);
  assert.match(String(guides[0]?.whenToRead), /Hook/);
  assert.match(String(guides[0]?.path), /capabilities\/lifecycle-hooks\/GUIDE\.md$/);
  assert.match(String(guides[1]?.path), /capabilities\/managed-worktrees\/GUIDE\.md$/);

  const readGuide = await context.client.callTool({
    name: "read",
    arguments: {
      workspaceId: firstStructured.workspaceId,
      path: guides[0]?.path,
    },
  });
  assert.equal(readGuide.isError, undefined);
  assert.match(allResponseText(readGuide), /BeforeTool/);
  assert.match(allResponseText(readGuide), /BeforeWorktreeClose/);

  const repeated = await callOpen(context.client, context.project, "chat-guides");
  assert.equal(structuredContent(repeated).capabilityGuides, undefined);
});

test("different MCP conversations get different stable workspace ids and can explicitly resume one", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);
  assert.notEqual(secondId, firstId);

  const resumed = await context.client.callTool({
    name: "open_workspace",
    arguments: { workspaceId: firstId },
    _meta: { "openai/session": "chat-2" },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(resumed).workspaceId, firstId);

  const repeated = await callOpen(context.client, context.project, "chat-2");
  assert.equal(structuredContent(repeated).workspaceId, firstId);
});

test("open_workspace reports all logical workspaces idle for more than two days", async (t) => {
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
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.workspaceId, oldId);
  assert.match(allResponseText(current), /Idle logical workspaces.*>2 days/);
  assert.match(allResponseText(current), new RegExp(oldId));
  assert.match(allResponseText(current), /do not clean them up automatically/i);
});

test("close_workspace releases one logical checkout handle without touching another", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const second = await callOpen(context.client, context.project, "chat-2");
  const firstId = String(structuredContent(first).workspaceId);
  const secondId = String(structuredContent(second).workspaceId);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId: firstId },
  });
  assert.equal(closed.isError, undefined);
  assert.match(allResponseText(closed), /Physical project files were not removed/);

  const closedRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: firstId, path: "AGENTS.md" },
  });
  assert.equal(closedRead.isError, true);
  assert.match(allResponseText(closedRead), /Unknown workspaceId/);

  const liveRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId: secondId, path: "AGENTS.md" },
  });
  assert.equal(liveRead.isError, undefined);
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

test("write can create a file in the OS temp directory without opening it as a workspace", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-write");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const written = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: tempFile, content: "hello from temp\n" },
  });

  assert.equal(written.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "hello from temp\n");
});

test("read can inspect a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-read");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "read from temp\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const read = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: tempFile },
  });

  assert.equal(read.isError, undefined);
  assert.match(allResponseText(read), /read from temp/);
});

test("edit can modify a file in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-edit");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "note.txt");
  await writeFile(tempFile, "before temp edit\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: tempFile,
      edits: [{ oldText: "before temp edit", newText: "after temp edit" }],
    },
  });

  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "after temp edit\n");
});

test("rename and delete are core tools in regular and codex modes", async (t) => {
  const regular = await fixture(t);
  const codex = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });

  for (const context of [regular, codex]) {
    const tools = await context.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("rename"));
    assert.ok(names.includes("delete"));
  }
});

test("rename and delete mutate workspace paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await writeFile(join(context.project, "before.txt"), "workspace mutation\n");

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: "before.txt", newPath: "after.txt" },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(join(context.project, "after.txt"), "utf8"), "workspace mutation\n");
  await assert.rejects(readFile(join(context.project, "before.txt"), "utf8"), /ENOENT/);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: "after.txt" },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(join(context.project, "after.txt"), "utf8"), /ENOENT/);
});

test("rename and delete mutate OS temp paths through the MCP surface", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-mutations");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const before = join(tempRoot, "before.txt");
  const after = join(tempRoot, "after.txt");
  await writeFile(before, "temp mutation\n");
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));

  const renamed = await context.client.callTool({
    name: "rename",
    arguments: { workspaceId, path: before, newPath: after },
  });
  assert.equal(renamed.isError, undefined);
  assert.equal(await readFile(after, "utf8"), "temp mutation\n");

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: after },
  });
  assert.equal(deleted.isError, undefined);
  await assert.rejects(readFile(after, "utf8"), /ENOENT/);
});

test("delete refuses the workspace root itself", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-delete-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const deleted = await context.client.callTool({
    name: "delete",
    arguments: { workspaceId, path: ".", recursive: true },
  });

  assert.equal(deleted.isError, true);
  assert.match(allResponseText(deleted), /allowed root itself/i);
  assert.equal(await readFile(join(context.project, "AGENTS.md"), "utf8") !== "", true);
});

test("ls can inspect the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-ls");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  await writeFile(join(tempRoot, "listed.txt"), "temp listing\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const listed = await context.client.callTool({
    name: "ls",
    arguments: { workspaceId, path: tempRoot },
  });

  assert.equal(listed.isError, undefined);
  assert.match(allResponseText(listed), /listed\.txt/);
});

test("grep can search the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-grep");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  await writeFile(join(tempRoot, "searched.txt"), "unique-temp-needle\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const searched = await context.client.callTool({
    name: "grep",
    arguments: { workspaceId, pattern: "unique-temp-needle", path: tempRoot },
  });

  assert.equal(searched.isError, undefined);
  assert.match(allResponseText(searched), /unique-temp-needle/);
});

test("glob can find files in the OS temp directory", async (t) => {
  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-glob");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  await writeFile(join(tempRoot, "matched-temp.txt"), "temp glob\n");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const found = await context.client.callTool({
    name: "glob",
    arguments: { workspaceId, pattern: "*.txt", path: tempRoot },
  });

  assert.equal(found.isError, undefined);
  assert.match(allResponseText(found), /matched-temp\.txt/);
});

test("codex apply_patch can create a file in the OS temp directory", async (t) => {
  const context = await fixture(t, { env: { DEVSPACE_TOOL_MODE: "codex" } });
  const opened = await callOpen(context.client, context.project, "chat-temp-apply-patch");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const tempFile = join(tempRoot, "patched-temp.txt");
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: `*** Begin Patch\n*** Add File: ${tempFile}\n+patched temp\n*** End Patch`,
    },
  });

  assert.equal(patched.isError, undefined);
  assert.equal(await readFile(tempFile, "utf8"), "patched temp\n");
});

test("temp file access rejects symlinks that escape the OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable outside-temp target on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-symlink");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  const escapedPath = join(tempRoot, "escaped-hosts");
  await symlink("/etc/hosts", escapedPath);
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const escaped = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: escapedPath },
  });

  assert.equal(escaped.isError, true);
  assert.match(allResponseText(escaped), /outside allowed roots/i);
});

test("grep does not follow symlinked files that escape the OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("File symlink creation requires extra privileges on some Windows setups.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-temp-grep-symlink");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const tempRoot = await mkdtemp(join(tmpdir(), "forgerelay-file-tool-test-"));
  await symlink(join(process.cwd(), "package.json"), join(tempRoot, "escaped-package.json"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const searched = await context.client.callTool({
    name: "grep",
    arguments: { workspaceId, pattern: "@akira-tl/forgerelay", path: tempRoot },
  });

  assert.equal(searched.isError, undefined);
  assert.doesNotMatch(allResponseText(searched), /@akira-tl\/forgerelay/);
});

test("file tools still reject arbitrary paths outside the workspace and OS temp directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("Uses /etc/hosts as a stable non-temp path on POSIX.");
    return;
  }

  const context = await fixture(t);
  const opened = await callOpen(context.client, context.project, "chat-outside-file-root");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const outside = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "/etc/hosts" },
  });

  assert.equal(outside.isError, true);
  assert.match(allResponseText(outside), /outside allowed roots/i);
});

test("open_workspace does not treat the OS temp directory as an implicit workspace root", async (t) => {
  const context = await fixture(t);

  const opened = await callOpen(context.client, tmpdir(), "chat-temp-workspace");

  assert.equal(opened.isError, true);
  assert.match(allResponseText(opened), /outside allowed roots/i);
});

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

test("bash returns a processId instead of killing a command after the foreground wait", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-background");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('background-done'), 100)"`,
    },
  });

  assert.equal(shell.isError, undefined, allResponseText(shell));
  assert.equal(structuredContent(shell).running, true);
  assert.equal(typeof structuredContent(shell).processId, "number");
  assert.equal(structuredContent(shell).sessionId, structuredContent(shell).processId);
  assert.match(allResponseText(shell), /Process running with process ID/);

  const read = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "AGENTS.md" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.match(allResponseText(read), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(read), /background-done/);

  const readAgain = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "AGENTS.md" },
  });
  assert.doesNotMatch(allResponseText(readAgain), /Background process/);
});

test("a failed workspace tool call still carries a completed background process notice", async (t) => {
  const processSessions = new ProcessManager({
    maxStartYieldMs: 20,
    completedProcessTtlMs: 2_000,
  });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-error-notice");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('notice-on-error'), 300)"`,
    },
  });
  assert.equal(structuredContent(shell).running, true);

  const failedRead = await waitForToolText(
    context.client,
    {
      name: "read",
      arguments: { workspaceId, path: "missing-background-notice.txt" },
    },
    /Background process \d+ exited with code 0/,
  );
  assert.equal(failedRead.isError, true);
  assert.match(allResponseText(failedRead), /Background process \d+ exited with code 0/);
  assert.match(allResponseText(failedRead), /notice-on-error/);
});

test("close_workspace refuses a logical workspace with a running process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-close-guard");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('close-guard-done'), 80)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const blockedClose = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(blockedClose.isError, true);
  assert.match(allResponseText(blockedClose), /running process or an unconsumed process completion/);

  await context.client.callTool({
    name: "write_stdin",
    // Deprecated sessionId remains accepted at the MCP boundary during 0.2.x.
    arguments: { workspaceId, sessionId: processId, yieldTimeMs: 5_000 },
  });
  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: { workspaceId },
  });
  assert.equal(closed.isError, undefined);
});

test("write_stdin can explicitly keep waiting for a bash process", async (t) => {
  const processSessions = new ProcessManager({ maxStartYieldMs: 10 });
  const context = await fixture(t, { processSessions });
  const opened = await callOpen(context.client, context.project, "chat-shell-poll");
  const workspaceId = String(structuredContent(opened).workspaceId);
  const node = JSON.stringify(process.execPath);
  const shell = await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: `${node} -e "setTimeout(() => console.log('polled-done'), 80)"`,
    },
  });
  const processId = Number(structuredContent(shell).processId);
  assert.ok(processId > 0);

  const polled = await context.client.callTool({
    name: "write_stdin",
    arguments: { workspaceId, processId, yieldTimeMs: 5_000 },
  });
  assert.equal(structuredContent(polled).running, false);
  assert.equal(structuredContent(polled).exitCode, 0);
  assert.match(allResponseText(polled), /polled-done/);
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

  assert.match(visible, /Hook results:/);
  assert.match(visible, /Write preflight.*passed/);
  assert.doesNotMatch(visible, /Silent write observer/);
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
});

test("close_worktree commits and fast-forwards a managed worktree through the MCP surface", async (t) => {
  const context = await fixture(t, { git: true });
  const opened = await callOpen(context.client, context.project, "chat-1", "worktree");
  const workspaceId = structuredContent(opened).workspaceId;
  assert.equal(typeof workspaceId, "string");
  const worktree = structuredContent(opened).worktree as Record<string, unknown>;
  assert.equal(worktree.detached, false);
  assert.match(String(worktree.branch), /^forgerelay\//);
  assert.equal(typeof worktree.targetBranch, "string");

  await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "feature.txt",
      content: "finished\n",
    },
  });
  const closed = await context.client.callTool({
    name: "close_worktree",
    arguments: {
      workspaceId,
      commitMessage: "feat: finish isolated work",
    },
  });
  const structured = structuredContent(closed);

  assert.equal(structured.workspaceId, workspaceId);
  assert.equal(structured.committed, true);
  assert.equal(structured.branch, worktree.branch);
  assert.equal(structured.targetBranch, worktree.targetBranch);
  assert.equal(
    (await readFile(join(context.project, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"),
    "finished\n",
  );
  assert.match(responseText(closed), /fast-forward/);
});

test("worktree lifecycle hook reports are visible on close_worktree", async (t) => {
  const context = await fixture(t, { git: true });
  await mkdir(join(context.project, ".forgerelay", "hooks"), { recursive: true });
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-verification.json"),
    JSON.stringify({
      event: "BeforeWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await writeFile(
    join(context.project, ".forgerelay", "hooks", "worktree-integrated.json"),
    JSON.stringify({
      event: "AfterWorktreeClose",
      command: "node -e \"process.exit(0)\"",
    }),
  );
  await git(context.project, ["add", ".forgerelay/hooks"]);
  await git(context.project, ["commit", "-m", "Add project hooks"]);

  const opened = await callOpen(context.client, context.project, "chat-hook-close-report", "worktree");
  const workspaceId = String(structuredContent(opened).workspaceId);
  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "feature.txt", content: "hook report\n" },
  });
  const closed = await context.client.callTool({
    name: "close_worktree",
    arguments: { workspaceId, commitMessage: "test: close with hook reports" },
  });
  const visible = allResponseText(closed);

  assert.match(visible, /worktree-verification \(BeforeWorktreeClose, project\) passed/);
  assert.match(visible, /worktree-integrated \(AfterWorktreeClose, project\) passed/);
});

test("checkout opened after a worktree receives its own complete context", async (t) => {
  const context = await fixture(t, { git: true });
  const worktree = await callOpen(context.client, context.project, "chat-1", "worktree");
  const checkout = await callOpen(context.client, context.project, "chat-1");
  const checkoutAgain = await callOpen(context.client, context.project, "chat-1");

  assert.equal(structuredContent(worktree).mode, "worktree");
  assert.ok(Array.isArray(structuredContent(worktree).agentsFiles));
  assert.equal(structuredContent(checkout).mode, "checkout");
  assert.ok(Array.isArray(structuredContent(checkout).agentsFiles));
  assert.equal(structuredContent(checkoutAgain).workspaceId, structuredContent(checkout).workspaceId);
  assert.equal(structuredContent(checkoutAgain).agentsFiles, undefined);
  assert.match(responseText(checkoutAgain), /same directory previously opened/);
});

test("a host without conversation metadata reuses the directory workspace and still receives full context", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project);
  const second = await callOpen(context.client, context.project);

  assert.equal(structuredContent(first).workspaceId, structuredContent(second).workspaceId);
  assert.ok(Array.isArray(structuredContent(first).agentsFiles));
  assert.ok(Array.isArray(structuredContent(second).agentsFiles));
  assert.match(responseText(second), /complete project context is included/i);
  assert.doesNotMatch(responseText(first), /conversation metadata/i);
  assert.doesNotMatch(responseText(second), /conversation metadata/i);
});

test("checkout reuse and context suppression survive a registry restart", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const firstWorkspaceId = structuredContent(first).workspaceId;

  await context.close();

  const restoredStore = new SqliteWorkspaceStore(context.stateDir);
  const restoredServer = createMcpServer(
    context.config,
    new WorkspaceRegistry(context.config, restoredStore),
    createReviewCheckpointManager(),
    new ProcessManager(),
    [],
    [],
  );
  const [restoredClientTransport, restoredServerTransport] = InMemoryTransport.createLinkedPair();
  const restoredClient = new Client({ name: "devspace-restored-test-client", version: "1.0.0" });
  let restoredClosed = false;
  const closeRestored = async () => {
    if (restoredClosed) return;
    restoredClosed = true;
    await restoredClient.close();
    await restoredServer.close();
    restoredStore.close();
  };
  t.after(closeRestored);

  try {
    await Promise.all([
      restoredClient.connect(restoredClientTransport),
      restoredServer.connect(restoredServerTransport),
    ]);

    const restored = await callOpen(restoredClient, context.project, "chat-1");
    assert.equal(structuredContent(restored).workspaceId, firstWorkspaceId);
    assert.equal(structuredContent(restored).agentsFiles, undefined);
    assert.match(responseText(restored), /same directory previously opened/);
  } finally {
    await closeRestored();
  }
});

interface ServerFixture {
  client: Client;
  project: string;
  config: ServerConfig;
  stateDir: string;
  processSessions: ProcessManager;
  close: () => Promise<void>;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    env?: NodeJS.ProcessEnv;
    hooks?: HookConfigInput;
    processSessions?: ProcessManager;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const loadedConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, ".config"),
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_WIDGETS: "full",
    DEVSPACE_TOOL_MODE: "full",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
    ...options.env,
  });
  const config: ServerConfig = options.hooks
    ? { ...loadedConfig, hooks: parseHookConfig(options.hooks) }
    : loadedConfig;
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const processSessions = options.processSessions ?? new ProcessManager();
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    processSessions,
    [],
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    processSessions.shutdown();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project, config, stateDir, processSessions, close };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
  mode?: "checkout" | "worktree",
  newWorktree?: boolean,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: {
      path,
      ...(mode ? { mode } : {}),
      ...(newWorktree ? { newWorktree: true } : {}),
    },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first?.text, "string");
  return first?.text as string;
}

function allResponseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}

async function waitForToolText(
  client: Client,
  params: Parameters<Client["callTool"]>[0],
  expected: RegExp,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const deadline = Date.now() + timeoutMs;
  let result = await client.callTool(params);
  while (!expected.test(allResponseText(result)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await client.callTool(params);
  }
  return result;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
