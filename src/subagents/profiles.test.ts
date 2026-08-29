import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { loadLocalAgentProfiles, summarizeLocalAgentProfile } from "./profiles.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-profiles-test-"));

try {
  const configDir = join(root, ".devspace-home");
  const workspaceRoot = join(root, "project");
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".devspace", "agents"), { recursive: true });
  await mkdir(join(workspaceRoot, ".forgerelay", "agents"), { recursive: true });

  await writeFile(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Global reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "---",
      "",
      "Global body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "Project reviewer #1."',
      "provider: claude",
      "model: sonnet",
      "thinking: high",
      "---",
      "",
      "Project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".forgerelay", "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      'description: "ForgeRelay project reviewer."',
      "provider: claude",
      "model: opus",
      "thinking: high",
      "---",
      "",
      "ForgeRelay project body.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "disabled.md"),
    [
      "---",
      "name: disabled",
      "description: Disabled agent.",
      "provider: codex",
      "disabled: true",
      "---",
      "",
      "Disabled body.",
      "",
    ].join("\n"),
  );

  const enabledConfig = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: workspaceRoot,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const profiles = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.name, "reviewer");
  assert.equal(profiles[0]?.description, "ForgeRelay project reviewer.");
  assert.equal(profiles[0]?.provider, "claude");
  assert.equal(profiles[0]?.model, "opus");
  assert.equal(profiles[0]?.thinking, "high");
  assert.equal(profiles[0]?.body, "ForgeRelay project body.");
  assert.deepEqual(summarizeLocalAgentProfile(profiles[0]!), {
    name: "reviewer",
    description: "ForgeRelay project reviewer.",
    provider: "claude",
    model: "opus",
    thinking: "high",
  });

  await writeFile(
    join(workspaceRoot, ".devspace", "agents", "custom.md"),
    [
      "---",
      "name: custom",
      "description: Unsupported custom agent.",
      "provider: custom",
      "---",
      "",
      "Custom body.",
      "",
    ].join("\n"),
  );
  const profilesWithInvalid = await loadLocalAgentProfiles(enabledConfig, workspaceRoot);
  assert.deepEqual(profilesWithInvalid.map((profile) => profile.name), ["reviewer"]);

  const disabledConfig = loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: workspaceRoot,
    DEVSPACE_SUBAGENTS: "0",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.deepEqual(await loadLocalAgentProfiles(disabledConfig, workspaceRoot), []);
} finally {
  await rm(root, { recursive: true, force: true });
}
