import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../runtime/config/config.js";
import {
  buildServerInstructions,
  buildToolDescriptions,
} from "./server-instructions.js";

const configDir = mkdtempSync(join(tmpdir(), "forgerelay-server-instructions-test-"));
const baseEnv = {
  FORGERELAY_CONFIG_DIR: configDir,
  FORGERELAY_ALLOWED_ROOTS: process.cwd(),
  FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function instructions(env: NodeJS.ProcessEnv = {}): string {
  return buildServerInstructions(loadConfig({ ...baseEnv, ...env }));
}

test("default instructions keep a compact core capability contract and built-in workflow preference", () => {
  const result = instructions();

  assert.ok(result.length < 3_000, `default instructions should stay compact, got ${result.length} characters`);
  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_workspace/);
  assert.match(result, /Project-work order: open_workspace if needed → activity_panel\(workspaceId\) once → work tools/);
  assert.match(result, /single ForgeRelay UI render tool/);
  assert.match(result, /Never call activity_panel before needed open_workspace/);
  assert.doesNotMatch(result, /workspace_lifecycle_panel/);
  assert.doesNotMatch(result, /close_worktree/);
  assert.doesNotMatch(result, /write_stdin/);
  assert.match(result, /capability guide/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.match(result, /Prefer edit for targeted content modifications/);
  assert.match(result, /For long bash commands or wait-only calls/);
  assert.match(result, /do not poll every few seconds/);
  assert.match(result, /Completion returns immediately if sooner/);
  assert.match(result, /rename for path moves/);
  assert.match(result, /delete for removals/);
  assert.match(result, /Shell commands may modify ordinary project files/);
  assert.match(result, /\/etc\/sudoers/);
  assert.match(result, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.match(result, /external device or hardware mutations/);
  assert.match(result, /explicitly asks for the actual device-changing operation/);
  assert.match(result, /check, audit, probe, backup, verification, dry-run, or build-only request/);
  assert.doesNotMatch(result, /Do not create or modify files with bash/);
  assert.doesNotMatch(result, /forgerelay\/\* branches/);
  assert.doesNotMatch(result, /fast-forwards the original target branch/);
  assert.doesNotMatch(result, /target branch diverged/);
});

test("minimal and full share the same regular workflow instructions", () => {
  const minimal = instructions({ FORGERELAY_TOOL_MODE: "minimal" });
  const full = instructions({ FORGERELAY_TOOL_MODE: "full" });

  assert.equal(full, minimal);
  assert.match(full, /Use bash with command-line tools such as grep, rg, find, ls, and tree/);
});

test("capability contract requires agents to report visible hook results", () => {
  const result = instructions();

  assert.match(result, /tool result reports Hook results/);
  assert.match(result, /tell the user which meaningful hooks ran and whether they passed or blocked the operation/);
});

test("optional artifact and review features do not expand the core instruction payload", () => {
  const result = buildServerInstructions(loadConfig({
    ...baseEnv,
    FORGERELAY_ARTIFACTS: "1",
    FORGERELAY_WIDGETS: "changes",
  }));

  assert.ok(result.length < 3_000, `feature-enabled instructions should stay compact, got ${result.length} characters`);
  assert.doesNotMatch(result, /signed URLs/);
  assert.doesNotMatch(result, /show_changes exactly once/);
  assert.doesNotMatch(result, /native file value/);
  assert.match(result, /capability guide/);
});

test("workflow override replaces built-in workflow without replacing the capability contract", () => {
  const result = instructions({
    FORGERELAY_WORKFLOW_INSTRUCTIONS: "Use repository-defined development and Git workflows.",
  });

  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_workspace/);
  assert.doesNotMatch(result, /close_worktree/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.match(result, /Use repository-defined development and Git workflows\./);
  assert.match(result, /Shell commands may modify ordinary project files/);
  assert.match(result, /\/etc\/sudoers/);
  assert.match(result, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(result, /Prefer edit for targeted content modifications/);
  assert.doesNotMatch(result, /Do not create or modify files with bash/);
});

test("empty workflow override emits capability-only instructions", () => {
  const result = instructions({ FORGERELAY_WORKFLOW_INSTRUCTIONS: "" });

  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_workspace/);
  assert.doesNotMatch(result, /close_worktree/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.match(result, /Shell commands may modify ordinary project files/);
  assert.match(result, /\/etc\/sudoers/);
  assert.doesNotMatch(result, /Prefer edit for targeted content modifications/);
  assert.doesNotMatch(result, /Do not create or modify files with bash/);
});

test("append instructions extend the selected workflow", () => {
  const result = instructions({
    FORGERELAY_APPEND_INSTRUCTIONS: "Repository policy decides how Git commits are created.",
  });

  assert.match(result, /Shell commands may modify ordinary project files/);
  assert.match(result, /Repository policy decides how Git commits are created\./);
});

test("codex workflow override relies on tools/list instead of duplicating the tool surface", () => {
  const defaultResult = instructions({ FORGERELAY_TOOL_MODE: "codex" });
  const overrideResult = instructions({
    FORGERELAY_TOOL_MODE: "codex",
    FORGERELAY_WORKFLOW_INSTRUCTIONS: "Follow the repository workflow.",
  });

  assert.match(defaultResult, /rename and delete for direct path moves or removals/);
  assert.match(defaultResult, /apply_patch for content modifications/);
  assert.doesNotMatch(overrideResult, /apply_patch/);
  assert.doesNotMatch(overrideResult, /exec_command/);
  assert.match(overrideResult, /Follow the repository workflow\./);
  assert.match(defaultResult, /Shell commands may modify ordinary project files/);
  assert.match(overrideResult, /Shell commands may modify ordinary project files/);
  assert.match(overrideResult, /\/etc\/sudoers/);
  assert.doesNotMatch(overrideResult, /apply_patch for content modifications/);
});

test("tool descriptions expose invocation semantics without duplicating core policy", () => {
  const descriptions = buildToolDescriptions(loadConfig(baseEnv));

  assert.ok(descriptions.shell.length < 900, `shell description should stay compact, got ${descriptions.shell.length} characters`);
  assert.match(descriptions.shell, /local user's authority/);
  assert.match(descriptions.shell, /does not make shell execution a sandbox/);
  assert.match(descriptions.shell, /yieldTimeMs/);
  assert.match(descriptions.shell, /timeoutMs/);
  assert.match(descriptions.shell, /action=process/);
  assert.match(descriptions.shell, /long-running commands or wait-only process calls/);
  assert.match(descriptions.shell, /60000ms when supported/);
  assert.match(descriptions.shell, /process finishes sooner, the call returns immediately/);
  assert.doesNotMatch(descriptions.shell, /write_stdin/);
  assert.doesNotMatch(descriptions.shell, /may modify ordinary project files/);
  assert.doesNotMatch(descriptions.shell, /\/etc\/sudoers/);
  assert.doesNotMatch(descriptions.shell, /configuration files through shell only when the user's request explicitly calls for that configuration change/);
  assert.doesNotMatch(descriptions.shell, /external device or hardware mutations/);
  assert.doesNotMatch(descriptions.shell, /Do not use bash to create, move, rename, or delete project files/);
  assert.doesNotMatch(descriptions.shell, /Use only for/);
  assert.equal(descriptions.shellCommand, "Shell command to run with the local user's authority.");
  assert.doesNotMatch(descriptions.read, /instead of shell commands/);
  assert.doesNotMatch(descriptions.write, /Prefer edit/);
  assert.doesNotMatch(descriptions.edit, /Prefer this over write/);
  assert.doesNotMatch(descriptions.applyPatch, /Use this for all file modifications/);
  assert.match(descriptions.read, /read-only inspection before opening a Workspace/);
  assert.match(descriptions.read, /configured allowedRoots/);
  assert.match(descriptions.write, /OS temp directory/);
  assert.match(descriptions.edit, /OS temp directory/);
  assert.match(descriptions.rename, /OS temp directory/);
  assert.match(descriptions.rename, /without overwriting an existing destination/);
  assert.match(descriptions.delete, /OS temp directory/);
  assert.match(descriptions.delete, /recursive=true/);
  assert.match(descriptions.applyPatch, /OS temp directory/);
});
