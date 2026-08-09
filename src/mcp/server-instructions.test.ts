import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import {
  buildServerInstructions,
  buildToolDescriptions,
} from "./server-instructions.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-server-instructions-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function instructions(env: NodeJS.ProcessEnv = {}): string {
  return buildServerInstructions(loadConfig({ ...baseEnv, ...env }));
}

test("default instructions keep capability contract and built-in workflow preference", () => {
  const result = instructions();

  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_worktree/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.match(result, /Prefer edit for targeted modifications/);
  assert.match(result, /Do not create or modify files with bash/);
});

test("capability contract requires agents to report visible hook results", () => {
  const result = instructions();

  assert.match(result, /tool result reports Hook results/);
  assert.match(result, /tell the user which meaningful hooks ran and whether they passed or blocked the operation/);
});

test("workflow override replaces built-in workflow without replacing the capability contract", () => {
  const result = instructions({
    DEVSPACE_WORKFLOW_INSTRUCTIONS: "Use repository-defined development and Git workflows.",
  });

  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_worktree/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.match(result, /Use repository-defined development and Git workflows\./);
  assert.doesNotMatch(result, /Prefer edit for targeted modifications/);
  assert.doesNotMatch(result, /Do not create or modify files with bash/);
});

test("empty workflow override emits capability-only instructions", () => {
  const result = instructions({ DEVSPACE_WORKFLOW_INSTRUCTIONS: "" });

  assert.match(result, /Default to the user's existing checkout/);
  assert.match(result, /Only open mode="worktree" when the user explicitly asks/);
  assert.match(result, /close_worktree/);
  assert.match(result, /Follow instructions returned by open_workspace/);
  assert.doesNotMatch(result, /Prefer edit for targeted modifications/);
  assert.doesNotMatch(result, /Do not create or modify files with bash/);
});

test("append instructions extend the selected workflow", () => {
  const result = instructions({
    DEVSPACE_APPEND_INSTRUCTIONS: "Repository policy decides how Git commits are created.",
  });

  assert.match(result, /Do not create or modify files with bash/);
  assert.match(result, /Repository policy decides how Git commits are created\./);
});

test("codex workflow can be overridden independently of codex capabilities", () => {
  const defaultResult = instructions({ DEVSPACE_TOOL_MODE: "codex" });
  const overrideResult = instructions({
    DEVSPACE_TOOL_MODE: "codex",
    DEVSPACE_WORKFLOW_INSTRUCTIONS: "Follow the repository workflow.",
  });

  assert.match(defaultResult, /apply_patch for all file modifications/);
  assert.match(overrideResult, /apply_patch/);
  assert.match(overrideResult, /exec_command/);
  assert.match(overrideResult, /Follow the repository workflow\./);
  assert.doesNotMatch(overrideResult, /apply_patch for all file modifications/);
});

test("tool descriptions expose capabilities without embedding workflow policy", () => {
  const descriptions = buildToolDescriptions(loadConfig(baseEnv));

  assert.match(descriptions.shell, /local user's authority/);
  assert.match(descriptions.shell, /does not make shell execution a sandbox/);
  assert.match(descriptions.shell, /Do not use bash to create or modify project files/);
  assert.doesNotMatch(descriptions.shell, /Use only for/);
  assert.equal(descriptions.shellCommand, "Shell command to run with the local user's authority.");
  assert.doesNotMatch(descriptions.read, /instead of shell commands/);
  assert.doesNotMatch(descriptions.write, /Prefer edit/);
  assert.doesNotMatch(descriptions.edit, /Prefer this over write/);
  assert.doesNotMatch(descriptions.applyPatch, /Use this for all file modifications/);
});
