import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  callOpen,
  createCodeIntelligenceServerFixture,
  structuredContent,
} from "../test-support/server-fixture.js";

const fakeServerPath = fileURLToPath(new URL("../test-fixtures/fake-lsp-server.mjs", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepareProject(project: string): Promise<void> {
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "tsconfig.json"), "{}\n");
  await writeFile(join(project, "pyproject.toml"), "[project]\nname='test'\nversion='0.0.0'\n");
  await writeFile(join(project, "src", "main.ts"), "const value = target();\n");
  await writeFile(join(project, "src", "target.ts"), "export const target = () => 1;\n");
  await writeFile(join(project, "src", "main.py"), "python_value_long_name = target()\n");
}

async function writeServerConfig(
  project: string,
  definitions: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(project, ".forgerelay", "language-servers.json"),
    JSON.stringify(definitions, null, 2) + "\n",
  );
}

function testDefinition(env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fakeServerPath],
    env,
    languages: ["typescript"],
    extensions: [".ts"],
    projectMarkers: ["tsconfig.json"],
  };
}

function capabilityCall(workspaceId: string, argumentsValue: Record<string, unknown>) {
  return {
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: argumentsValue,
    },
  } as const;
}

function countInitializations(log: string): number {
  return [...log.matchAll(/"method":"initialize"/g)].length;
}

test("one unexpected Language-server crash is retried once and the current request recovers", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: { crashCooldownMs: 150 },
  });
  await prepareProject(context.project);
  const crashStatePath = join(context.project, ".crash-once-state");
  const logPath = join(context.project, ".crash-once.log");
  await writeServerConfig(context.project, {
    test: testDefinition({
      FORGERELAY_FAKE_LSP_CRASH_MODE: "once",
      FORGERELAY_FAKE_LSP_CRASH_STATE_PATH: crashStatePath,
      FORGERELAY_FAKE_LSP_LOG: logPath,
    }),
  });
  const opened = await callOpen(context.client, context.project, "crash-once");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const result = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "references",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(result.isError, undefined);
  const log = await readFile(logPath, "utf8");
  assert.equal(countInitializations(log), 2);
});

test("repeated crashes enter cooldown and recover after the bounded cooldown", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: { crashCooldownMs: 1_500 },
  });
  await prepareProject(context.project);
  const crashStatePath = join(context.project, ".crash-twice-state");
  const logPath = join(context.project, ".crash-twice.log");
  await writeServerConfig(context.project, {
    test: testDefinition({
      FORGERELAY_FAKE_LSP_CRASH_MODE: "twice",
      FORGERELAY_FAKE_LSP_CRASH_STATE_PATH: crashStatePath,
      FORGERELAY_FAKE_LSP_CRASH_STDERR_BYTES: String(128 * 1024),
      FORGERELAY_FAKE_LSP_LOG: logPath,
    }),
  });
  const opened = await callOpen(context.client, context.project, "crash-twice");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const crashed = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "references",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(crashed.isError, true);
  const crashedError = structuredContent(crashed).error as { code?: string; message?: string };
  assert.equal(crashedError.code, "code.language_service_cooldown");
  assert.ok((crashedError.message?.length ?? 0) < 70_000, "stderr suffix must remain bounded");

  const duringCooldown = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(duringCooldown.isError, true);
  assert.equal((structuredContent(duringCooldown).error as { code?: string }).code, "code.language_service_cooldown");
  const beforeRecoveryLog = await readFile(logPath, "utf8");
  assert.equal(countInitializations(beforeRecoveryLog), 2);

  await pause(1_600);
  const recovered = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(recovered.isError, undefined);
  const afterRecoveryLog = await readFile(logPath, "utf8");
  assert.equal(countInitializations(afterRecoveryLog), 3);
});

test("a changed effective config fingerprint replaces only the affected Language service", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await prepareProject(context.project);
  const tsLog = join(context.project, ".config-ts.log");
  const pyLog = join(context.project, ".config-py.log");
  const pythonDefinition = {
    command: process.execPath,
    args: [fakeServerPath],
    env: {
      FORGERELAY_FAKE_LSP_HOVER_TEXT: "python-stable",
      FORGERELAY_FAKE_LSP_LOG: pyLog,
    },
    languages: ["python"],
    extensions: [".py"],
    projectMarkers: ["pyproject.toml"],
  };
  await writeServerConfig(context.project, {
    typescript: testDefinition({
      FORGERELAY_FAKE_LSP_HOVER_TEXT: "typescript-first",
      FORGERELAY_FAKE_LSP_LOG: tsLog,
    }),
    python: pythonDefinition,
  });
  const opened = await callOpen(context.client, context.project, "config-invalidation");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const tsFirst = structuredContent(await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover", path: "src/main.ts", line: 1, column: 15,
  }))).result as { contents?: string };
  const pyFirst = structuredContent(await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover", path: "src/main.py", line: 1, column: 9,
  }))).result as { contents?: string };
  assert.equal(tsFirst.contents, "typescript-first");
  assert.equal(pyFirst.contents, "python-stable");

  await writeServerConfig(context.project, {
    typescript: testDefinition({
      FORGERELAY_FAKE_LSP_HOVER_TEXT: "typescript-second",
      FORGERELAY_FAKE_LSP_LOG: tsLog,
    }),
    python: pythonDefinition,
  });

  const tsSecond = structuredContent(await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover", path: "src/main.ts", line: 1, column: 15,
  }))).result as { contents?: string };
  const pySecond = structuredContent(await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover", path: "src/main.py", line: 1, column: 9,
  }))).result as { contents?: string };
  assert.equal(tsSecond.contents, "typescript-second");
  assert.equal(pySecond.contents, "python-stable");

  assert.equal(countInitializations(await readFile(tsLog, "utf8")), 2);
  assert.equal(countInitializations(await readFile(pyLog, "utf8")), 1);
});
