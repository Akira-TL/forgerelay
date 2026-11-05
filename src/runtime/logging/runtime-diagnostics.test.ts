import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeDiagnostics, diagnosticError, type RuntimeDiagnosticFields } from "./runtime-diagnostics.js";
import { createCodeIntelligenceServerFixture } from "../../lsp/test-support/server-fixture.js";

interface LoggedEvent extends RuntimeDiagnosticFields { event: string; pid: number }

async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function events(path: string): Promise<LoggedEvent[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as LoggedEvent);
}

test("runtime diagnostics survive a new writer, rotate within bounds, and keep private permissions", async (t) => {
  const root = await temporaryDirectory(t);
  const diagnostics = new RuntimeDiagnostics(root, 512);
  for (let index = 0; index < 20; index += 1) {
    diagnostics.record("runtime_started", { version: String(index), reason: "x".repeat(128) });
  }
  const files = await readdir(join(root, "logs"));
  assert.equal(files.length, 4);
  for (const name of files) {
    const info = await stat(join(root, "logs", name));
    assert.ok(info.size <= 512);
    if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
    await events(join(root, "logs", name));
  }
  new RuntimeDiagnostics(root, 512).record("runtime_exit", { exitCode: 1 });
  assert.equal((await events(diagnostics.path)).at(-1)?.exitCode, 1);
});

test("fatal rejection is saved before Node exits and its sensitive message is omitted", async (t) => {
  const root = await temporaryDirectory(t);
  const moduleUrl = new URL("./runtime-diagnostics.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { RuntimeDiagnostics, observeRuntimeExit } from ${JSON.stringify(moduleUrl)};
    observeRuntimeExit(new RuntimeDiagnostics(process.env.DIAGNOSTIC_TEST_ROOT));
    Promise.reject(Object.assign(new Error("secret-source-and-credential"), { code: "test.fatal" }));
  `], { env: { ...process.env, DIAGNOSTIC_TEST_ROOT: root }, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const recorded = await events(join(root, "logs", "runtime.jsonl"));
  assert.equal(recorded[0]?.event, "runtime_uncaught_exception");
  assert.equal(recorded[0]?.reason, "unhandledRejection");
  assert.equal(recorded[0]?.errorCode, "test.fatal");
  assert.ok(recorded[0]?.stack?.length);
  assert.equal(recorded[1]?.event, "runtime_exit");
  assert.equal(recorded[1]?.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(recorded), /secret-source-and-credential/);
});

test("diagnostic write failure preserves application behavior", async (t) => {
  const root = await temporaryDirectory(t);
  const destination = join(root, "not-a-directory");
  await writeFile(destination, "original");
  const warnings: string[] = [];
  const original = console.error;
  console.error = (message: string) => { warnings.push(message); };
  try {
    const diagnostics = new RuntimeDiagnostics(destination);
    assert.doesNotThrow(() => diagnostics.record("runtime_exit", { exitCode: 1 }));
    assert.doesNotThrow(() => diagnostics.record("runtime_exit", { exitCode: 1 }));
  } finally { console.error = original; }
  assert.equal(warnings.length, 1);
  assert.equal(await readFile(destination, "utf8"), "original");
  assert.deepEqual(diagnosticError("secret"), { errorName: "NonError" });
});

test("real Language-service teardown records its cause, SIGTERM sender and child exit", async (t) => {
  const root = await temporaryDirectory(t);
  const diagnostics = new RuntimeDiagnostics(root);
  const fixture = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: { diagnostics, shutdownTimeoutMs: 30 },
  });
  const fakeServer = fileURLToPath(new URL("../../lsp/test-fixtures/fake-lsp-server.mjs", import.meta.url));
  await mkdir(join(fixture.project, ".forgerelay"), { recursive: true });
  await writeFile(join(fixture.project, "main.ts"), "const value = target();\n");
  await writeFile(join(fixture.project, "tsconfig.json"), "{}\n");
  await writeFile(join(fixture.project, ".forgerelay", "language-servers.json"), JSON.stringify({
    test: {
      command: process.execPath, args: [fakeServer], languages: ["typescript"], extensions: [".ts"],
      projectMarkers: ["tsconfig.json"], env: { FORGERELAY_FAKE_LSP_IGNORE_SHUTDOWN: "1" },
    },
  }));
  await fixture.codeIntelligence.run(fixture.project, { operation: "hover", path: "main.ts", line: 1, column: 1 });
  await fixture.codeIntelligence.shutdown();
  let recorded = await events(diagnostics.path);
  for (let attempt = 0; attempt < 100 && !recorded.some((entry) => entry.event === "lsp_exit"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    recorded = await events(diagnostics.path);
  }
  const terminated = recorded.find((entry) => entry.event === "lsp_terminate");
  assert.equal(terminated?.reason, "server_shutdown");
  assert.equal(terminated?.signal, "SIGTERM");
  assert.ok(terminated?.stack?.some((frame) => frame.includes("shutdown")));
  const exited = recorded.find((entry) => entry.event === "lsp_exit");
  assert.equal(exited?.signal, "SIGTERM");
  assert.equal(exited?.serviceId, terminated?.serviceId);
  assert.equal(exited?.childPid, terminated?.childPid);
  assert.ok(recorded.some((entry) => entry.event === "lsp_ready"));
});
