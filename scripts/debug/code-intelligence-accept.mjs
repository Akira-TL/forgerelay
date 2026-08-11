import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function setupCodeIntelligenceProject({ root, fakeLanguageServer, logPath }) {
  mkdirSync(join(root, ".forgerelay"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "tsconfig.json"), "{}\n", "utf8");
  writeFileSync(
    join(root, "src", "main.ts"),
    [
      "const value = target();",
      "class Widget {",
      "  runMethod() {}",
      "  stopMethod() {}",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "src", "target.ts"), "export const target = () => 1;\n", "utf8");
  writeFileSync(
    join(root, ".forgerelay", "language-servers.json"),
    `${JSON.stringify({
      "debug-fake": {
        command: process.execPath,
        args: [fakeLanguageServer],
        env: {
          FORGERELAY_FAKE_LSP_LOG: logPath,
          FORGERELAY_FAKE_LSP_HOVER_TEXT: "**debug target**: `() => void`",
          FORGERELAY_FAKE_LSP_REFERENCE_COUNT: "2",
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_DIAGNOSTIC_COUNT: "2",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

export function exerciseCodeIntelligence({ callTool, accessToken, sessionId, workspaceId, pass }) {
  const run = (id, argumentsValue) => callTool(accessToken, sessionId, id, "capability", {
    workspaceId,
    name: "code.intelligence",
    action: "run",
    arguments: argumentsValue,
  });

  const definition = run(90, {
    operation: "definition",
    path: "src/main.ts",
    line: 1,
    column: 15,
  });
  assert.equal(definition.isError, undefined);
  const definitionResult = definition.structuredContent.result;
  assert.equal(definitionResult.operation, "definition");
  assert.equal(definitionResult.selectedServer, "debug-fake");
  assert.deepEqual(definitionResult.locations, [{
    path: "src/target.ts",
    external: false,
    range: {
      start: { line: 1, column: 8 },
      end: { line: 1, column: 14 },
    },
  }]);

  const hover = run(91, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  });
  assert.equal(hover.isError, undefined);
  assert.equal(hover.structuredContent.result.operation, "hover");
  assert.equal(hover.structuredContent.result.contents, "**debug target**: `() => void`");
  assert.deepEqual(hover.structuredContent.result.range, {
    start: { line: 1, column: 15 },
    end: { line: 1, column: 21 },
  });

  const references = run(92, {
    operation: "references",
    path: "src/main.ts",
    line: 1,
    column: 15,
  });
  assert.equal(references.isError, undefined);
  assert.equal(references.structuredContent.result.operation, "references");
  assert.equal(references.structuredContent.result.returned, 2);
  assert.equal(references.structuredContent.result.total, 2);
  assert.equal(references.structuredContent.result.truncated, false);
  assert.ok(references.structuredContent.result.locations.every((location) =>
    location.path === "src/target.ts" && location.external === false
  ));

  const documentSymbols = run(93, {
    operation: "documentSymbols",
    path: "src/main.ts",
  });
  assert.equal(documentSymbols.isError, undefined);
  const documentSymbolsResult = documentSymbols.structuredContent.result;
  assert.equal(documentSymbolsResult.operation, "documentSymbols");
  assert.equal(documentSymbolsResult.hierarchical, true);
  assert.equal(documentSymbolsResult.returned, 3);
  assert.equal(documentSymbolsResult.symbols[0].name, "Widget");
  assert.deepEqual(
    documentSymbolsResult.symbols[0].children.map((symbol) => symbol.name),
    ["run", "stop"],
  );

  const workspaceSymbols = run(94, {
    operation: "workspaceSymbols",
    path: "src/main.ts",
    query: "Target",
  });
  assert.equal(workspaceSymbols.isError, undefined);
  const workspaceSymbolsResult = workspaceSymbols.structuredContent.result;
  assert.equal(workspaceSymbolsResult.operation, "workspaceSymbols");
  assert.equal(workspaceSymbolsResult.returned, 1);
  assert.equal(workspaceSymbolsResult.symbols[0].name, "Target");
  assert.equal(workspaceSymbolsResult.symbols[0].location.path, "src/target.ts");
  assert.equal(workspaceSymbolsResult.symbols[0].location.external, false);

  const diagnostics = run(95, {
    operation: "diagnostics",
    path: "src/main.ts",
  });
  assert.equal(diagnostics.isError, undefined);
  const diagnosticsResult = diagnostics.structuredContent.result;
  assert.equal(diagnosticsResult.operation, "diagnostics");
  assert.equal(diagnosticsResult.provider, "pull");
  assert.equal(diagnosticsResult.returned, 2);
  assert.equal(diagnosticsResult.total, 2);
  assert.equal(diagnosticsResult.freshness.state, "fresh");
  assert.deepEqual(
    diagnosticsResult.diagnostics.map((diagnostic) => diagnostic.message),
    ["pulled diagnostic 1", "pulled diagnostic 2"],
  );

  const invalidPosition = run(96, {
    operation: "definition",
    path: "src/main.ts",
    line: 99,
    column: 1,
  });
  assert.equal(invalidPosition.isError, true);
  assert.equal(invalidPosition.structuredContent.error.code, "code.invalid_position");
  pass(
    "code intelligence execution",
    "definition + hover + references + document/workspace symbols + diagnostics + stable error over OAuth/MCP",
  );
}

export function assertCodeIntelligenceShutdown({ logPath, pass }) {
  const events = readFileSync(logPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const shutdownIndex = events.findIndex((event) => event.method === "shutdown");
  const exitIndex = events.findIndex((event, index) => index > shutdownIndex && event.method === "exit");
  assert.ok(shutdownIndex >= 0, "code-intelligence Language server did not receive shutdown");
  assert.ok(exitIndex > shutdownIndex, "code-intelligence Language server did not receive exit after shutdown");
  pass("code intelligence shutdown", "Language service received shutdown -> exit during ForgeRelay server shutdown");
}
