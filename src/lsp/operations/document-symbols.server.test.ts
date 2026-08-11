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

async function setup(t: Parameters<typeof createCodeIntelligenceServerFixture>[0], mode: string) {
  const context = await createCodeIntelligenceServerFixture(t);
  const fakeServerPath = fileURLToPath(new URL("../test-fixtures/fake-lsp-server.mjs", import.meta.url));
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(
    join(context.project, "src", "main.ts"),
    "class Widget {\n  run() {}\n  stop() {}\n}\nconst value = 1;\n",
  );
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_DOCUMENT_SYMBOLS_MODE: mode },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
  const opened = await callOpen(context.client, context.project, `document-symbols-${mode}`);
  return { context, workspaceId: structuredContent(opened).workspaceId };
}

test("documentSymbols preserves hierarchy and normalized symbol metadata", async (t) => {
  const { context, workspaceId } = await setup(t, "hierarchical");
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "documentSymbols", path: "src/main.ts" },
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(structuredContent(response).result, {
    operation: "documentSymbols",
    selectedServer: "test",
    projectRoot: ".",
    hierarchical: true,
    symbols: [{
      name: "Widget",
      kind: "class",
      detail: "class Widget",
      range: {
        start: { line: 1, column: 1 },
        end: { line: 4, column: 2 },
      },
      selectionRange: {
        start: { line: 1, column: 7 },
        end: { line: 1, column: 13 },
      },
      children: [
        {
          name: "run",
          kind: "method",
          range: { start: { line: 2, column: 3 }, end: { line: 2, column: 11 } },
          selectionRange: { start: { line: 2, column: 3 }, end: { line: 2, column: 6 } },
        },
        {
          name: "stop",
          kind: "method",
          range: { start: { line: 3, column: 3 }, end: { line: 3, column: 12 } },
          selectionRange: { start: { line: 3, column: 3 }, end: { line: 3, column: 7 } },
        },
      ],
    }],
    returned: 3,
    truncated: false,
    total: 3,
  });
});

test("documentSymbols keeps flat server responses flat", async (t) => {
  const { context, workspaceId } = await setup(t, "flat");
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "documentSymbols", path: "src/main.ts" },
    },
  });
  assert.equal(response.isError, undefined);
  const result = structuredContent(response).result as {
    hierarchical: boolean;
    symbols: Array<Record<string, unknown>>;
  };
  assert.equal(result.hierarchical, false);
  assert.equal(result.symbols.length, 2);
  assert.equal(result.symbols[0]?.name, "Widget");
  assert.equal(result.symbols[0]?.kind, "class");
  assert.equal("children" in (result.symbols[0] ?? {}), false);
  assert.equal("selectionRange" in (result.symbols[0] ?? {}), false);
});

test("documentSymbols bounds total tree nodes without dropping required ancestors", async (t) => {
  const { context, workspaceId } = await setup(t, "hierarchical");
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "documentSymbols", path: "src/main.ts", limit: 2 },
    },
  });
  assert.equal(response.isError, undefined);
  const result = structuredContent(response).result as {
    returned: number;
    truncated: boolean;
    total: number;
    symbols: Array<{ name: string; children?: Array<{ name: string }> }>;
  };
  assert.deepEqual(
    { returned: result.returned, truncated: result.truncated, total: result.total },
    { returned: 2, truncated: true, total: 3 },
  );
  assert.deepEqual(result.symbols.map((symbol) => symbol.name), ["Widget"]);
  assert.deepEqual(result.symbols[0]?.children?.map((symbol) => symbol.name), ["run"]);
});
