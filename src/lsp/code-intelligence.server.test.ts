import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  callOpen,
  createCodeIntelligenceServerFixture as fixture,
  structuredContent,
} from "./test-support/server-fixture.js";

test("code.intelligence definition resolves through a real stdio LSP child process", async (t) => {
  const context = await fixture(t);
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(sourceDir, "main.ts"), "const 😀value = target();\n");
  await writeFile(join(sourceDir, "target.ts"), "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "typescript-test": {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_LOG: fakeLogPath },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-definition-chat");
  const openedStructured = structuredContent(opened);
  const catalog = openedStructured.capabilityCatalog as Array<{ name: string }>;
  assert.ok(catalog.some((entry) => entry.name === "code.intelligence"));
  const workspaceId = openedStructured.workspaceId as string;

  const result = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: {
        operation: "definition",
        path: "src/main.ts",
        line: 1,
        column: 8,
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(structuredContent(result), {
    name: "code.intelligence",
    action: "run",
    result: {
      operation: "definition",
      selectedServer: "typescript-test",
      projectRoot: ".",
      locations: [{
        path: "src/target.ts",
        external: false,
        range: {
          start: { line: 1, column: 8 },
          end: { line: 1, column: 14 },
        },
      }],
    },
  });

  await context.close();
  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.ok(fakeLog.includes('"method":"initialize"'));
  assert.ok(fakeLog.includes('"synchronization":{"dynamicRegistration":false'));
  assert.ok(fakeLog.includes('"definition":{"dynamicRegistration":false,"linkSupport":true}'));
  assert.ok(fakeLog.includes('"method":"textDocument/didOpen"'));
  assert.ok(fakeLog.includes('"method":"textDocument/definition"'));
  assert.ok(fakeLog.includes('"position":{"line":0,"character":8}'));
  assert.ok(fakeLog.includes('"method":"shutdown"'));
  assert.ok(fakeLog.includes('"method":"exit"'));
});

test("code.intelligence hover normalizes markdown through the shared stdio LSP path", async (t) => {
  const context = await fixture(t);
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-hover.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(sourceDir, "main.ts"), "const value = target();\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "typescript-test": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: fakeLogPath,
          FORGERELAY_FAKE_LSP_HOVER_MODE: "markdown",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-hover-chat");
  const result = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(opened).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: {
        operation: "hover",
        path: "src/main.ts",
        line: 1,
        column: 15,
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(structuredContent(result), {
    name: "code.intelligence",
    action: "run",
    result: {
      operation: "hover",
      selectedServer: "typescript-test",
      projectRoot: ".",
      contents: "**target**: `() => void`",
      range: {
        start: { line: 1, column: 15 },
        end: { line: 1, column: 21 },
      },
    },
  });

  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.ok(fakeLog.includes('\"method\":\"textDocument/hover\"'));
  assert.ok(fakeLog.includes('\"hover\":{\"dynamicRegistration\":false'));
});

test("code.intelligence reports unsupported hover without destabilizing the shared Language service", async (t) => {
  const context = await fixture(t);
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-hover-unsupported.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(context.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(join(context.project, "src", "target.ts"), "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: fakeLogPath,
          FORGERELAY_FAKE_LSP_HOVER_MODE: "unsupported",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-hover-unsupported");
  const workspaceId = structuredContent(opened).workspaceId;
  const hover = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "hover", path: "src/main.ts", line: 1, column: 15 },
    },
  });
  assert.equal(hover.isError, true);
  assert.equal((structuredContent(hover).error as { code?: string }).code, "code.operation_unsupported");

  const definition = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 15 },
    },
  });
  assert.equal(definition.isError, undefined);
  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.equal(fakeLog.match(/\"method\":\"initialize\"/g)?.length, 1);
  assert.ok(fakeLog.includes('\"method\":\"textDocument/definition\"'));
});

test("code.intelligence shares one Language service across logical workspaces for the same project", async (t) => {
  const context = await fixture(t);
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-shared.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(sourceDir, "main.ts"), "const value = target();\n");
  await writeFile(join(sourceDir, "target.ts"), "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "typescript-test": {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_LOG: fakeLogPath },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const first = await callOpen(context.client, context.project, "code-intelligence-shared-a");
  const second = await callOpen(context.client, context.project, "code-intelligence-shared-b");
  const workspaceIds = [structuredContent(first).workspaceId, structuredContent(second).workspaceId] as string[];
  assert.notEqual(workspaceIds[0], workspaceIds[1]);

  const results = await Promise.all(workspaceIds.map((workspaceId) => context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 15 },
    },
  })));
  for (const result of results) assert.equal(result.isError, undefined);

  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.equal(fakeLog.match(/"method":"initialize"/g)?.length, 1);
  assert.equal(fakeLog.match(/"method":"textDocument\/didOpen"/g)?.length, 1);
  assert.equal(fakeLog.match(/"method":"textDocument\/definition"/g)?.length, 2);
});

test("code.intelligence enforces Language service capacity while an existing service is active", async (t) => {
  const context = await fixture(t, { codeIntelligenceOptions: { maxServices: 1 } });
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  for (const projectName of ["frontend", "backend"]) {
    const projectRoot = join(context.project, projectName);
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "tsconfig.json"), "{}\n");
    await writeFile(join(projectRoot, "src", "main.ts"), "const value = target();\n");
    await writeFile(join(projectRoot, "src", "target.ts"), "export target;\n");
  }
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_DEFINITION_DELAY_MS: "250" },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-capacity");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const results = await Promise.all(["frontend", "backend"].map((projectName) => context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: {
        operation: "definition",
        path: `${projectName}/src/main.ts`,
        line: 1,
        column: 15,
      },
    },
  })));

  const successes = results.filter((result) => result.isError !== true);
  const failures = results.filter((result) => result.isError === true);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(
    (structuredContent(failures[0]!).error as { code?: string }).code,
    "code.language_service_capacity",
  );
});

test("code.intelligence keeps nested Language projects in distinct shared services", async (t) => {
  const context = await fixture(t);
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-nested.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  for (const projectName of ["frontend", "backend"]) {
    const projectRoot = join(context.project, projectName);
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(join(projectRoot, "tsconfig.json"), "{}\n");
    await writeFile(join(projectRoot, "src", "main.ts"), "const value = target();\n");
    await writeFile(join(projectRoot, "src", "target.ts"), "export target;\n");
  }
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_LOG: fakeLogPath },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-nested");
  const workspaceId = structuredContent(opened).workspaceId as string;
  for (const projectName of ["frontend", "backend"]) {
    const result = await context.client.callTool({
      name: "capability",
      arguments: {
        workspaceId,
        name: "code.intelligence",
        action: "run",
        arguments: {
          operation: "definition",
          path: `${projectName}/src/main.ts`,
          line: 1,
          column: 15,
        },
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal((structuredContent(result).result as { projectRoot?: string }).projectRoot, projectName);
  }

  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.equal(fakeLog.match(/"method":"initialize"/g)?.length, 2);
});

test("code.intelligence normalizes LocationLink results and marks External code locations without expanding file authority", async (t) => {
  const context = await fixture(t);
  const outside = await mkdtemp(join(homedir(), ".forgerelay-code-intelligence-external-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const externalTarget = join(outside, "target.ts");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(sourceDir, "main.ts"), "const value = target();\n");
  await writeFile(externalTarget, "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "typescript-test": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_MODE: "location-link",
          FORGERELAY_FAKE_LSP_TARGET: externalTarget,
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-external-chat");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const result = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 15 },
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(structuredContent(result).result, {
    operation: "definition",
    selectedServer: "typescript-test",
    projectRoot: ".",
    locations: [{
      path: externalTarget,
      external: true,
      range: {
        start: { line: 1, column: 8 },
        end: { line: 1, column: 14 },
      },
    }],
  });

  const externalRead = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: externalTarget },
  });
  assert.equal(externalRead.isError, true);
});

test("code.intelligence honors incremental text-document synchronization", async (t) => {
  const context = await fixture(t);
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-incremental.log");
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(sourceDir, "main.ts"), "const value = target();\n");
  await writeFile(join(sourceDir, "target.ts"), "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: fakeLogPath,
          FORGERELAY_FAKE_LSP_SYNC_KIND: "2",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-incremental");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const callDefinition = () => context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 15 },
    },
  });

  assert.equal((await callDefinition()).isError, undefined);
  await writeFile(join(sourceDir, "main.ts"), "const value = target();\nconst next = 1;\n");
  assert.equal((await callDefinition()).isError, undefined);

  const events = (await readFile(fakeLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  const change = events.find((event) => event.method === "textDocument/didChange");
  assert.ok(change);
  const contentChanges = (change.params?.contentChanges ?? []) as Array<Record<string, unknown>>;
  assert.equal(contentChanges.length, 1);
  assert.deepEqual(contentChanges[0]?.range, {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 0 },
  });
  assert.equal(contentChanges[0]?.text, "const value = target();\nconst next = 1;\n");
});

test("code.intelligence rejects Language-server initiated workspace edits", async (t) => {
  const context = await fixture(t);
  const sourceDir = join(context.project, "src");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-apply-edit.log");
  const sourcePath = join(sourceDir, "main.ts");
  const originalSource = "const value = target();\n";
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(sourcePath, originalSource);
  await writeFile(join(sourceDir, "target.ts"), "export target;\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: fakeLogPath,
          FORGERELAY_FAKE_LSP_MODE: "request-apply-edit",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-apply-edit");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const result = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 15 },
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(sourcePath, "utf8"), originalSource);

  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.ok(fakeLog.includes('"id":700'));
  assert.ok(fakeLog.includes('"code":-32601'));
});

test("code.intelligence reports stable unavailable, unsupported, invalid-position, start-failure, and start-timeout errors", async (t) => {
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));

  const unavailable = await fixture(t);
  await mkdir(join(unavailable.project, ".forgerelay"), { recursive: true });
  await mkdir(join(unavailable.project, "src"), { recursive: true });
  await writeFile(join(unavailable.project, "tsconfig.json"), "{}\n");
  await writeFile(join(unavailable.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(
    join(unavailable.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({ typescript: { enabled: false } }) + "\n",
  );
  const unavailableOpen = await callOpen(unavailable.client, unavailable.project, "code-unavailable");
  const unavailableResult = await unavailable.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(unavailableOpen).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 1 },
    },
  });
  assert.equal(unavailableResult.isError, true);
  assert.equal((structuredContent(unavailableResult).error as { code?: string }).code, "code.language_service_unavailable");

  for (const scenario of [
    { name: "unsupported", mode: "unsupported-definition", expected: "code.operation_unsupported", line: 1, column: 1 },
    { name: "invalid-position", mode: "location", expected: "code.invalid_position", line: 0, column: 1 },
  ] as const) {
    const context = await fixture(t);
    await mkdir(join(context.project, ".forgerelay"), { recursive: true });
    await mkdir(join(context.project, "src"), { recursive: true });
    await writeFile(join(context.project, "tsconfig.json"), "{}\n");
    await writeFile(join(context.project, "src", "main.ts"), "const value = target();\n");
    await writeFile(join(context.project, "src", "target.ts"), "export target;\n");
    await writeFile(
      join(context.project, ".forgerelay", "language-servers.json"),
      JSON.stringify({
        test: {
          command: process.execPath,
          args: [fakeServerPath],
          env: { FORGERELAY_FAKE_LSP_MODE: scenario.mode },
          languages: ["typescript"],
          extensions: [".ts"],
          projectMarkers: ["tsconfig.json"],
        },
      }) + "\n",
    );
    const opened = await callOpen(context.client, context.project, `code-${scenario.name}`);
    const result = await context.client.callTool({
      name: "capability",
      arguments: {
        workspaceId: structuredContent(opened).workspaceId,
        name: "code.intelligence",
        action: "run",
        arguments: {
          operation: "definition",
          path: "src/main.ts",
          line: scenario.line,
          column: scenario.column,
        },
      },
    });
    assert.equal(result.isError, true);
    assert.equal((structuredContent(result).error as { code?: string }).code, scenario.expected);
  }

  const failedStart = await fixture(t);
  await mkdir(join(failedStart.project, ".forgerelay"), { recursive: true });
  await mkdir(join(failedStart.project, "src"), { recursive: true });
  await writeFile(join(failedStart.project, "tsconfig.json"), "{}\n");
  await writeFile(join(failedStart.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(
    join(failedStart.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      missing: {
        command: join(failedStart.project, "definitely-missing-language-server"),
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
  const failedStartOpen = await callOpen(failedStart.client, failedStart.project, "code-start-failed");
  const failedStartResult = await failedStart.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(failedStartOpen).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 1 },
    },
  });
  assert.equal(failedStartResult.isError, true);
  assert.equal((structuredContent(failedStartResult).error as { code?: string }).code, "code.language_service_start_failed");

  const timedOut = await fixture(t, { codeIntelligenceOptions: { startTimeoutMs: 100 } });
  await mkdir(join(timedOut.project, ".forgerelay"), { recursive: true });
  await mkdir(join(timedOut.project, "src"), { recursive: true });
  await writeFile(join(timedOut.project, "tsconfig.json"), "{}\n");
  await writeFile(join(timedOut.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(
    join(timedOut.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      slow: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_MODE: "never-initialize" },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
  const timedOutOpen = await callOpen(timedOut.client, timedOut.project, "code-start-timeout");
  const timedOutResult = await timedOut.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(timedOutOpen).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "definition", path: "src/main.ts", line: 1, column: 1 },
    },
  });
  assert.equal(timedOutResult.isError, true);
  assert.equal((structuredContent(timedOutResult).error as { code?: string }).code, "code.language_service_start_timeout");
});
