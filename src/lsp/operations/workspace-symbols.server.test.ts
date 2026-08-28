import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  callOpen,
  createCodeIntelligenceServerFixture,
  structuredContent,
} from "../test-support/server-fixture.js";

async function setup(
  t: Parameters<typeof createCodeIntelligenceServerFixture>[0],
  mode: string,
  extraEnv: Record<string, string> = {},
) {
  const context = await createCodeIntelligenceServerFixture(t);
  const fakeServerPath = fileURLToPath(new URL("../test-fixtures/fake-lsp-server.mjs", import.meta.url));
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(context.project, "src", "main.ts"), "class Widget {}\n");
  await writeFile(join(context.project, "src", "target.ts"), "export class Target {}\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_WORKSPACE_SYMBOLS_MODE: mode, ...extraEnv },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
  const opened = await callOpen(context.client, context.project, `workspace-symbols-${mode}`);
  return { context, workspaceId: structuredContent(opened).workspaceId };
}

test("workspaceSymbols returns a bounded flat normalized result", async (t) => {
  const { context, workspaceId } = await setup(t, "large", {
    FORGERELAY_FAKE_LSP_WORKSPACE_SYMBOL_COUNT: "150",
  });
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "workspaceSymbols", path: "src/main.ts", query: "Target" },
    },
  });
  assert.equal(response.isError, undefined);
  const result = structuredContent(response).result as {
    symbols: Array<{ name: string; kind: string; location: { path: string; external: boolean } }>;
    total: number;
    returned: number;
    truncated: boolean;
  };
  assert.deepEqual(
    { total: result.total, returned: result.returned, truncated: result.truncated },
    { total: 150, returned: 100, truncated: true },
  );
  assert.equal(result.symbols.length, 100);
  assert.equal(result.symbols[0]?.name, "Target0");
  assert.equal(result.symbols[0]?.kind, "class");
  assert.equal(result.symbols[0]?.location.path, "src/target.ts");
  assert.equal(result.symbols[0]?.location.external, false);
});

test("workspaceSymbols supports explicit limits and empty results", async (t) => {
  const limited = await setup(t, "large", { FORGERELAY_FAKE_LSP_WORKSPACE_SYMBOL_COUNT: "12" });
  const limitedResponse = await limited.context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: limited.workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "workspaceSymbols", path: "src/main.ts", query: "Target", limit: 3 },
    },
  });
  const limitedResult = structuredContent(limitedResponse).result as {
    symbols: unknown[]; total: number; returned: number; truncated: boolean;
  };
  assert.deepEqual(
    { total: limitedResult.total, returned: limitedResult.returned, truncated: limitedResult.truncated },
    { total: 12, returned: 3, truncated: true },
  );

  const empty = await setup(t, "empty");
  const emptyResponse = await empty.context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: empty.workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "workspaceSymbols", path: "src/main.ts", query: "Nothing" },
    },
  });
  assert.equal(emptyResponse.isError, undefined);
  assert.deepEqual((structuredContent(emptyResponse).result as { symbols: unknown[]; total: number }).symbols, []);
  assert.equal((structuredContent(emptyResponse).result as { total: number }).total, 0);
});

test("workspaceSymbols reports unsupported server capability", async (t) => {
  const { context, workspaceId } = await setup(t, "unsupported");
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "workspaceSymbols", path: "src/main.ts", query: "Target" },
    },
  });
  assert.equal(response.isError, true);
  assert.equal((structuredContent(response).error as { code?: string }).code, "code.operation_unsupported");
});

test("workspaceSymbols preserves External location metadata", async (t) => {
  const outside = await mkdtemp(join(homedir(), ".forgerelay-workspace-symbol-external-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const externalTarget = join(outside, "dependency.ts");
  await writeFile(externalTarget, "export class Target {}\n");
  const { context, workspaceId } = await setup(t, "normal", {
    FORGERELAY_FAKE_LSP_TARGET: externalTarget,
  });
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "workspaceSymbols", path: "src/main.ts", query: "Target" },
    },
  });
  assert.equal(response.isError, undefined);
  const result = structuredContent(response).result as {
    symbols: Array<{ location: { path: string; external: boolean } }>;
  };
  assert.equal(result.symbols[0]?.location.path, await realpath(externalTarget));
  assert.equal(result.symbols[0]?.location.external, true);
});
