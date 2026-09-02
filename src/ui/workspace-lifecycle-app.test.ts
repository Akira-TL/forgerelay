import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { workspacePanelCardFromResult } from "./workspace/panel.js";

const unifiedSource = readFileSync(new URL("./activity-panel-app.tsx", import.meta.url), "utf8");
const activityPanelSource = readFileSync(new URL("./activity/panel.ts", import.meta.url), "utf8");
const lifecycleCompatibilitySource = readFileSync(
  new URL("./workspace-lifecycle-app.tsx", import.meta.url),
  "utf8",
);

test("Workspace presentation accepts the activity panel contract from metadata or structuredContent", () => {
  const result = {
    content: [],
    structuredContent: {
      workspaceId: "wrong-structured-id",
      root: "/wrong",
    },
    _meta: {
      "forgerelay/activityPanelWorkspace": {
        workspaceId: "ws_test",
        root: "/workspace/project",
        mode: "checkout",
        skills: [{ name: "ask-matt" }],
      },
    },
  } satisfies CallToolResult;

  assert.deepEqual(workspacePanelCardFromResult(result), {
    workspaceId: "ws_test",
    root: "/workspace/project",
    mode: "checkout",
    skills: [{ name: "ask-matt" }],
  });

  const structuredOnly = {
    content: [],
    structuredContent: {
      "forgerelay/activityPanelWorkspace": {
        workspaceId: "ws_structured",
        root: "/workspace/structured",
        mode: "worktree",
        agentsFiles: [{ path: "AGENTS.md", content: "instructions" }],
      },
    },
  } satisfies CallToolResult;
  assert.deepEqual(workspacePanelCardFromResult(structuredOnly), {
    workspaceId: "ws_structured",
    root: "/workspace/structured",
    mode: "worktree",
    agentsFiles: [{ path: "AGENTS.md", content: "instructions" }],
  });
  assert.equal(workspacePanelCardFromResult({ content: [] }), undefined);
});

test("activity_panel owns one runtime containing permanent Workspace and collapsible Activity sections", () => {
  assert.match(unifiedSource, /WorkspacePanelController/);
  assert.match(unifiedSource, /ActivityPanelController/);
  assert.match(unifiedSource, /embedded: true/);
  assert.match(unifiedSource, /arguments: \{ workspaceId \}/);
  assert.match(unifiedSource, /forgerelay-panel/);
  assert.doesNotMatch(unifiedSource, /workspace-panel-pending-dot/);
  assert.doesNotMatch(unifiedSource, /renderActivityPending/);
  assert.match(activityPanelSource, /this\.snapshot\.revision === 0/);
  assert.match(activityPanelSource, /private activities: ActivitySummary\[\] = \[\]/);
  assert.match(activityPanelSource, /name: "activity_index"/);
  assert.match(activityPanelSource, /this\.root\.replaceChildren\(\)/);
});

test("Workspace Lifecycle entry is compatibility-only and does not own Activity", () => {
  assert.match(lifecycleCompatibilitySource, /workspace-lifecycle-compatibility/);
  assert.match(lifecycleCompatibilitySource, /import "\.\/workspace-app\.js"/);
  assert.doesNotMatch(lifecycleCompatibilitySource, /ActivityPanelController|WorkspacePanelController/);
});
