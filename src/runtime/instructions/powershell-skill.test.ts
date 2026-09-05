import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { loadConfig } from "../config/config.js";
import { loadWorkspaceSkills } from "../../workspaces/resources/skills.js";
import {
  powerShellSkillPath,
  powerShellSkillTemplateUrl,
  seedPowerShellSkill,
} from "./powershell-skill.js";

test("PowerShell Skill uses an exact release tag and the config Skills directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-powershell-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(
    powerShellSkillTemplateUrl("0.10.1"),
    "https://raw.githubusercontent.com/Akira-TL/forgerelay/v0.10.1/templates/skills/powershell/SKILL.md",
  );
  assert.equal(powerShellSkillPath(root), join(root, "skills", "powershell", "SKILL.md"));
});

test("PowerShell Skill seed creates once and preserves owner edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-powershell-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fetches = 0;
  const fetchText = async () => {
    fetches += 1;
    return "---\nname: powershell\ndescription: deep guidance\n---\n\n# PowerShell\n";
  };

  const created = await seedPowerShellSkill({
    configDir: root,
    version: "0.10.1",
    fetchText,
  });
  assert.equal(created.status, "created");
  assert.equal(fetches, 1);

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: root,
    FORGERELAY_ALLOWED_ROOTS: root,
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const loaded = loadWorkspaceSkills(config, root);
  assert.equal(loaded.skills.some((skill) => skill.name === "powershell"), true);

  await writeFile(created.path, "owner customized\n", "utf8");
  const preserved = await seedPowerShellSkill({
    configDir: root,
    version: "0.10.1",
    fetchText,
  });
  assert.equal(preserved.status, "preserved");
  assert.equal(fetches, 1);
  assert.equal(await readFile(created.path, "utf8"), "owner customized\n");
});

test("PowerShell Skill seed reports download failure without inventing content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-powershell-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await seedPowerShellSkill({
    configDir: root,
    version: "0.10.1",
    fetchText: async () => { throw new Error("offline"); },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /offline/);
  await assert.rejects(() => readFile(result.path, "utf8"), /ENOENT/);
});

test("PowerShell Skill reset replaces an existing config copy explicitly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-powershell-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = powerShellSkillPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "old\n", "utf8");

  const result = await seedPowerShellSkill({
    configDir: root,
    version: "0.10.1",
    reset: true,
    fetchText: async () => "new\n",
  });
  assert.equal(result.status, "created");
  assert.equal(await readFile(path, "utf8"), "new\n");
});
