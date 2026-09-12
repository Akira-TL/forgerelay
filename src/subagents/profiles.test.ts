import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../runtime/config/config.js";
import { ProjectContextResolver } from "../workspaces/state/project-context.js";
import {
  loadSubagentProfiles,
  resolveSubagentProfilesConfig,
  subagentProfilesConfigDefinition,
  summarizeSubagentProfile,
} from "./profiles.js";

function profile(input: {
  name: string;
  description: string;
  provider?: string;
  model?: string;
  thinking?: string;
  disabled?: boolean;
  body?: string;
}): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    `provider: ${input.provider ?? "codex"}`,
    ...(input.model ? [`model: ${input.model}`] : []),
    ...(input.thinking ? [`thinking: ${input.thinking}`] : []),
    ...(input.disabled === undefined ? [] : [`disabled: ${input.disabled ? "true" : "false"}`]),
    "---",
    "",
    input.body ?? `${input.description} body.`,
    "",
  ].join("\n");
}

function tombstone(name: string): string {
  return ["---", `name: ${name}`, "disabled: true", "---", ""].join("\n");
}

function enabledConfig(configDir: string, workspaceRoot: string) {
  return loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: workspaceRoot,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
}

test("Subagent Profiles resolve canonical user, Project, and Project Local directories through Config v2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-config-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const workspaceRoot = join(root, "project");
  await mkdir(workspaceRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(workspaceRoot);
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(configDir, "subagents"), { recursive: true });
  await mkdir(join(project.sharedConfigDir, "subagents"), { recursive: true });
  await mkdir(join(project.localConfigDir, "subagents"), { recursive: true });

  await writeFile(join(configDir, "agents", "legacy-only.md"), profile({
    name: "legacy-only",
    description: "Legacy user profile.",
  }));
  await writeFile(join(configDir, "subagents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Canonical user reviewer.",
    provider: "codex",
  }));
  await writeFile(join(project.sharedConfigDir, "subagents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Project reviewer.",
    provider: "claude",
  }));
  await writeFile(join(project.localConfigDir, "subagents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Project Local reviewer.",
    provider: "copilot",
    model: "local-model",
    thinking: "high",
    body: "Project Local body.",
  }));

  const config = enabledConfig(configDir, workspaceRoot);
  const resolution = await resolveSubagentProfilesConfig(config, workspaceRoot);
  const profiles = await loadSubagentProfiles(config, workspaceRoot);
  assert.deepEqual(profiles.map((entry) => entry.name), ["legacy-only", "reviewer"]);
  const reviewer = profiles.find((entry) => entry.name === "reviewer");
  assert.equal(reviewer?.description, "Project Local reviewer.");
  assert.equal(reviewer?.provider, "copilot");
  assert.equal(reviewer?.model, "local-model");
  assert.equal(reviewer?.thinking, "high");
  assert.equal(reviewer?.body, "Project Local body.");
  assert.equal(resolution.entries["profiles.reviewer"]?.effective.source.scope, "project-local");
  assert.equal(resolution.entries["profiles.legacy-only"]?.effective.source.scope, "user");
  assert.ok(resolution.diagnostics.some((diagnostic) => diagnostic.code === "deprecated_source"));
  assert.deepEqual(summarizeSubagentProfile(reviewer!), {
    name: "reviewer",
    description: "Project Local reviewer.",
    provider: "copilot",
    model: "local-model",
    thinking: "high",
  });
});

test("invalid canonical Subagent Profile shadows only the same-name legacy profile and valid siblings remain usable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-shadow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(configDir, "subagents"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(configDir, "agents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Legacy reviewer.",
  }));
  const invalidCanonical = join(configDir, "subagents", "reviewer.md");
  await writeFile(invalidCanonical, profile({
    name: "reviewer",
    description: "Broken canonical reviewer.",
    provider: "unsupported-provider",
  }));
  await writeFile(join(configDir, "subagents", "helper.md"), profile({
    name: "helper",
    description: "Valid helper.",
  }));

  const config = enabledConfig(configDir, workspaceRoot);
  const invalidResolution = await resolveSubagentProfilesConfig(config, workspaceRoot);
  assert.deepEqual((await loadSubagentProfiles(config, workspaceRoot)).map((entry) => entry.name), ["helper"]);
  assert.equal(invalidResolution.diagnostics.filter((diagnostic) => diagnostic.code === "invalid_source").length, 1);
  assert.match(invalidResolution.diagnostics.find((diagnostic) => diagnostic.code === "invalid_source")?.source.location ?? "", /reviewer\.md$/);

  await unlink(invalidCanonical);
  const revealed = await loadSubagentProfiles(config, workspaceRoot);
  assert.deepEqual(revealed.map((entry) => entry.name), ["helper", "reviewer"]);
  assert.equal(revealed.find((entry) => entry.name === "reviewer")?.description, "Legacy reviewer.");
});

test("canonical disabled Subagent Profile is a keyed tombstone that masks lower scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-tombstone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const workspaceRoot = join(root, "project");
  await mkdir(workspaceRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(workspaceRoot);
  await mkdir(join(project.sharedConfigDir, "subagents"), { recursive: true });
  await mkdir(join(project.localConfigDir, "subagents"), { recursive: true });
  await writeFile(join(project.sharedConfigDir, "subagents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Project reviewer.",
  }));
  await writeFile(join(project.localConfigDir, "subagents", "reviewer.md"), tombstone("reviewer"));

  const config = enabledConfig(configDir, workspaceRoot);
  const resolution = await resolveSubagentProfilesConfig(config, workspaceRoot);
  assert.deepEqual(await loadSubagentProfiles(config, workspaceRoot), []);
  assert.equal(resolution.entries["profiles.reviewer"]?.tombstone, true);
  assert.equal(resolution.entries["profiles.reviewer"]?.effective.source.scope, "project-local");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.merge, "keyed");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.reload, "hot");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.executionEffect instanceof Function, true);
});

test("Subagent Profile consumption remains disabled when the general subagents flag is off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-disabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "subagents"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(configDir, "subagents", "reviewer.md"), profile({
    name: "reviewer",
    description: "Reviewer.",
  }));
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: workspaceRoot,
    FORGERELAY_SUBAGENTS: "0",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadSubagentProfiles(config, workspaceRoot), []);
});
