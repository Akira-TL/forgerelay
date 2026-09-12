import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { ProjectContextResolver } from "../workspaces/state/project-context.js";
import { resolveLanguageServersConfig } from "../runtime/config/resolution/language-servers.js";
import {
  LanguageServerConfigurationError,
  resolveLanguageProject,
  type LanguageServerConfigInput,
} from "./language-server-config.js";

test("project Language-server definition beats global configuration and resolves the nearest project marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "frontend");
  const sourcePath = join(projectRoot, "src", "main.ts");
  await mkdir(join(root, ".forgerelay"), { recursive: true });
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(projectRoot, "tsconfig.json"), "{}\n");
  await writeFile(sourcePath, "const value = 1;\n");
  await writeFile(
    join(root, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "project-ts": {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );

  const resolved = await resolveLanguageProject({
    workspaceRoot: root,
    sourcePath: "frontend/src/main.ts",
    globalConfig: {
      "global-ts": {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    },
  });

  assert.equal(resolved.definition.id, "project-ts");
  assert.equal(resolved.definition.source, "project");
  assert.equal(resolved.projectRoot, await realpath(projectRoot));
});

test("Project Local canonical Language-server config outranks project and user definitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".forgerelay"), { recursive: true });
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(projectRoot, "src", "main.ts"), "const value = 1;\n");

  const definition = (command: string) => ({
    command,
    languages: ["typescript"],
    extensions: [".ts"],
  });
  await writeFile(
    join(configDir, "language-servers.json"),
    JSON.stringify({ selected: definition("user-lsp") }) + "\n",
  );
  await writeFile(
    join(projectRoot, ".forgerelay", "language-servers.json"),
    JSON.stringify({ selected: definition("project-lsp") }) + "\n",
  );
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(project.localConfigDir, { recursive: true });
  await writeFile(
    join(project.localConfigDir, "language-servers.json"),
    JSON.stringify({ selected: definition(process.execPath) }) + "\n",
  );

  const resolved = await resolveLanguageProject({
    workspaceRoot: projectRoot,
    sourcePath: "src/main.ts",
    configDir,
  });

  assert.equal(resolved.definition.id, "selected");
  assert.equal(resolved.definition.command, process.execPath);
  assert.equal(resolved.definition.source, "project-local");
});

test("Language Server env interpolation is field-limited and provenance never retains resolved secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-v2-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".forgerelay"), { recursive: true });
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(projectRoot, "src", "main.ts"), "const value = 1;\n");
  await writeFile(
    join(projectRoot, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      secure: {
        command: "${LSP_COMMAND}",
        env: { TOKEN: "${LSP_SECRET}" },
        languages: ["typescript"],
        extensions: [".ts"],
      },
    }) + "\n",
  );
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  const environment = { ...process.env, LSP_COMMAND: process.execPath, LSP_SECRET: "resolved-secret-sentinel" };
  const resolution = await resolveLanguageServersConfig({ configDir, project, environment });
  const serialized = JSON.stringify(resolution.entries);
  assert.doesNotMatch(serialized, /resolved-secret-sentinel/);
  assert.match(serialized, /\$\{LSP_SECRET\}/);

  const resolved = await resolveLanguageProject({
    workspaceRoot: projectRoot,
    sourcePath: "src/main.ts",
    configDir,
    env: environment,
  });
  assert.equal(resolved.definition.command, "${LSP_COMMAND}");
  assert.equal(resolved.definition.env.TOKEN, "resolved-secret-sentinel");
});

test("global explicit Language-server definition beats built-in discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  const builtinExecutable = join(bin, "typescript-language-server");
  await writeFile(builtinExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(builtinExecutable, 0o755);

  const resolved = await resolveLanguageProject({
    workspaceRoot: root,
    sourcePath: "src/main.ts",
    env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) },
    globalConfig: {
      "global-ts": {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    },
  });

  assert.equal(resolved.definition.id, "global-ts");
  assert.equal(resolved.definition.source, "global");
});

test("invalid canonical user Language Server config shadows legacy inline until deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-v2-shadow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  const canonicalPath = join(configDir, "language-servers.json");
  await writeFile(canonicalPath, JSON.stringify({ broken: { command: 42 } }) + "\n");
  const legacy: LanguageServerConfigInput = {
    legacy: {
      command: process.execPath,
      languages: ["typescript"],
      extensions: [".ts"],
    },
  };

  await assert.rejects(
    resolveLanguageProject({ workspaceRoot: root, sourcePath: "src/main.ts", configDir, globalConfig: legacy }),
    (error: unknown) => error instanceof LanguageServerConfigurationError && error.code === "code.configuration_invalid",
  );

  await unlink(canonicalPath);
  const resolved = await resolveLanguageProject({
    workspaceRoot: root,
    sourcePath: "src/main.ts",
    configDir,
    globalConfig: legacy,
  });
  assert.equal(resolved.definition.id, "legacy");
  assert.equal(resolved.definition.source, "global");
});

test("built-in TypeScript discovery maps JavaScript extensions to the correct LSP languageId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "jsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.js"), "const value = 1;\n");
  const builtinExecutable = join(
    bin,
    process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server",
  );
  await writeFile(
    builtinExecutable,
    process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  );
  if (process.platform !== "win32") await chmod(builtinExecutable, 0o755);

  const resolved = await resolveLanguageProject({
    workspaceRoot: root,
    sourcePath: "src/main.js",
    env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) },
  });

  assert.equal(resolved.definition.id, "typescript");
  assert.equal(resolved.definition.languageIdByExtension[".js"], "javascript");
  assert.equal(resolved.definition.languageIdByExtension[".tsx"], "typescriptreact");
});

test("explicit disable suppresses matching built-in Language-server discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(join(root, ".forgerelay"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  const builtinExecutable = join(bin, "typescript-language-server");
  await writeFile(builtinExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(builtinExecutable, 0o755);
  await writeFile(
    join(root, ".forgerelay", "language-servers.json"),
    JSON.stringify({ typescript: { enabled: false } }) + "\n",
  );

  await assert.rejects(
    resolveLanguageProject({
      workspaceRoot: root,
      sourcePath: "src/main.ts",
      env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) },
    }),
    (error: unknown) =>
      error instanceof LanguageServerConfigurationError &&
      error.code === "code.language_service_unavailable",
  );
});

test("canonical disabled tombstone masks the matching built-in Language Server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-v2-mask-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const bin = join(root, "bin");
  await mkdir(join(root, ".forgerelay"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  const builtinExecutable = join(bin, "typescript-language-server");
  await writeFile(builtinExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(builtinExecutable, 0o755);
  await writeFile(
    join(root, ".forgerelay", "language-servers.json"),
    JSON.stringify({ typescript: { disabled: true } }) + "\n",
  );

  await assert.rejects(
    resolveLanguageProject({
      workspaceRoot: root,
      sourcePath: "src/main.ts",
      configDir,
      env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) },
    }),
    (error: unknown) =>
      error instanceof LanguageServerConfigurationError &&
      error.code === "code.language_service_unavailable",
  );
});

test("same-priority matching Language-server definitions fail with stable ambiguity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".forgerelay"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  await writeFile(
    join(root, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      first: {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
      second: {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );

  await assert.rejects(
    resolveLanguageProject({ workspaceRoot: root, sourcePath: "src/main.ts" }),
    (error: unknown) =>
      error instanceof LanguageServerConfigurationError &&
      error.code === "code.configuration_ambiguous",
  );
});

test("Language project discovery preserves a symlinked Workspace alias by canonicalizing its root", { skip: process.platform === "win32" }, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "forgerelay-language-config-parent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "real-project");
  const alias = join(parent, "project-alias");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");
  await symlink(root, alias, "dir");

  const resolved = await resolveLanguageProject({
    workspaceRoot: alias,
    sourcePath: "src/main.ts",
    globalConfig: {
      test: {
        command: process.execPath,
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    },
  });

  assert.equal(resolved.projectRoot, await realpath(root));
});

test("Language project discovery rejects a source symlink that escapes the Workspace", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  const outside = await mkdtemp(join(tmpdir(), "forgerelay-language-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  await writeFile(join(outside, "secret.ts"), "export const secret = 1;\n");
  await symlink(join(outside, "secret.ts"), join(root, "src", "escape.ts"));

  await assert.rejects(
    resolveLanguageProject({
      workspaceRoot: root,
      sourcePath: "src/escape.ts",
      globalConfig: {
        test: {
          command: process.execPath,
          languages: ["typescript"],
          extensions: [".ts"],
          projectMarkers: ["tsconfig.json"],
        },
      },
    }),
    (error: unknown) =>
      error instanceof LanguageServerConfigurationError &&
      error.code === "code.language_service_unavailable",
  );
});

test("invalid global Language-server configuration is rejected before discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-language-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "const value = 1;\n");

  await assert.rejects(
    resolveLanguageProject({
      workspaceRoot: root,
      sourcePath: "src/main.ts",
      globalConfig: { broken: { command: 42 } } as never,
    }),
    (error: unknown) =>
      error instanceof LanguageServerConfigurationError &&
      error.code === "code.configuration_invalid",
  );
});
