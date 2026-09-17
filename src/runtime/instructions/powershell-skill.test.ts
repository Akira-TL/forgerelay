import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config/config.js";
import { loadWorkspaceSkills } from "../../workspaces/resources/skills.js";

test("a legacy config-directory PowerShell Skill is only discovered when skillPaths explicitly selects it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-legacy-powershell-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  const skillPath = join(configDir, "skills", "powershell", "SKILL.md");
  await mkdir(join(configDir, "skills", "powershell"), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    skillPath,
    [
      "---",
      "name: powershell",
      "description: ForgeRelay-owned PowerShell guidance.",
      "---",
      "",
      "# Existing owner content",
      "",
    ].join("\n"),
  );

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: projectRoot,
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const defaultLoaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(defaultLoaded.skills.some((skill) => skill.name === "powershell"), false);

  const explicitConfig = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: projectRoot,
    FORGERELAY_SKILL_PATHS: join(configDir, "skills"),
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const explicitLoaded = loadWorkspaceSkills(explicitConfig, projectRoot);
  const legacy = explicitLoaded.skills.find((skill) => skill.name === "powershell");
  assert.equal(legacy?.filePath, skillPath);
  assert.equal(legacy?.description, "ForgeRelay-owned PowerShell guidance.");
});
