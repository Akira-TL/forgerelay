import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectContextResolver } from "../../../workspaces/state/project-context.js";
import { resolveHooksConfig } from "./hooks.js";

test("Hook Config v2 composes independent files and resolves same-name entries by scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-config-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(configDir, "hooks"), { recursive: true });
  await mkdir(join(projectRoot, ".forgerelay", "hooks"), { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(join(project.localConfigDir, "hooks"), { recursive: true });

  const hook = (command: string) => ({ event: "AfterTool", command });
  await writeFile(join(configDir, "hooks", "shared.json"), JSON.stringify(hook("user-shared")) + "\n");
  await writeFile(join(configDir, "hooks", "user-only.json"), JSON.stringify(hook("user-only")) + "\n");
  await writeFile(join(project.sharedConfigDir, "hooks", "shared.json"), JSON.stringify(hook("project-shared")) + "\n");
  await writeFile(join(project.sharedConfigDir, "hooks", "project-only.json"), JSON.stringify(hook("project-only")) + "\n");
  await writeFile(join(project.sharedConfigDir, "hooks", "broken.json"), "{ invalid json\n");
  await writeFile(join(project.localConfigDir, "hooks", "shared.json"), JSON.stringify(hook("project-local")) + "\n");
  await writeFile(join(project.localConfigDir, "hooks", "local-only.json"), JSON.stringify(hook("local-only")) + "\n");

  const resolution = await resolveHooksConfig({ configDir, project });
  const hooks = resolution.values.hooks as Record<string, Array<{ command: string }>>;

  assert.equal(hooks.shared?.[0]?.command, "project-local");
  assert.equal(hooks["user-only"]?.[0]?.command, "user-only");
  assert.equal(hooks["project-only"]?.[0]?.command, "project-only");
  assert.equal(hooks["local-only"]?.[0]?.command, "local-only");
  assert.equal(hooks.broken, undefined);
  assert.equal(resolution.entries["hooks.shared"]?.effective.source.scope, "project-local");
  assert.equal(resolution.entries["hooks.project-only"]?.effective.source.scope, "project");
  assert.equal(resolution.entries["hooks.user-only"]?.effective.source.scope, "user");
  assert.equal(resolution.diagnostics.filter((diagnostic) => diagnostic.code === "invalid_source").length, 1);
  assert.match(resolution.diagnostics[0]?.source.location ?? "", /broken\.json$/);
});

test("invalid canonical Hook shadows only the same-name legacy Hook and repair resolves predictably", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-config-v2-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(configDir, "hooks"), { recursive: true });
  await mkdir(join(projectRoot, ".forgerelay", "hooks"), { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);

  await writeFile(
    join(configDir, "hooks", "shared.json"),
    JSON.stringify({ event: "AfterTool", command: "user-shared" }) + "\n",
  );
  await writeFile(
    join(project.sharedConfigDir, "hooks.json"),
    JSON.stringify({
      AfterTool: [{
        handlers: [
          { name: "shared", command: "legacy-project-shared" },
          { name: "legacy-only", command: "legacy-project-only" },
        ],
      }],
    }) + "\n",
  );
  const canonicalShared = join(project.sharedConfigDir, "hooks", "shared.json");
  await writeFile(canonicalShared, "{ invalid json\n");
  await writeFile(
    join(project.sharedConfigDir, "hooks", "project-valid.json"),
    JSON.stringify({ event: "AfterTool", command: "project-valid" }) + "\n",
  );

  const invalid = await resolveHooksConfig({ configDir, project });
  const invalidHooks = invalid.values.hooks as Record<string, Array<{ command: string }>>;
  assert.equal(invalidHooks.shared?.[0]?.command, "user-shared");
  assert.equal(invalidHooks["legacy-only"]?.[0]?.command, "legacy-project-only");
  assert.equal(invalidHooks["project-valid"]?.[0]?.command, "project-valid");
  assert.equal(invalid.entries["hooks.shared"]?.effective.source.scope, "user");
  assert.equal(
    invalid.entries["hooks.shared"]?.shadowed.some((entry) =>
      entry.source.scope === "project" && entry.reason === "source-shadowed"
    ),
    true,
  );

  await writeFile(
    canonicalShared,
    JSON.stringify({ event: "AfterTool", command: "canonical-project-shared" }) + "\n",
  );
  const repaired = await resolveHooksConfig({ configDir, project });
  const repairedHooks = repaired.values.hooks as Record<string, Array<{ command: string }>>;
  assert.equal(repairedHooks.shared?.[0]?.command, "canonical-project-shared");
  assert.equal(repaired.entries["hooks.shared"]?.effective.source.scope, "project");
  assert.match(repaired.entries["hooks.shared"]?.effective.source.id ?? "", /^canonical:project:hook:/);
});
