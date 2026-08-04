import assert from "node:assert/strict";
import test from "node:test";
import {
  isEditTool,
  isExpandableCard,
  isPatchTool,
  isShellTool,
  isToolName,
} from "./card-types.js";

test("the supported coding tools are recognized as card tools", () => {
  for (const tool of ["apply_patch", "exec_command", "write_stdin"]) {
    assert.equal(isToolName(tool), true, `${tool} should be a recognized card tool`);
  }
});

test("tool classification distinguishes patch, edit, and shell operations", () => {
  assert.equal(isPatchTool("apply_patch"), true);
  assert.equal(isEditTool("apply_patch"), false);
  assert.equal(isShellTool("apply_patch"), false);
  assert.equal(isShellTool("exec_command"), true);
  assert.equal(isShellTool("write_stdin"), true);
  assert.equal(isEditTool("exec_command"), false);
});

test("a patch card expands only when it contains patch content", () => {
  assert.equal(
    isExpandableCard({ tool: "apply_patch", payload: { patch: "diff --git a/a b/a" } }),
    true,
  );
  assert.equal(isExpandableCard({ tool: "apply_patch" }), false);
});

test("a workspace card expands when it contains provider metadata", () => {
  assert.equal(
    isExpandableCard({
      tool: "open_workspace",
      agentProviders: [{ name: "codex", available: true }],
    }),
    true,
  );
});

test("a workspace card expands when it contains agent metadata", () => {
  assert.equal(
    isExpandableCard({
      tool: "open_workspace",
      agents: [{ name: "reviewer", provider: "codex" }],
    }),
    true,
  );
});

test("an empty workspace card stays collapsed", () => {
  assert.equal(isExpandableCard({ tool: "open_workspace" }), false);
});
