import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceResourceMonitor } from "./resource-monitor.js";

async function waitForUpdate(
  monitor: WorkspaceResourceMonitor,
  workspaceId: string,
  conversationScopeId: string,
) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const update = monitor.claim(workspaceId, conversationScopeId);
    if (update) return update;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Workspace resource update.");
}

test("physical instruction files use one shared watcher and deliver bounded deltas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-resource-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "AGENTS.md");
  await writeFile(path, [
    "# Instructions",
    "stable-before",
    "old-rule",
    "stable-after",
    "distant-content-that-should-not-be-repeated",
  ].join("\n"));

  const first = new WorkspaceResourceMonitor();
  const second = new WorkspaceResourceMonitor();
  for (const [monitor, workspaceId] of [[first, "ws_first"], [second, "ws_second"]] as const) {
    monitor.trackWorkspace({
      workspaceId,
      root,
      loadedInstructions: [path],
      availableInstructions: [],
      skills: [],
    });
    monitor.acknowledge(workspaceId, "chat");
  }

  assert.equal(first.watchedPhysicalFiles, 1);
  assert.equal(second.watchedPhysicalFiles, 1);

  await writeFile(path, [
    "# Instructions",
    "stable-before",
    "new-rule",
    "stable-after",
    "distant-content-that-should-not-be-repeated",
  ].join("\n"));

  const update = await waitForUpdate(first, "ws_first", "chat");
  assert.match(update.text, /Workspace instruction delta: AGENTS\.md/);
  assert.match(update.text, /-old-rule/);
  assert.match(update.text, /\+new-rule/);
  assert.doesNotMatch(update.text, /distant-content-that-should-not-be-repeated/);
  assert.deepEqual(update.coveredComponents, ["agentsFiles"]);

  const secondUpdate = await waitForUpdate(second, "ws_second", "chat");
  assert.match(secondUpdate.text, /\+new-rule/);

  first.forgetWorkspace("ws_first");
  assert.equal(second.watchedPhysicalFiles, 1);
  second.forgetWorkspace("ws_second");
  assert.equal(second.watchedPhysicalFiles, 0);
});

test("inactive Skills expose metadata deltas while active Skills expose body deltas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-skill-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDir = join(root, "skills", "reviewer");
  const path = join(skillDir, "SKILL.md");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(skillDir, { recursive: true }));
  await writeFile(path, [
    "---",
    "name: reviewer",
    "description: Old description.",
    "---",
    "# Reviewer",
    "old-private-body",
  ].join("\n"));

  const monitor = new WorkspaceResourceMonitor();
  monitor.trackWorkspace({
    workspaceId: "ws_skill",
    root,
    loadedInstructions: [],
    availableInstructions: [],
    skills: [{ name: "reviewer", filePath: path, baseDir: skillDir, activated: false }],
  });
  monitor.acknowledge("ws_skill", "chat");

  await writeFile(path, [
    "---",
    "name: reviewer",
    "description: New description.",
    "---",
    "# Reviewer",
    "new-private-body",
  ].join("\n"));
  const metadata = await waitForUpdate(monitor, "ws_skill", "chat");
  assert.match(metadata.text, /Skill metadata delta: skills:\/\/reviewer/);
  assert.match(metadata.text, /Old description/);
  assert.match(metadata.text, /New description/);
  assert.doesNotMatch(metadata.text, /new-private-body/);

  monitor.markSkillActivated("ws_skill", path);
  await writeFile(path, [
    "---",
    "name: reviewer",
    "description: New description.",
    "---",
    "# Reviewer",
    "active-body-change",
  ].join("\n"));
  const body = await waitForUpdate(monitor, "ws_skill", "chat");
  assert.match(body.text, /Active Skill delta: skills:\/\/reviewer/);
  assert.match(body.text, /\+active-body-change/);

  monitor.forgetWorkspace("ws_skill");
  assert.equal(monitor.watchedPhysicalFiles, 0);
});
