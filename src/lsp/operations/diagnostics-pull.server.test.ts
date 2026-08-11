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

async function configureProject(
  project: string,
  diagnosticsMode: string,
  diagnosticCount = 1,
  logPath?: string,
): Promise<void> {
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "tsconfig.json"), "{}\n");
  await writeFile(join(project, "src", "main.ts"), "const value = target();\n");
  await writeFile(join(project, "src", "target.ts"), "export const target = () => 1;\n");
  await writeFile(
    join(project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: diagnosticsMode,
          FORGERELAY_FAKE_LSP_DIAGNOSTIC_COUNT: String(diagnosticCount),
          ...(logPath ? { FORGERELAY_FAKE_LSP_LOG: logPath } : {}),
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
}

async function callCode(
  context: Awaited<ReturnType<typeof createCodeIntelligenceServerFixture>>,
  workspaceId: string,
  argumentsValue: Record<string, unknown>,
) {
  return context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: argumentsValue,
    },
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test("pull-only diagnostics normalize into the shared diagnostics result contract", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "pull");
  const opened = await callOpen(context.client, context.project, "pull-diagnostics-basic");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const result = await callCode(context, workspaceId, { operation: "diagnostics", path: "src/main.ts" });
  assert.equal(result.isError, undefined);
  const normalized = structuredContent(result).result as any;
  assert.equal(normalized.provider, "pull");
  assert.equal(normalized.freshness.state, "fresh");
  assert.equal(normalized.freshness.documentVersion, 1);
  assert.deepEqual(normalized.diagnostics, [{
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    severity: "error",
    code: "P1",
    source: "fake-lsp",
    message: "pulled diagnostic 1",
  }]);
});

test("pull diagnostics reuse previousResultId when the server reports unchanged", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  const logPath = join(context.project, ".pull-diagnostics.log");
  await configureProject(context.project, "pull-unchanged", 1, logPath);
  const opened = await callOpen(context.client, context.project, "pull-diagnostics-unchanged");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const first = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  })).result as any;
  const second = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  })).result as any;

  assert.deepEqual(second.diagnostics, first.diagnostics);
  assert.equal(second.freshness.state, "fresh");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /"previousResultId":"pull-1"/);
});

test("mixed diagnostics prefer pull over concurrently published push snapshots", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "mixed");
  const opened = await callOpen(context.client, context.project, "pull-diagnostics-mixed");
  const workspaceId = structuredContent(opened).workspaceId as string;

  await callCode(context, workspaceId, { operation: "definition", path: "src/main.ts", line: 1, column: 15 });
  await settle();
  const result = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  })).result as any;

  assert.equal(result.provider, "pull");
  assert.equal(result.diagnostics[0].message, "pulled diagnostic 1");
});

test("pull diagnostics refresh against the newly synchronized filesystem version", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "pull");
  const opened = await callOpen(context.client, context.project, "pull-diagnostics-freshness");
  const workspaceId = structuredContent(opened).workspaceId as string;

  await callCode(context, workspaceId, { operation: "diagnostics", path: "src/main.ts" });
  await writeFile(join(context.project, "src", "main.ts"), "const changed = target();\n");
  const refreshed = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  })).result as any;

  assert.equal(refreshed.freshness.state, "fresh");
  assert.equal(refreshed.freshness.documentVersion, 2);
  assert.equal(refreshed.freshness.snapshotDocumentVersion, 2);
});

test("diagnostics report unsupported cleanly and bound oversized pull reports", async (t) => {
  const unsupported = await createCodeIntelligenceServerFixture(t);
  await configureProject(unsupported.project, "none");
  const unsupportedOpen = await callOpen(unsupported.client, unsupported.project, "diagnostics-unsupported");
  const unsupportedWorkspaceId = structuredContent(unsupportedOpen).workspaceId as string;
  await callCode(unsupported, unsupportedWorkspaceId, {
    operation: "definition",
    path: "src/main.ts",
    line: 1,
    column: 15,
  });
  await settle();
  const unsupportedResult = await callCode(unsupported, unsupportedWorkspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  });
  assert.equal(unsupportedResult.isError, true);
  assert.equal((structuredContent(unsupportedResult).error as any).code, "code.operation_unsupported");

  const bounded = await createCodeIntelligenceServerFixture(t);
  await configureProject(bounded.project, "pull", 1500);
  const boundedOpen = await callOpen(bounded.client, bounded.project, "diagnostics-pull-bounded");
  const boundedWorkspaceId = structuredContent(boundedOpen).workspaceId as string;
  const boundedResult = structuredContent(await callCode(bounded, boundedWorkspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
    limit: 1000,
  })).result as any;
  assert.equal(boundedResult.diagnostics.length, 1000);
  assert.equal(boundedResult.returned, 1000);
  assert.equal(boundedResult.total, 1500);
  assert.equal(boundedResult.truncated, true);
});
