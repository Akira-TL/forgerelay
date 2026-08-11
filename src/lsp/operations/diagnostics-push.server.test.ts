import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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

test("push diagnostics retain only the latest normalized snapshot", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "push-replace");
  const opened = await callOpen(context.client, context.project, "push-diagnostics-replace");
  const workspaceId = structuredContent(opened).workspaceId as string;

  await callCode(context, workspaceId, { operation: "definition", path: "src/main.ts", line: 1, column: 15 });
  await settle();
  const result = await callCode(context, workspaceId, { operation: "diagnostics", path: "src/main.ts" });

  assert.equal(result.isError, undefined);
  assert.deepEqual(structuredContent(result).result, {
    operation: "diagnostics",
    selectedServer: "test",
    projectRoot: ".",
    path: "src/main.ts",
    provider: "push",
    diagnostics: [{
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
      severity: "warning",
      code: "W2",
      source: "fake-lsp",
      message: "replacement diagnostic",
      tags: ["unnecessary"],
    }],
    returned: 1,
    truncated: false,
    total: 1,
    freshness: {
      state: "fresh",
      documentVersion: 1,
      snapshotDocumentVersion: 1,
      publishedVersion: 1,
    },
  });
});

test("push diagnostics become stale after a filesystem change until refreshed", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "push-stale");
  const opened = await callOpen(context.client, context.project, "push-diagnostics-stale");
  const workspaceId = structuredContent(opened).workspaceId as string;

  await callCode(context, workspaceId, { operation: "definition", path: "src/main.ts", line: 1, column: 15 });
  await settle();
  await writeFile(join(context.project, "src", "main.ts"), "const changed = target();\n");
  const result = await callCode(context, workspaceId, { operation: "diagnostics", path: "src/main.ts" });

  assert.equal((structuredContent(result).result as any).freshness.state, "stale");
  assert.equal((structuredContent(result).result as any).freshness.documentVersion, 2);
  assert.equal((structuredContent(result).result as any).freshness.publishedVersion, 1);
});

test("push diagnostics clearing replaces the prior snapshot with an empty fresh snapshot", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  await configureProject(context.project, "push-clear");
  const opened = await callOpen(context.client, context.project, "push-diagnostics-clear");
  const workspaceId = structuredContent(opened).workspaceId as string;

  await callCode(context, workspaceId, { operation: "definition", path: "src/main.ts", line: 1, column: 15 });
  await settle();
  await writeFile(join(context.project, "src", "main.ts"), "const changed = target();\n");
  await callCode(context, workspaceId, { operation: "definition", path: "src/main.ts", line: 1, column: 17 });
  await settle();
  const result = await callCode(context, workspaceId, { operation: "diagnostics", path: "src/main.ts" });
  const normalized = structuredContent(result).result as any;

  assert.deepEqual(normalized.diagnostics, []);
  assert.equal(normalized.total, 0);
  assert.equal(normalized.returned, 0);
  assert.equal(normalized.truncated, false);
  assert.equal(normalized.freshness.state, "fresh");
  assert.equal(normalized.freshness.publishedVersion, 2);
});

test("push diagnostic snapshots bound per-document items and cached document count", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      maxDiagnosticDocuments: 2,
      maxDiagnosticsPerDocument: 2,
    },
  });
  await configureProject(context.project, "push", 5);
  await writeFile(join(context.project, "src", "second.ts"), "export const second = 2;\n");
  await writeFile(join(context.project, "src", "third.ts"), "export const third = 3;\n");
  const opened = await callOpen(context.client, context.project, "push-diagnostics-bounds");
  const workspaceId = structuredContent(opened).workspaceId as string;

  for (const path of ["src/main.ts", "src/second.ts", "src/third.ts"]) {
    await callCode(context, workspaceId, { operation: "definition", path, line: 1, column: 1 });
    await settle();
  }

  const newest = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/third.ts",
  })).result as any;
  assert.equal(newest.diagnostics.length, 2);
  assert.equal(newest.total, 5);
  assert.equal(newest.truncated, true);

  const evicted = structuredContent(await callCode(context, workspaceId, {
    operation: "diagnostics",
    path: "src/main.ts",
  })).result as any;
  assert.deepEqual(evicted.diagnostics, []);
  assert.equal(evicted.freshness.state, "missing");
});
