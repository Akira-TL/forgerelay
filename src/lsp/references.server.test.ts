import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  callOpen,
  createCodeIntelligenceServerFixture,
  structuredContent,
} from "./test-support/server-fixture.js";

test("code.intelligence references bounds large LSP results at the MCP seam", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  const fakeLogPath = join(context.project, ".fake-lsp-references.log");
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
          FORGERELAY_FAKE_LSP_REFERENCE_COUNT: "150",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-references");
  const workspaceId = structuredContent(opened).workspaceId;
  const bounded = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "references", path: "src/main.ts", line: 1, column: 15 },
    },
  });
  assert.equal(bounded.isError, undefined);
  const boundedResult = structuredContent(bounded).result as {
    locations: unknown[];
    total: number;
    returned: number;
    truncated: boolean;
  };
  assert.equal(boundedResult.total, 150);
  assert.equal(boundedResult.returned, 100);
  assert.equal(boundedResult.truncated, true);
  assert.equal(boundedResult.locations.length, 100);

  const limited = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "references", path: "src/main.ts", line: 1, column: 15, limit: 3 },
    },
  });
  assert.equal(limited.isError, undefined);
  const limitedResult = structuredContent(limited).result as {
    locations: unknown[];
    total: number;
    returned: number;
    truncated: boolean;
  };
  assert.deepEqual(
    { total: limitedResult.total, returned: limitedResult.returned, truncated: limitedResult.truncated },
    { total: 150, returned: 3, truncated: true },
  );
  assert.equal(limitedResult.locations.length, 3);

  const fakeLog = await readFile(fakeLogPath, "utf8");
  assert.ok(fakeLog.includes('"method":"textDocument/references"'));
  assert.ok(fakeLog.includes('"includeDeclaration":true'));
});

test("code.intelligence references preserve External location metadata", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  const outside = await mkdtemp(join(homedir(), ".forgerelay-references-external-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const externalTarget = join(outside, "dependency.ts");
  await writeFile(externalTarget, "export target;\n");
  const fakeServerPath = fileURLToPath(new URL("./test-fixtures/fake-lsp-server.mjs", import.meta.url));
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(context.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      test: {
        command: process.execPath,
        args: [fakeServerPath],
        env: { FORGERELAY_FAKE_LSP_TARGET: externalTarget },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );

  const opened = await callOpen(context.client, context.project, "code-intelligence-references-external");
  const response = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(opened).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "references", path: "src/main.ts", line: 1, column: 15 },
    },
  });
  assert.equal(response.isError, undefined);
  const result = structuredContent(response).result as { locations: Array<{ path: string; external: boolean }> };
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0]?.path, await realpath(externalTarget));
  assert.equal(result.locations[0]?.external, true);
});

test("code.intelligence rejects references limits above the hard maximum", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t);
  const opened = await callOpen(context.client, context.project, "code-intelligence-references-limit");
  const result = await context.client.callTool({
    name: "capability",
    arguments: {
      workspaceId: structuredContent(opened).workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: { operation: "references", path: "src/main.ts", line: 1, column: 1, limit: 1001 },
    },
  });
  assert.equal(result.isError, true);
  assert.equal((structuredContent(result).error as { code?: string }).code, "invalid_arguments");
});
