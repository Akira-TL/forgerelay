import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  installManagedLanguageServers,
  installedManagedLanguageServers,
  managedLanguageServerBinDir,
  managedLanguageServerPackages,
  managedLanguageServerRoot,
  withManagedLanguageServerPath,
} from "./managed-language-servers.js";
import {
  callOpen,
  createCodeIntelligenceServerFixture,
  structuredContent,
} from "../test-support/server-fixture.js";

const fakeServerPath = fileURLToPath(new URL("../test-fixtures/fake-lsp-server.mjs", import.meta.url));

test("managed Language Servers use a private config-local npm prefix", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "forgerelay-managed-lsp-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  assert.equal(managedLanguageServerRoot(configDir), join(configDir, "language-servers"));
  assert.equal(managedLanguageServerBinDir(configDir), join(configDir, "language-servers", "node_modules", ".bin"));
  const env = withManagedLanguageServerPath({ PATH: "/usr/bin" }, configDir);
  assert.equal(env.PATH?.split(delimiter)[0], managedLanguageServerBinDir(configDir));
  assert.deepEqual(
    withManagedLanguageServerPath({ PATH: "/usr/bin", FORGERELAY_TEST: "1" }, undefined),
    { PATH: "/usr/bin", FORGERELAY_TEST: "1" },
  );
  assert.deepEqual(managedLanguageServerPackages(["typescript", "pyright"]), [
    "typescript-language-server@6",
    "typescript@6",
    "pyright@1",
  ]);

  let npmArgs: string[] | undefined;
  const installed = await installManagedLanguageServers(["typescript"], configDir, async (args) => {
    npmArgs = args;
    const bin = managedLanguageServerBinDir(configDir);
    const root = managedLanguageServerRoot(configDir);
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, "node_modules", "typescript-language-server"), { recursive: true });
    await mkdir(join(root, "node_modules", "typescript", "lib"), { recursive: true });
    await writeFile(join(bin, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server"), "stub");
    await writeFile(join(root, "node_modules", "typescript-language-server", "package.json"), JSON.stringify({ version: "6.0.0" }));
    await writeFile(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ version: "6.0.3" }));
    await writeFile(join(root, "node_modules", "typescript", "lib", "tsserver.js"), "stub");
  });
  assert.deepEqual(installed.installed, ["typescript"]);
  assert.ok(npmArgs?.includes("--prefix"));
  assert.ok(npmArgs?.includes("typescript-language-server@6"));
  assert.ok(npmArgs?.includes("typescript@6"));
  assert.deepEqual(installedManagedLanguageServers(configDir), ["typescript"]);
});

test("Agent-managed install is permission-gated and dynamically available without restarting ForgeRelay", async (t) => {
  const blocked = await createCodeIntelligenceServerFixture(t, {
    managedLanguageServerInstaller: async () => {
      throw new Error("installer should not run while permission is disabled");
    },
  });
  await mkdir(join(blocked.project, "src"), { recursive: true });
  await writeFile(join(blocked.project, "tsconfig.json"), "{}\n");
  await writeFile(join(blocked.project, "src", "main.ts"), "const value = 1;\n");
  const blockedOpen = await callOpen(blocked.client, blocked.project, "managed-lsp-blocked");
  const blockedWorkspaceId = String(structuredContent(blockedOpen).workspaceId);
  const blockedInstall = await blocked.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: blockedWorkspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "managed.install", servers: ["typescript"] },
    },
  });
  assert.equal(blockedInstall.isError, true);
  assert.match(JSON.stringify(blockedInstall.structuredContent), /code\.managed_install_disabled/);
  await blocked.close();

  const context = await createCodeIntelligenceServerFixture(t, {
    allowAgentLanguageServerInstall: true,
    managedLanguageServerInstaller: async (ids, configDir) => {
      const bin = managedLanguageServerBinDir(configDir);
      const root = managedLanguageServerRoot(configDir);
      const fakeLogPath = join(configDir, "managed-typescript-fake-lsp.log");
      await mkdir(bin, { recursive: true });
      await mkdir(join(root, "node_modules", "typescript-language-server"), { recursive: true });
      await mkdir(join(root, "node_modules", "typescript", "lib"), { recursive: true });
      await writeFile(
        join(root, "node_modules", "typescript-language-server", "package.json"),
        JSON.stringify({ version: "6.0.0" }),
      );
      await writeFile(
        join(root, "node_modules", "typescript", "package.json"),
        JSON.stringify({ version: "6.0.3" }),
      );
      await writeFile(join(root, "node_modules", "typescript", "lib", "tsserver.js"), "stub\n");
      const executable = join(
        bin,
        process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server",
      );
      if (process.platform === "win32") {
        await writeFile(
          executable,
          `@set \"FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE=pull\"\r\n@set \"FORGERELAY_FAKE_LSP_LOG=${fakeLogPath}\"\r\n@\"${process.execPath}\" \"${fakeServerPath}\" %*\r\n`,
        );
      } else {
        await writeFile(
          executable,
          `#!/bin/sh\nexport FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE=pull\nexport FORGERELAY_FAKE_LSP_LOG=\"${fakeLogPath}\"\nexec \"${process.execPath}\" \"${fakeServerPath}\" \"$@\"\n`,
        );
        await chmod(executable, 0o755);
      }
      return {
        installed: [...ids],
        packages: managedLanguageServerPackages(ids),
        root: managedLanguageServerRoot(configDir),
      };
    },
  });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(context.project, "src", "main.ts"), "const value = 1;\n");
  const opened = await callOpen(context.client, context.project, "managed-lsp-live");
  const workspaceId = String(structuredContent(opened).workspaceId);

  const unavailable = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "diagnostics", path: "src/main.ts" },
    },
  });
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable.structuredContent), /code\.language_service_unavailable/);

  const statusBefore = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "managed.status" },
    },
  });
  assert.deepEqual(
    (structuredContent(statusBefore).result as { installed: string[] }).installed,
    [],
  );

  const installed = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "managed.install", servers: ["typescript"] },
    },
  });
  assert.equal(installed.isError, undefined);
  assert.equal(
    (structuredContent(installed).result as { restartRequired: boolean }).restartRequired,
    false,
  );

  const diagnostics = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "diagnostics", path: "src/main.ts" },
    },
  });
  assert.equal(diagnostics.isError, undefined);
  const result = structuredContent(diagnostics).result as {
    selectedServer: string;
    diagnostics: Array<{ message: string }>;
  };
  assert.equal(result.selectedServer, "typescript");
  assert.match(result.diagnostics[0]?.message ?? "", /diagnostic|pulled diagnostic/);

  const managedRoot = managedLanguageServerRoot(context.config.configDir);
  const fakeLogPath = join(context.config.configDir, "managed-typescript-fake-lsp.log");
  const firstLog = (await readFile(fakeLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { pid: number; method?: string; params?: any });
  const firstInitialize = firstLog.find((event) => event.method === "initialize");
  assert.deepEqual(firstInitialize?.params?.initializationOptions, {
    tsserver: {
      path: join(managedRoot, "node_modules", "typescript", "lib", "tsserver.js"),
    },
  });

  await writeFile(
    join(managedRoot, "node_modules", "typescript-language-server", "package.json"),
    JSON.stringify({ version: "6.0.1" }),
  );
  const diagnosticsAfterRuntimeUpdate = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "diagnostics", path: "src/main.ts" },
    },
  });
  assert.equal(diagnosticsAfterRuntimeUpdate.isError, undefined);

  const updatedLog = (await readFile(fakeLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { pid: number; method?: string });
  const initializeEvents = updatedLog.filter((event) => event.method === "initialize");
  assert.equal(initializeEvents.length, 2);
  assert.notEqual(initializeEvents[0]?.pid, initializeEvents[1]?.pid);
});
