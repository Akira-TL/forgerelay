import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugMcpUrl } from "./runtime.mjs";
import {
  assertCodeIntelligenceShutdown as assertCodeIntelligenceAcceptanceShutdown,
  exerciseCodeIntelligence as exerciseCodeIntelligenceAcceptance,
} from "./code-intelligence-accept.mjs";
import { createAcceptanceHarness } from "./accept/harness.mjs";
import { runBootstrapAcceptance } from "./accept/bootstrap.mjs";
import {
  callTool,
  curlRequest,
  exerciseReleaseTagHooks,
  exerciseSubagentHooks,
  mcpHeaders,
  pass,
  readHookEntries,
  setupGitProject,
  stopServer,
  toolText,
} from "./accept/support.mjs";

const {
  packageJson,
  acceptanceRoot,
  stateDir,
  hookLog,
  checkoutWorkspace,
  lifecycleDeleteWorkspace,
  codeIntelligenceLog,
  gitProject,
  releaseProject,
  releaseRemote,
  ownerToken,
  tempAcceptanceRoot,
  env,
  server,
} = await createAcceptanceHarness();
let acceptanceCompleted = false;

try {
  const {
    oauth,
    sessionId,
    workspaceConversationMeta,
    opened,
    workspaceId,
    capabilityCatalog,
    checkoutListId,
    checkoutTaskId,
  } = await runBootstrapAcceptance({ server, packageJson, ownerToken, checkoutWorkspace, stateDir });

  const repeatedOpen = callTool(oauth.accessToken, sessionId, 84, "open_workspace", {
    path: checkoutWorkspace,
    newWorkspace: true,
  }, workspaceConversationMeta);
  assert.equal(repeatedOpen.structuredContent.workspaceId, workspaceId);
  assert.equal(repeatedOpen.structuredContent.action, "open");
  assert.equal(
    repeatedOpen.structuredContent.contextFingerprint,
    opened.structuredContent.contextFingerprint,
  );
  assert.equal(repeatedOpen.structuredContent.agentsFiles, undefined);
  assert.equal(repeatedOpen.structuredContent.capabilityGuides, undefined);

  const workspaceInventory = callTool(oauth.accessToken, sessionId, 85, "open_workspace", {
    action: "list",
    root: checkoutWorkspace,
  }, workspaceConversationMeta);
  assert.equal(workspaceInventory.structuredContent.action, "list");
  assert.equal(workspaceInventory.structuredContent.summary.matching, 1);
  const inventoryEntries = workspaceInventory.structuredContent.workspaces;
  assert.equal(inventoryEntries.length, 1);
  assert.equal(inventoryEntries[0].workspaceId, workspaceId);
  assert.equal(inventoryEntries[0].current, true);

  const closedWorkspace = callTool(oauth.accessToken, sessionId, 86, "close_workspace", {
    workspaceId,
  });
  assert.equal(closedWorkspace.isError, undefined);
  assert.equal(closedWorkspace.structuredContent.workspaceId, workspaceId);
  assert.equal(closedWorkspace.structuredContent.action, "close");
  const closedCheckoutTasks = callTool(oauth.accessToken, sessionId, 133, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get" },
  });
  assert.equal(closedCheckoutTasks.isError, true);

  const closedInventory = callTool(oauth.accessToken, sessionId, 87, "open_workspace", {
    action: "list",
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(closedInventory.structuredContent.workspaces.length, 1);
  assert.equal(closedInventory.structuredContent.workspaces[0].state, "closed");
  assert.equal(closedInventory.structuredContent.workspaces[0].current, false);

  const closedRead = callTool(oauth.accessToken, sessionId, 89, "read", {
    workspaceId,
    path: "AGENTS.md",
  });
  assert.equal(closedRead.isError, true);

  const resumedOriginal = callTool(oauth.accessToken, sessionId, 90, "open_workspace", {
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(resumedOriginal.structuredContent.workspaceId, workspaceId);
  assert.equal(resumedOriginal.structuredContent.agentsFiles, undefined);
  assert.equal(
    resumedOriginal.structuredContent.contextFingerprint,
    opened.structuredContent.contextFingerprint,
  );
  const resumedCheckoutTasks = callTool(oauth.accessToken, sessionId, 134, "capability", {
    workspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "get",
      level: "detail",
      listId: checkoutListId,
      taskId: checkoutTaskId,
    },
  });
  assert.equal(resumedCheckoutTasks.isError, undefined);
  assert.equal(resumedCheckoutTasks.structuredContent.result.task.id, checkoutTaskId);
  assert.equal(resumedCheckoutTasks.structuredContent.result.task.content, "reloaded external task edit");
  assert.equal(resumedOriginal.structuredContent.contextFingerprint, opened.structuredContent.contextFingerprint);

  const deleteOpened = callTool(oauth.accessToken, sessionId, 91, "open_workspace", {
    path: lifecycleDeleteWorkspace,
    context: "none",
  }, { "openai/session": "acceptance-workspace-delete" });
  const deleteWorkspaceId = deleteOpened.structuredContent.workspaceId;
  const deleteTaskStatePath = join(stateDir, "workspaces", deleteWorkspaceId, "tasks.json");
  const deleteTaskList = callTool(oauth.accessToken, sessionId, 135, "capability", {
    workspaceId: deleteWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "delete with workspace" },
  });
  assert.equal(deleteTaskList.isError, undefined);
  const deleteTaskListId = deleteTaskList.structuredContent.result.lists[0].id;
  const inspectionTask = callTool(oauth.accessToken, sessionId, 190, "capability", {
    workspaceId: deleteWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: deleteTaskListId,
      subject: "Inspect safely",
      content: "INSPECTION_ACCEPTANCE_TASK_BODY_SECRET",
      status: "in_progress",
    },
  });
  assert.equal(inspectionTask.isError, undefined);
  assert.ok(existsSync(deleteTaskStatePath));

  const inspectionBefore = callTool(oauth.accessToken, sessionId, 191, "open_workspace", {
    action: "list",
    workspaceId: deleteWorkspaceId,
  }, workspaceConversationMeta);
  const inspectionBeforeEntry = inspectionBefore.structuredContent.workspaces[0];
  assert.equal(inspectionBeforeEntry.current, false);
  const inspectedWorkspace = callTool(oauth.accessToken, sessionId, 192, "open_workspace", {
    action: "inspect",
    workspaceId: deleteWorkspaceId,
  }, workspaceConversationMeta);
  assert.equal(inspectedWorkspace.structuredContent.action, "inspect");
  const inspectionProjection = inspectedWorkspace.structuredContent.inspection;
  assert.equal(inspectionProjection.workspaceId, deleteWorkspaceId);
  assert.equal(inspectionProjection.kind, "workspace");
  assert.equal(inspectionProjection.location, "local");
  assert.equal(inspectionProjection.root, lifecycleDeleteWorkspace);
  assert.equal(inspectionProjection.taskSummary.level, "summary");
  assert.equal(inspectionProjection.taskSummary.lists[0].taskCount, 1);
  assert.equal(inspectionProjection.taskSummary.lists[0].unfinishedTaskCount, 1);
  const inspectionJson = JSON.stringify(inspectedWorkspace);
  for (const forbidden of [
    "INSPECTION_ACCEPTANCE_BOOTSTRAP_SECRET",
    "INSPECTION_ACCEPTANCE_TASK_BODY_SECRET",
    "\"fingerprint\"",
    "\"agentsFiles\"",
    "\"availableAgentsFiles\"",
    "\"capabilityGuides\"",
    "\"skillDiagnostics\"",
    "\"agentProviders\"",
    "\"contextFingerprint\"",
    "\"capabilityFingerprint\"",
    "\"memberContext\"",
  ]) {
    assert.equal(inspectionJson.includes(forbidden), false, `Workspace inspect leaked ${forbidden}`);
  }
  const inspectionAfter = callTool(oauth.accessToken, sessionId, 193, "open_workspace", {
    action: "list",
    workspaceId: deleteWorkspaceId,
  }, workspaceConversationMeta);
  assert.equal(inspectionAfter.structuredContent.workspaces[0].lastUsedAt, inspectionBeforeEntry.lastUsedAt);
  assert.equal(inspectionAfter.structuredContent.workspaces[0].current, false);
  const callerAfterInspection = callTool(oauth.accessToken, sessionId, 194, "open_workspace", {
    workspaceId,
    context: "auto",
  }, workspaceConversationMeta);
  assert.equal(callerAfterInspection.structuredContent.workspaceId, workspaceId);
  assert.equal(callerAfterInspection.structuredContent.agentsFiles, undefined);
  assert.equal(callerAfterInspection.structuredContent.capabilityGuides, undefined);
  pass("Workspace inspection", "cross-Workspace metadata + Task summary stayed read-only and bootstrap-free");

  const deleteClosed = callTool(oauth.accessToken, sessionId, 92, "close_workspace", {
    workspaceId: deleteWorkspaceId,
  });
  assert.equal(deleteClosed.structuredContent.action, "close");
  const deletedWorkspace = callTool(oauth.accessToken, sessionId, 93, "close_workspace", {
    workspaceId: deleteWorkspaceId,
    action: "delete",
  });
  assert.equal(deletedWorkspace.isError, undefined);
  assert.equal(deletedWorkspace.structuredContent.workspaceId, deleteWorkspaceId);
  assert.equal(deletedWorkspace.structuredContent.action, "delete");
  assert.equal(existsSync(deleteTaskStatePath), false);
  assert.equal(readFileSync(join(lifecycleDeleteWorkspace, "keep.txt"), "utf8"), "keep checkout files\n");
  const deletedInventory = callTool(oauth.accessToken, sessionId, 94, "open_workspace", {
    action: "list",
    workspaceId: deleteWorkspaceId,
  });
  assert.equal(deletedInventory.structuredContent.workspaces.length, 0);
  pass(
    "workspace tasks",
    `${workspaceId} create -> external reload -> close/reopen; explicit delete removed ${deleteWorkspaceId} Task state`,
  );

  pass(
    "workspace lifecycle + inventory",
    `${workspaceId} canonical reuse -> close -> list -> reopen; explicit delete preserves checkout files`,
  );

  const directCapability = callTool(oauth.accessToken, sessionId, 79, "capability", {
    workspaceId,
    name: "hooks.check",
    action: "run",
    arguments: {},
  });
  assert.equal(directCapability.isError, undefined);
  assert.equal(directCapability.structuredContent.result.ok, true);
  const describedCapability = callTool(oauth.accessToken, sessionId, 80, "capability", {
    workspaceId,
    name: "hooks.check",
    action: "describe",
  });
  assert.equal(describedCapability.isError, undefined);
  assert.equal(describedCapability.structuredContent.capability.guide.name, "lifecycle-hooks");
  assert.equal(describedCapability.structuredContent.capability.inputSchema.type, "object");
  const describedCodeIntelligence = callTool(oauth.accessToken, sessionId, 88, "capability", {
    workspaceId,
    name: "code.intelligence",
    action: "describe",
  });
  assert.equal(describedCodeIntelligence.isError, undefined);
  assert.equal(describedCodeIntelligence.structuredContent.capability.guide.name, "code-intelligence");
  const codeIntelligenceSchema = describedCodeIntelligence.structuredContent.capability.inputSchema;
  assert.ok(Array.isArray(codeIntelligenceSchema.oneOf));
  assert.deepEqual(
    codeIntelligenceSchema.oneOf.map((variant) => variant.properties.operation.const),
    ["definition", "hover", "references", "documentSymbols", "workspaceSymbols", "diagnostics"],
  );
  for (const operation of ["references", "documentSymbols", "workspaceSymbols", "diagnostics"]) {
    const boundedSchema = codeIntelligenceSchema.oneOf.find(
      (variant) => variant.properties.operation.const === operation,
    );
    assert.equal(boundedSchema.properties.limit.minimum, 1);
    assert.equal(boundedSchema.properties.limit.maximum, 1000);
  }
  const workspaceSymbolsSchema = codeIntelligenceSchema.oneOf.find(
    (variant) => variant.properties.operation.const === "workspaceSymbols",
  );
  assert.ok(workspaceSymbolsSchema.required.includes("query"));
  exerciseCodeIntelligenceAcceptance({
    callTool,
    accessToken: oauth.accessToken,
    sessionId,
    workspaceId,
    pass,
  });
  if (process.platform === "linux") {
    const describedArtifact = callTool(oauth.accessToken, sessionId, 82, "capability", {
      workspaceId,
      name: "artifact.download",
      action: "describe",
    });
    assert.equal(describedArtifact.isError, undefined);
    assert.deepEqual(describedArtifact.structuredContent.capability.transport, {
      nativeFileArgument: "file",
      gatewayParameter: "file",
    });
  }
  const unknownCapability = callTool(oauth.accessToken, sessionId, 81, "capability", {
    workspaceId,
    name: "unknown.capability",
    action: "run",
    arguments: {},
  });
  assert.equal(unknownCapability.isError, true);
  assert.equal(unknownCapability.structuredContent.error.code, "unknown_capability");
  const capabilityGuides = opened.structuredContent.capabilityGuides;
  assert.deepEqual(capabilityGuides.map((guide) => guide.name), [
    "lifecycle-hooks",
    "managed-worktrees",
    "artifacts-review",
    "host-integration",
    "shell-processes",
    "code-intelligence",
    "workspace-tasks",
    "batch-execution",
  ]);
  const hooksGuide = callTool(oauth.accessToken, sessionId, 78, "read", {
    workspaceId,
    path: capabilityGuides[0].path,
  });
  assert.match(hooksGuide.structuredContent.result, /BeforeTool/);
  assert.match(hooksGuide.structuredContent.result, /BeforeWorktreeClose/);
  pass("open_workspace", `${workspaceId} -> ${capabilityCatalog.length} capabilities + ${capabilityGuides.length} capability guides`);

  const unifiedPanel = callTool(oauth.accessToken, sessionId, 89, "activity_panel", {
    workspaceId,
  }, workspaceConversationMeta);
  assert.equal(unifiedPanel.isError, undefined);
  assert.equal(
    unifiedPanel._meta?.["forgerelay/activityPanelWorkspace"]?.workspaceId,
    workspaceId,
  );
  assert.equal(
    unifiedPanel._meta?.["forgerelay/activityPanelWorkspace"]?.root,
    checkoutWorkspace,
  );
  pass("unified ForgeRelay Panel", `${workspaceId} -> Workspace + Activity`);

  const inspectorActivityPath = join(checkoutWorkspace, "inspector-activity.txt");
  writeFileSync(inspectorActivityPath, "inspector transport-scoped activity\n");
  try {
    const inspectorPanel = callTool(oauth.accessToken, sessionId, 90, "activity_panel", {
      workspaceId,
    });
    const inspectorTurnId = inspectorPanel.structuredContent.turnId;
    const inspectorRead = callTool(oauth.accessToken, sessionId, 91, "read", {
      workspaceId,
      path: "inspector-activity.txt",
      offset: 1,
      limit: 2,
    });
    assert.equal(inspectorRead.isError, undefined);
    const inspectorSnapshot = callTool(oauth.accessToken, sessionId, 92, "activity_snapshot", {
      turnId: inspectorTurnId,
    });
    assert.equal(inspectorSnapshot.isError, undefined);
    assert.ok(inspectorSnapshot.structuredContent.revision > 0);
    assert.equal(inspectorSnapshot.structuredContent.activities, undefined);
    const inspectorIndex = callTool(oauth.accessToken, sessionId, 93, "activity_index", {
      turnId: inspectorTurnId,
    });
    assert.equal(inspectorIndex.isError, undefined);
    assert.deepEqual(
      inspectorIndex.structuredContent.activities.map(({ tool, workspaceId: activityWorkspaceId, target }) => ({
        tool,
        workspaceId: activityWorkspaceId,
        target,
      })),
      [{ tool: "read", workspaceId, target: "inspector-activity.txt" }],
    );
    pass("Inspector-style Activity scope", `${sessionId} -> ${inspectorTurnId} -> read captured`);
  } finally {
    rmSync(inspectorActivityPath, { force: true });
  }

  const written = callTool(oauth.accessToken, sessionId, 4, "write", {
    workspaceId,
    path: "acceptance.txt",
    content: "forgerelay 7677 acceptance\n",
  });
  assert.equal(written.isError, undefined);

  const read = callTool(oauth.accessToken, sessionId, 5, "read", {
    workspaceId,
    path: "acceptance.txt",
  });
  assert.match(read.structuredContent.result, /forgerelay 7677 acceptance/);
  pass("write + read", JSON.stringify(read.structuredContent));

  const reviewed = callTool(oauth.accessToken, sessionId, 83, "capability", {
    workspaceId,
    name: "review.changes",
    action: "run",
    arguments: {},
  });
  assert.equal(reviewed.isError, undefined);
  assert.match(reviewed.structuredContent.result.result, /Changed 1 file/);
  assert.equal(reviewed._meta?.tool, "capability");
  assert.equal(reviewed._meta?.card?.capabilityName, "review.changes");
  assert.match(reviewed._meta?.card?.payload?.patch ?? "", /acceptance\.txt/);
  pass("review.changes", "Capability Gateway produced the aggregate review card");

  const shell = callTool(oauth.accessToken, sessionId, 6, "bash", {
    workspaceId,
    command: "printf debug-bash-ok",
  });
  assert.match(shell.structuredContent.result, /debug-bash-ok/);
  assert.equal(shell.structuredContent.running, false);
  pass("bash", "foreground command completed through ProcessManager");

  const background = callTool(oauth.accessToken, sessionId, 61, "bash", {
    workspaceId,
    action: "run",
    command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('debug-process-ok'), 100)"`,
    yieldTimeMs: 0,
  });
  assert.equal(background.structuredContent.running, true);
  assert.equal(typeof background.structuredContent.processId, "number");
  const polled = callTool(oauth.accessToken, sessionId, 62, "bash", {
    workspaceId,
    action: "process",
    processId: background.structuredContent.processId,
    yieldTimeMs: 5_000,
  });
  assert.equal(polled.structuredContent.running, false);
  assert.equal(polled.structuredContent.exitCode, 0);
  assert.match(polled.structuredContent.result, /debug-process-ok/);
  pass("bash process", "action=run -> processId -> action=process completed through one MCP tool");

  const failedEdit = callTool(oauth.accessToken, sessionId, 7, "edit", {
    workspaceId,
    path: "acceptance.txt",
    edits: [{ oldText: "text that is not present", newText: "unused" }],
  });
  assert.equal(failedEdit.isError, true);
  pass("failed tool path", "edit returned isError=true and triggered AfterToolFailure");

  const renamedWorkspaceFile = callTool(oauth.accessToken, sessionId, 74, "rename", {
    workspaceId,
    path: "acceptance.txt",
    newPath: "renamed-acceptance.txt",
  });
  assert.equal(renamedWorkspaceFile.isError, undefined);
  assert.equal(readFileSync(join(checkoutWorkspace, "renamed-acceptance.txt"), "utf8"), "forgerelay 7677 acceptance\n");
  const deletedWorkspaceFile = callTool(oauth.accessToken, sessionId, 75, "delete", {
    workspaceId,
    path: "renamed-acceptance.txt",
  });
  assert.equal(deletedWorkspaceFile.isError, undefined);
  assert.equal(existsSync(join(checkoutWorkspace, "renamed-acceptance.txt")), false);
  pass("rename + delete", "workspace file renamed and deleted through MCP");

  mkdirSync(tempAcceptanceRoot, { recursive: true });
  const tempFile = join(tempAcceptanceRoot, "mcp-temp.txt");
  const tempWritten = callTool(oauth.accessToken, sessionId, 70, "write", {
    workspaceId,
    path: tempFile,
    content: "forgerelay temp before edit\n",
  });
  assert.equal(tempWritten.isError, undefined);

  const tempRead = callTool(oauth.accessToken, sessionId, 71, "read", {
    workspaceId,
    path: tempFile,
  });
  assert.match(tempRead.structuredContent.result, /forgerelay temp before edit/);

  const tempEdited = callTool(oauth.accessToken, sessionId, 72, "edit", {
    workspaceId,
    path: tempFile,
    edits: [{ oldText: "before edit", newText: "after edit" }],
  });
  assert.equal(tempEdited.isError, undefined);
  assert.equal(readFileSync(tempFile, "utf8"), "forgerelay temp after edit\n");

  const renamedTempFile = join(tempAcceptanceRoot, "mcp-temp-renamed.txt");
  const tempRenamed = callTool(oauth.accessToken, sessionId, 76, "rename", {
    workspaceId,
    path: tempFile,
    newPath: renamedTempFile,
  });
  assert.equal(tempRenamed.isError, undefined);
  assert.equal(readFileSync(renamedTempFile, "utf8"), "forgerelay temp after edit\n");
  const tempDeleted = callTool(oauth.accessToken, sessionId, 77, "delete", {
    workspaceId,
    path: renamedTempFile,
  });
  assert.equal(tempDeleted.isError, undefined);
  assert.equal(existsSync(renamedTempFile), false);

  const outsideRoots = callTool(oauth.accessToken, sessionId, 73, "read", {
    workspaceId,
    path: join(homedir(), "forgerelay-debug-outside-roots.txt"),
  });
  assert.equal(outsideRoots.isError, true);
  assert.match(toolText(outsideRoots), /outside allowed roots/i);
  pass("OS temp file tools", "write + read + edit + rename + delete passed; arbitrary home path rejected");

  setupGitProject(gitProject);
  const worktreeOpened = callTool(oauth.accessToken, sessionId, 8, "open_workspace", {
    path: gitProject,
    mode: "worktree",
  });
  const worktreeWorkspaceId = worktreeOpened.structuredContent.workspaceId;
  const managedWorktreePath = worktreeOpened.structuredContent.worktree.path;
  assert.equal(worktreeOpened.structuredContent.mode, "worktree");
  assert.ok(existsSync(managedWorktreePath));

  callTool(oauth.accessToken, sessionId, 9, "write", {
    workspaceId: worktreeWorkspaceId,
    path: "feature.txt",
    content: "debug worktree acceptance\n",
  });
  const closed = callTool(oauth.accessToken, sessionId, 10, "close_workspace", {
    workspaceId: worktreeWorkspaceId,
    commitMessage: "test(debug): verify 7677 worktree lifecycle",
  });
  assert.equal(closed.structuredContent.committed, true);
  assert.equal(existsSync(managedWorktreePath), false);
  assert.equal(
    readFileSync(join(gitProject, "feature.txt"), "utf8").replace(/\r\n/g, "\n"),
    "debug worktree acceptance\n",
  );
  const closedWorktreeInventory = callTool(oauth.accessToken, sessionId, 110, "open_workspace", {
    action: "list",
    workspaceId: worktreeWorkspaceId,
  });
  assert.equal(closedWorktreeInventory.structuredContent.workspaces.length, 1);
  assert.equal(closedWorktreeInventory.structuredContent.workspaces[0].state, "closed");
  const closedWorktreeInspection = callTool(oauth.accessToken, sessionId, 195, "open_workspace", {
    action: "inspect",
    workspaceId: worktreeWorkspaceId,
  });
  const closedWorktreeProjection = closedWorktreeInspection.structuredContent.inspection;
  assert.equal(closedWorktreeProjection.kind, "workspace");
  assert.equal(closedWorktreeProjection.mode, "worktree");
  assert.equal(closedWorktreeProjection.managed, true);
  assert.equal(closedWorktreeProjection.state, "closed");
  assert.equal(closedWorktreeProjection.rootValid, false);
  assert.equal(existsSync(managedWorktreePath), false);
  assert.equal(JSON.stringify(closedWorktreeInspection).includes("\"fingerprint\""), false);

  const reopenedWorktree = callTool(oauth.accessToken, sessionId, 111, "open_workspace", {
    workspaceId: worktreeWorkspaceId,
    context: "none",
  });
  assert.equal(reopenedWorktree.structuredContent.workspaceId, worktreeWorkspaceId);
  const reopenedWorktreePath = reopenedWorktree.structuredContent.worktree.path;
  assert.notEqual(reopenedWorktreePath, managedWorktreePath);
  assert.ok(existsSync(reopenedWorktreePath));

  callTool(oauth.accessToken, sessionId, 112, "write", {
    workspaceId: worktreeWorkspaceId,
    path: "delete-feature.txt",
    content: "debug worktree delete acceptance\n",
  });
  const deletedWorktree = callTool(oauth.accessToken, sessionId, 113, "close_workspace", {
    workspaceId: worktreeWorkspaceId,
    action: "delete",
    commitMessage: "test(debug): verify 7677 worktree delete lifecycle",
  });
  assert.equal(deletedWorktree.structuredContent.action, "delete");
  assert.equal(existsSync(reopenedWorktreePath), false);
  assert.equal(
    readFileSync(join(gitProject, "delete-feature.txt"), "utf8").replace(/\r\n/g, "\n"),
    "debug worktree delete acceptance\n",
  );
  const deletedWorktreeInventory = callTool(oauth.accessToken, sessionId, 114, "open_workspace", {
    action: "list",
    workspaceId: worktreeWorkspaceId,
  });
  assert.equal(deletedWorktreeInventory.structuredContent.workspaces.length, 0);
  pass(
    "managed worktree lifecycle",
    `${worktreeWorkspaceId} close -> closed inventory -> same-id reopen with fresh backing -> safe delete`,
  );

  callTool(oauth.accessToken, sessionId, 115, "write", {
    workspaceId,
    path: "composite-sentinel.txt",
    content: "debug composite member acceptance\n",
  });
  const compositeOpened = callTool(oauth.accessToken, sessionId, 116, "open_workspace", {
    kind: "composite",
    name: "debug-lifecycle-composite",
    context: "none",
  });
  const compositeWorkspaceId = compositeOpened.structuredContent.workspaceId;
  assert.deepEqual(
    compositeOpened.structuredContent.capabilityCatalog.map((entry) => entry.name),
    ["workspace.tasks"],
  );
  const compositeTaskStatePath = join(stateDir, "workspaces", compositeWorkspaceId, "tasks.json");
  assert.ok(existsSync(compositeTaskStatePath));
  const compositeTaskList = callTool(oauth.accessToken, sessionId, 136, "capability", {
    workspaceId: compositeWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "list.create", name: "Composite release tasks" },
  });
  assert.equal(compositeTaskList.isError, undefined);
  const compositeTaskListId = compositeTaskList.structuredContent.result.lists[0].id;
  const compositeTask = callTool(oauth.accessToken, sessionId, 137, "capability", {
    workspaceId: compositeWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "task.create",
      listId: compositeTaskListId,
      subject: "Preserve Composite Task state",
      content: "Composite-owned state",
    },
  });
  assert.equal(compositeTask.isError, undefined);
  const compositeTaskId = compositeTask.structuredContent.result.lists[0].tasks[0].id;
  callTool(oauth.accessToken, sessionId, 117, "open_workspace", {
    action: "member",
    workspaceId: compositeWorkspaceId,
    memberAction: "add",
    member: {
      name: "code",
      purpose: "Debug lifecycle member",
      workspaceId,
    },
  });
  const memberScopedCompositeTasks = callTool(oauth.accessToken, sessionId, 138, "capability", {
    workspaceId: compositeWorkspaceId,
    member: "code",
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get" },
  });
  assert.equal(memberScopedCompositeTasks.isError, true);
  const closedComposite = callTool(oauth.accessToken, sessionId, 118, "close_workspace", {
    workspaceId: compositeWorkspaceId,
  });
  assert.equal(closedComposite.structuredContent.action, "close");
  assert.equal(closedComposite.structuredContent.status, "closed");
  assert.equal(closedComposite.structuredContent.dissolved, false);
  const closedCompositeInventory = callTool(oauth.accessToken, sessionId, 119, "open_workspace", {
    action: "list",
    kind: "composite",
    workspaceId: compositeWorkspaceId,
    status: "closed",
  });
  assert.equal(closedCompositeInventory.structuredContent.compositeWorkspaces.length, 1);
  assert.equal(closedCompositeInventory.structuredContent.compositeWorkspaces[0].state, "closed");
  const closedCompositeRead = callTool(oauth.accessToken, sessionId, 120, "read", {
    workspaceId: compositeWorkspaceId,
    member: "code",
    path: "composite-sentinel.txt",
  });
  assert.equal(closedCompositeRead.isError, true);
  const closedCompositeTasks = callTool(oauth.accessToken, sessionId, 139, "capability", {
    workspaceId: compositeWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: { operation: "get" },
  });
  assert.equal(closedCompositeTasks.isError, true);
  const closedCompositeInspection = callTool(oauth.accessToken, sessionId, 196, "open_workspace", {
    action: "inspect",
    workspaceId: compositeWorkspaceId,
  });
  const closedCompositeProjection = closedCompositeInspection.structuredContent.inspection;
  assert.equal(closedCompositeProjection.kind, "composite");
  assert.equal(closedCompositeProjection.state, "closed");
  assert.equal(closedCompositeProjection.members[0].workspaceId, workspaceId);
  assert.equal(closedCompositeProjection.members[0].known, true);
  assert.equal(closedCompositeProjection.taskSummary.lists[0].taskCount, 1);
  assert.equal(
    JSON.stringify(closedCompositeInspection).includes("Composite-owned state"),
    false,
  );

  const reopenedComposite = callTool(oauth.accessToken, sessionId, 121, "open_workspace", {
    workspaceId: compositeWorkspaceId,
    context: "none",
  });
  assert.equal(reopenedComposite.structuredContent.workspaceId, compositeWorkspaceId);
  assert.equal(reopenedComposite.structuredContent.status, "active");
  assert.equal(reopenedComposite.structuredContent.members[0].workspaceId, workspaceId);
  const reopenedCompositeTasks = callTool(oauth.accessToken, sessionId, 140, "capability", {
    workspaceId: compositeWorkspaceId,
    name: "workspace.tasks",
    action: "run",
    arguments: {
      operation: "get",
      level: "detail",
      listId: compositeTaskListId,
      taskId: compositeTaskId,
    },
  });
  assert.equal(reopenedCompositeTasks.isError, undefined);
  assert.equal(reopenedCompositeTasks.structuredContent.result.task.id, compositeTaskId);
  assert.equal(reopenedCompositeTasks.structuredContent.result.task.content, "Composite-owned state");
  const reopenedCompositeRead = callTool(oauth.accessToken, sessionId, 122, "read", {
    workspaceId: compositeWorkspaceId,
    member: "code",
    path: "composite-sentinel.txt",
  });
  assert.match(reopenedCompositeRead.structuredContent.result, /debug composite member acceptance/);

  const deletedComposite = callTool(oauth.accessToken, sessionId, 123, "close_workspace", {
    workspaceId: compositeWorkspaceId,
    action: "delete",
  });
  assert.equal(deletedComposite.structuredContent.action, "delete");
  assert.equal(deletedComposite.structuredContent.dissolved, true);
  assert.equal(existsSync(compositeTaskStatePath), false);
  const memberAfterCompositeDelete = callTool(oauth.accessToken, sessionId, 124, "read", {
    workspaceId,
    path: "composite-sentinel.txt",
  });
  assert.match(memberAfterCompositeDelete.structuredContent.result, /debug composite member acceptance/);
  const deletedCompositeInventory = callTool(oauth.accessToken, sessionId, 125, "open_workspace", {
    action: "list",
    kind: "composite",
    workspaceId: compositeWorkspaceId,
  });
  assert.equal(deletedCompositeInventory.structuredContent.compositeWorkspaces.length, 0);
  pass(
    "Composite workspace tasks",
    `${compositeWorkspaceId} self-owned Task state -> close/reopen -> delete cleanup; member-scoped Task access rejected`,
  );
  pass(
    "Composite lifecycle",
    `${compositeWorkspaceId} close -> closed/non-routable -> same-id reopen -> delete; member Workspace preserved`,
  );

  exerciseReleaseTagHooks(oauth.accessToken, sessionId, { acceptanceRoot, releaseProject, releaseRemote });
  exerciseSubagentHooks(env, stateDir, workspaceId, checkoutWorkspace, acceptanceRoot);

  const hookEntries = readHookEntries(hookLog);
  const hookEvents = hookEntries.map((entry) => entry.event);
  for (const expected of [
    "WorkspaceOpen",
    "BeforeTool",
    "AfterTool",
    "AfterToolFailure",
    "AfterFileChange",
    "BeforeWorktreeClose",
    "AfterWorktreeClose",
    "SubagentStart",
    "SubagentStop",
  ]) {
    assert.ok(hookEvents.includes(expected), `debug hook log did not contain ${expected}`);
  }
  assert.ok(
    hookEvents.indexOf("BeforeWorktreeClose") < hookEvents.indexOf("AfterWorktreeClose"),
    "worktree close hooks were recorded out of order",
  );
  pass("Hooks v1 dogfood", Array.from(new Set(hookEvents)).join(", "));

  const deleteSession = curlRequest({
    method: "DELETE",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
  });
  assert.ok([200, 202, 204].includes(deleteSession.status));
  acceptanceCompleted = true;
} catch (error) {
  console.error("\nForgeRelay 7677 acceptance failed.");
  throw error;
} finally {
  rmSync(tempAcceptanceRoot, { recursive: true, force: true });
  await stopServer(server);
}

if (acceptanceCompleted) {
  assertCodeIntelligenceAcceptanceShutdown({ logPath: codeIntelligenceLog, pass });
  console.log("\nForgeRelay 7677 acceptance passed.");
  console.log(`Artifacts: ${acceptanceRoot}`);
}
