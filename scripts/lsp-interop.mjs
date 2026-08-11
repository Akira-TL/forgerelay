import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeIntelligenceManager } from "../dist/lsp/runtime/manager.js";
import { findExecutable, probeExecutable } from "./lsp-interop-support.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const interopRoot = resolve(repoRoot, ".forgerelay-debug", "lsp-interop");
const fixtures = [
  {
    id: "typescript",
    command: "typescript-language-server",
    sourcePath: "src/main.ts",
    hover: { line: 1, column: 14 },
    setup(root) {
      write(root, "tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`);
      write(root, "src/main.ts", [
        "export class Widget {",
        "  run(): number { return 1; }",
        "  stop(): number { return 0; }",
        "}",
        "",
      ].join("\n"));
    },
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    sourcePath: "main.py",
    hover: { line: 1, column: 7 },
    setup(root) {
      write(root, "pyrightconfig.json", "{}\n");
      write(root, "main.py", [
        "class Widget:",
        "    def run(self) -> int:",
        "        return 1",
        "",
      ].join("\n"));
    },
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    sourcePath: "src/lib.rs",
    hover: { line: 1, column: 12 },
    setup(root) {
      write(root, "Cargo.toml", [
        "[package]",
        'name = "forgerelay-interop"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
      ].join("\n"));
      write(root, "src/lib.rs", [
        "pub struct Widget;",
        "impl Widget {",
        "    pub fn run(&self) -> i32 { 1 }",
        "}",
        "",
      ].join("\n"));
    },
  },
  {
    id: "gopls",
    command: "gopls",
    sourcePath: "main.go",
    hover: { line: 3, column: 6 },
    setup(root) {
      write(root, "go.mod", "module example.com/forgerelay-interop\n\ngo 1.22\n");
      write(root, "main.go", [
        "package interop",
        "",
        "type Widget struct{}",
        "",
        "func (Widget) Run() int { return 1 }",
        "",
      ].join("\n"));
    },
  },
  {
    id: "clangd",
    command: "clangd",
    sourcePath: "main.cpp",
    hover: { line: 1, column: 7 },
    setup(root) {
      write(root, "compile_flags.txt", "-std=c++17\n");
      write(root, "main.cpp", [
        "class Widget {",
        " public:",
        "  int run() const { return 1; }",
        "};",
        "",
      ].join("\n"));
    },
  },
];

rmSync(interopRoot, { recursive: true, force: true });

let passed = 0;
let skipped = 0;
const failures = [];

for (const fixture of fixtures) {
  const executable = findExecutable(fixture.command);
  if (!executable) {
    skipped += 1;
    console.log(`SKIP ${fixture.id}: ${fixture.command} not found on PATH; ForgeRelay does not install Language servers.`);
    continue;
  }
  const preflight = probeExecutable(executable);
  if (!preflight.available) {
    skipped += 1;
    console.log(`SKIP ${fixture.id}: ${executable} is present but not runnable: ${preflight.reason}`);
    continue;
  }

  const root = join(interopRoot, fixture.id);
  fixture.setup(root);
  const manager = new CodeIntelligenceManager(
    { languageServers: {} },
    {
      startTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
      idleMs: 60_000,
      cleanupIntervalMs: 60_000,
    },
  );

  try {
    const symbols = await manager.run(root, {
      operation: "documentSymbols",
      path: fixture.sourcePath,
      limit: 20,
    });
    assert.equal(symbols.operation, "documentSymbols");
    assert.equal(symbols.selectedServer, fixture.id);
    assert.ok(symbols.returned > 0, `${fixture.id} returned no document symbols`);

    const hover = await manager.run(root, {
      operation: "hover",
      path: fixture.sourcePath,
      line: fixture.hover.line,
      column: fixture.hover.column,
    });
    assert.equal(hover.operation, "hover");
    assert.equal(hover.selectedServer, fixture.id);

    passed += 1;
    console.log(
      `PASS ${fixture.id}: ${executable} -> documentSymbols(${symbols.returned}) + hover via built-in discovery and stdio LSP.`,
    );
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    failures.push(`${fixture.id}: ${message}`);
    console.error(`FAIL ${fixture.id}: ${message}`);
  } finally {
    await manager.shutdown();
    assert.equal(manager.stats().servicesTotal, 0, `${fixture.id} retained a Language service after shutdown`);
  }
}

console.log(`LSP interoperability summary: ${passed} passed, ${skipped} skipped, ${failures.length} failed.`);
if (failures.length > 0) {
  console.error(`Interop artifacts retained at ${interopRoot}`);
  process.exitCode = 1;
} else {
  rmSync(interopRoot, { recursive: true, force: true });
}

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
