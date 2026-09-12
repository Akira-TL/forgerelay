import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as z from "zod/v4";
import { defineConfigDomain } from "../../runtime/config/definition/definition.js";
import { resolveConfigDomain } from "../../runtime/config/resolution/resolver.js";
import {
  loadProjectConfigSources,
  resolveProjectGeneralConfig,
} from "../../runtime/config/resolution/project-sources.js";
import { ProjectContextResolver } from "./project-context.js";

const execFileAsync = promisify(execFile);

const precedenceDefinition = defineConfigDomain({
  domain: "project-source-test",
  title: "Project source test",
  description: "Test-only project source precedence contract.",
  fields: {
    value: {
      schema: z.string(),
      description: "One replace value.",
      legalScopes: ["project-local", "project", "built-in"],
      merge: "replace",
      reload: "hot",
      sensitivity: "public",
      interpolation: "none",
      builtIn: { kind: "literal", value: "built-in" },
      executionEffect: "none",
    },
  },
});

test("Git linked worktrees share one Project ID while independent clones remain distinct", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-identity-git-"));
  const configDir = join(root, "config");
  const source = join(root, "source");
  const linked = join(root, "linked");
  const clone = join(root, "clone");
  t.after(() => rm(root, { recursive: true, force: true }));

  await createGitProject(source);
  await git(source, ["worktree", "add", "-b", "linked-test", linked, "HEAD"]);
  await git(root, ["clone", "--local", source, clone]);

  const resolver = new ProjectContextResolver(configDir);
  const sourceProject = await resolver.resolve(source);
  const linkedProject = await resolver.resolve(linked);
  const cloneProject = await resolver.resolve(clone);

  assert.equal(sourceProject.kind, "git");
  assert.equal(linkedProject.kind, "git");
  assert.equal(sourceProject.id, linkedProject.id);
  assert.notEqual(sourceProject.id, cloneProject.id);
  assert.equal(sourceProject.projectRoot, resolve(source));
  assert.equal(linkedProject.projectRoot, resolve(linked));
  assert.equal(sourceProject.localConfigDir, join(configDir, "projects", sourceProject.id));
  assert.equal(sourceProject.sharedConfigDir, join(source, ".forgerelay"));

  assert.equal(sourceProject.gitCommonDir, linkedProject.gitCommonDir);
  assert.notEqual(sourceProject.gitCommonDir, cloneProject.gitCommonDir);
  const marker = join(sourceProject.gitCommonDir!, "forgerelay", "project-id");
  assert.equal((await readFile(marker, "utf8")).trim(), sourceProject.id);
});

test("Git Project identity survives path moves while Project Local storage stays config-instance-local", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-identity-move-"));
  const source = join(root, "source");
  const moved = join(root, "moved");
  const configA = join(root, "config-a");
  const configB = join(root, "config-b");
  t.after(() => rm(root, { recursive: true, force: true }));
  await createGitProject(source);

  const first = await new ProjectContextResolver(configA).resolve(source);
  const isolated = await new ProjectContextResolver(configB).resolve(source);
  assert.equal(first.id, isolated.id);
  assert.equal(first.localConfigDir, join(configA, "projects", first.id));
  assert.equal(isolated.localConfigDir, join(configB, "projects", first.id));

  await rename(source, moved);
  const afterMove = await new ProjectContextResolver(configA).resolve(moved);
  assert.equal(afterMove.id, first.id);
  assert.equal(afterMove.projectRoot, resolve(moved));
  assert.equal(afterMove.sharedConfigDir, join(moved, ".forgerelay"));
  assert.equal(afterMove.localConfigDir, first.localConfigDir);
});

test("Git workspaces fail closed instead of changing identity class when Git becomes unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-identity-git-missing-"));
  const configDir = join(root, "config");
  const gitProject = join(root, "git-project");
  const nonGitProject = join(root, "plain-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await createGitProject(gitProject);
  await mkdir(nonGitProject);

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const resolver = new ProjectContextResolver(configDir);
    await assert.rejects(
      () => resolver.resolve(gitProject),
      /Git is required to resolve canonical ForgeRelay Project identity/,
    );
    assert.equal((await resolver.resolve(nonGitProject)).kind, "non-git");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("recloning a Git project at the same path produces a new Project ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-identity-reclone-"));
  const configDir = join(root, "config");
  const origin = join(root, "origin");
  const checkout = join(root, "checkout");
  t.after(() => rm(root, { recursive: true, force: true }));

  await createGitProject(origin);
  await git(root, ["clone", "--local", origin, checkout]);
  const resolver = new ProjectContextResolver(configDir);
  const first = await resolver.resolve(checkout);

  await rm(checkout, { recursive: true, force: true });
  await git(root, ["clone", "--local", origin, checkout]);
  const second = await resolver.resolve(checkout);

  assert.notEqual(first.id, second.id);
});

test("non-Git Project identity is bound to canonical root in ForgeRelay-private state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-identity-nongit-"));
  const configDir = join(root, "config");
  const project = join(root, "project");
  const alias = join(root, "project-alias");
  const moved = join(root, "project-moved");
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(project);
  await writeFile(join(project, "file.txt"), "hello\n");
  if (process.platform !== "win32") await symlink(project, alias, "dir");

  const resolver = new ProjectContextResolver(configDir);
  const first = await resolver.resolve(project);
  const same = process.platform === "win32" ? await resolver.resolve(project) : await resolver.resolve(alias);

  assert.equal(first.kind, "non-git");
  assert.equal(first.id, same.id);
  assert.equal(first.canonicalRoot, resolve(project));
  assert.equal(first.localConfigDir, join(configDir, "projects", first.id));
  assert.equal(first.sharedConfigDir, join(project, ".forgerelay"));
  assert.deepEqual((await readdir(project)).sort(), ["file.txt"]);

  await rename(project, moved);
  const afterMove = await resolver.resolve(moved);
  assert.notEqual(afterMove.id, first.id);
  assert.equal(afterMove.canonicalRoot, resolve(moved));

  const identityIndex = join(configDir, "projects", "non-git-identities.json");
  const persisted = JSON.parse(await readFile(identityIndex, "utf8")) as {
    version: number;
    projects: Record<string, string>;
  };
  assert.equal(persisted.version, 1);
  assert.equal(persisted.projects[resolve(moved)], afterMove.id);
});

test("Project Local JSON sources load from Project-owned private storage and outrank project-shared sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-source-test-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(projectRoot);

  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(project.sharedConfigDir, { recursive: true });
  await mkdir(project.localConfigDir, { recursive: true });
  await writeFile(join(project.sharedConfigDir, "config.json"), JSON.stringify({ value: "project" }));
  await writeFile(join(project.localConfigDir, "config.json"), JSON.stringify({ value: "project-local" }));

  const sources = await loadProjectConfigSources(project, {
    domain: "project-source-test",
    fileName: "config.json",
  });
  assert.deepEqual(sources.map((source) => [source.scope, source.location]), [
    ["project", join(project.sharedConfigDir, "config.json")],
    ["project-local", join(project.localConfigDir, "config.json")],
  ]);

  const resolved = resolveConfigDomain({ definition: precedenceDefinition, sources });
  assert.equal(resolved.values.value, "project-local");
  assert.equal(resolved.entries.value?.effective.source.scope, "project-local");
  assert.equal(resolved.entries.value?.shadowed[0]?.source.scope, "project");
});

test("general config discovery includes user, project, and Project Local sources without widening project legality", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-general-config-test-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(projectRoot);

  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(project.sharedConfigDir, { recursive: true });
  await mkdir(project.localConfigDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ port: 7100 }));
  await writeFile(join(project.sharedConfigDir, "config.json"), JSON.stringify({ $schema: "project" }));
  await writeFile(join(project.localConfigDir, "config.json"), JSON.stringify({ $schema: "project-local" }));

  const resolved = await resolveProjectGeneralConfig(project, { env: {} });
  assert.equal(resolved.values.port, 7100);
  assert.equal(resolved.entries.port?.effective.source.scope, "user");
  assert.deepEqual(
    resolved.sources
      .filter((source) => source.kind === "file")
      .map((source) => [source.id, source.scope, source.location]),
    [
      ["project-local:config", "project-local", join(project.localConfigDir, "config.json")],
      ["project:config", "project", join(project.sharedConfigDir, "config.json")],
      ["user:config", "user", join(configDir, "config.json")],
    ],
  );

  await writeFile(join(project.sharedConfigDir, "config.json"), JSON.stringify({ port: 9000 }));
  const illegal = await resolveProjectGeneralConfig(project, { env: {} });
  assert.equal(illegal.values.port, 7100);
  assert.equal(illegal.diagnostics[0]?.source.scope, "project");
  assert.equal(illegal.diagnostics[0]?.code, "invalid_source");
});

test("invalid Project Local JSON becomes a source diagnostic without reactivating a partial value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-project-source-invalid-test-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(projectRoot);

  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(project.sharedConfigDir, { recursive: true });
  await mkdir(project.localConfigDir, { recursive: true });
  await writeFile(join(project.sharedConfigDir, "config.json"), JSON.stringify({ value: "project" }));
  await writeFile(join(project.localConfigDir, "config.json"), "{\"value\":\"secret-sentinel\",\n");

  const sources = await loadProjectConfigSources(project, {
    domain: "project-source-test",
    fileName: "config.json",
  });
  const resolved = resolveConfigDomain({ definition: precedenceDefinition, sources });

  assert.equal(resolved.values.value, "project");
  assert.equal(resolved.diagnostics[0]?.source.scope, "project-local");
  assert.equal(resolved.diagnostics[0]?.code, "invalid_source");
  assert.doesNotMatch(JSON.stringify(resolved.diagnostics), /secret-sentinel/);
});

async function createGitProject(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "hello\n");
  await git(path, ["init"]);
  await git(path, ["config", "user.email", "forgerelay@example.com"]);
  await git(path, ["config", "user.name", "ForgeRelay Test"]);
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "Initial commit"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
