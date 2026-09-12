import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectContextResolver } from "../../../workspaces/state/project-context.js";
import { ConfigSourceRuntime } from "../runtime/source-refresh.js";
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

test("legacy user hooks.json refreshes through Config v2 LKG and deletion semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-config-v2-user-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const legacyPath = join(configDir, "hooks.json");
  const sourceRuntime = new ConfigSourceRuntime();
  const legacy = (command: string) => ({
    AfterTool: [{ handlers: [{ name: "legacy-user", command }] }],
  });

  await writeFile(legacyPath, JSON.stringify(legacy("first")) + "\n");
  const first = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((first.values.hooks as Record<string, Array<{ command: string }>>)["legacy-user"]?.[0]?.command, "first");
  assert.equal(first.entries["hooks.legacy-user"]?.effective.source.id, "legacy:user:hooks.json");

  await writeFile(legacyPath, "{ invalid json\n");
  const invalid = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((invalid.values.hooks as Record<string, Array<{ command: string }>>)["legacy-user"]?.[0]?.command, "first");
  assert.equal(invalid.diagnostics.some((diagnostic) => diagnostic.usingLastKnownGood === true), true);

  await writeFile(legacyPath, JSON.stringify(legacy("second")) + "\n");
  const repaired = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((repaired.values.hooks as Record<string, Array<{ command: string }>>)["legacy-user"]?.[0]?.command, "second");

  await unlink(legacyPath);
  const deleted = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((deleted.values.hooks as Record<string, unknown> | undefined)?.["legacy-user"], undefined);
});

test("legacy inline Hooks refresh through Config v2 LKG and field deletion semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-config-v2-inline-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  const sourceRuntime = new ConfigSourceRuntime();
  const legacy = (command: string) => ({
    hooks: { AfterTool: [{ name: "legacy-inline", matcher: { tool: "bash" }, command }] },
  });

  await writeFile(configPath, JSON.stringify(legacy("first")) + "\n");
  const first = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((first.values.hooks as Record<string, Array<{ command: string }>>)["legacy-inline"]?.[0]?.command, "first");
  assert.equal(first.entries["hooks.legacy-inline"]?.effective.source.id, "legacy:user:config-hooks");
  assert.deepEqual(
    (first.values.hooks as Record<string, Array<{ matcher?: { tool?: string } }>>)["legacy-inline"]?.[0]?.matcher,
    { tool: "bash" },
  );

  await writeFile(configPath, JSON.stringify({ hooks: { UnknownEvent: [{ command: "broken" }] } }) + "\n");
  const invalid = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((invalid.values.hooks as Record<string, Array<{ command: string }>>)["legacy-inline"]?.[0]?.command, "first");
  assert.equal(invalid.diagnostics.some((diagnostic) =>
    diagnostic.source.id === "legacy:user:config-hooks" && diagnostic.usingLastKnownGood === true
  ), true);

  await writeFile(configPath, JSON.stringify(legacy("second")) + "\n");
  const repaired = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((repaired.values.hooks as Record<string, Array<{ command: string }>>)["legacy-inline"]?.[0]?.command, "second");

  await writeFile(configPath, "{}\n");
  const deleted = await resolveHooksConfig({ configDir, sourceRuntime });
  assert.equal((deleted.values.hooks as Record<string, unknown> | undefined)?.["legacy-inline"], undefined);
});

test("Hook directory refresh retains last-known-good per file and deletion clears that contribution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-config-lkg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(configDir, "hooks"), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  const retainedPath = join(configDir, "hooks", "retained.json");
  const siblingPath = join(configDir, "hooks", "sibling.json");
  await writeFile(retainedPath, JSON.stringify({ event: "AfterTool", command: "first" }) + "\n");
  await writeFile(siblingPath, JSON.stringify({ event: "AfterTool", command: "sibling" }) + "\n");
  const sourceRuntime = new ConfigSourceRuntime();

  const first = await resolveHooksConfig({ configDir, project, sourceRuntime });
  assert.equal((first.values.hooks as Record<string, Array<{ command: string }>>).retained?.[0]?.command, "first");

  await writeFile(retainedPath, "{ invalid json\n");
  const invalid = await resolveHooksConfig({ configDir, project, sourceRuntime });
  const invalidHooks = invalid.values.hooks as Record<string, Array<{ command: string }>>;
  assert.equal(invalidHooks.retained?.[0]?.command, "first");
  assert.equal(invalidHooks.sibling?.[0]?.command, "sibling");
  const lkgDiagnostic = invalid.diagnostics.find((diagnostic) => diagnostic.usingLastKnownGood === true);
  assert.ok(lkgDiagnostic);
  assert.equal(lkgDiagnostic?.diagnosticChanged, true);

  const sameInvalid = await resolveHooksConfig({ configDir, project, sourceRuntime });
  assert.equal(
    sameInvalid.diagnostics.find((diagnostic) => diagnostic.usingLastKnownGood === true)?.diagnosticChanged,
    false,
  );

  await unlink(retainedPath);
  const deleted = await resolveHooksConfig({ configDir, project, sourceRuntime });
  assert.equal((deleted.values.hooks as Record<string, unknown>).retained, undefined);
  assert.ok((deleted.values.hooks as Record<string, unknown>).sibling);
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
