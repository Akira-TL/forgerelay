import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../../runtime/testing/server-fixture.js";

const fakeServerPath = fileURLToPath(
  new URL("../../../lsp/test-fixtures/fake-lsp-server.mjs", import.meta.url),
);

test("idle cleanup rechecks a Language service before shutting down mutation diagnostics", async (t) => {
  const context = await fixture(t, {
    codeIntelligenceOptions: {
      idleMs: 60_000,
      cleanupIntervalMs: 60_000,
      shutdownTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    },
  });
  const projectA = join(context.project, "a");
  const projectB = join(context.project, "b");
  const logA = join(context.project, ".fake-lsp-a.log");
  const logB = join(context.project, ".fake-lsp-b.log");
  const shutdownGate = join(context.project, ".shutdown-gate");
  const diagnosticGate = join(context.project, ".diagnostic-gate");
  await writeFile(diagnosticGate, "ready");

  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(join(projectA, "a.project"), "\n");
  await writeFile(join(projectB, "b.project"), "\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "cleanup-a": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: logA,
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_SHUTDOWN_GATE_PATH: shutdownGate,
        },
        languages: ["typescript"],
        extensions: [".a"],
        projectMarkers: ["a.project"],
      },
      "cleanup-b": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: logB,
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_DIAGNOSTIC_GATE_PATH: diagnosticGate,
        },
        languages: ["typescript"],
        extensions: [".b"],
        projectMarkers: ["b.project"],
      },
    }, null, 2) + "\n",
  );

  const conversation = "chat-mutation-cleanup-race";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const firstA = await call("write", {
    workspaceId,
    path: "a/main.a",
    content: "const value = 1;\n",
  });
  assert.equal(firstA.isError, undefined);
  assert.match(allResponseText(firstA), /pulled diagnostic 1/);

  const firstB = await call("write", {
    workspaceId,
    path: "b/main.b",
    content: "const value = 1;\n",
  });
  assert.equal(firstB.isError, undefined);
  assert.match(allResponseText(firstB), /pulled diagnostic 1/);

  await unlink(diagnosticGate);
  const internalManager = context.codeIntelligence as unknown as {
    closeIdle(now?: number): Promise<void>;
  };
  const cleanup = internalManager.closeIdle(Date.now() + 120_000);

  const shutdownDeadline = Date.now() + 2_000;
  let shutdownAObserved = false;
  while (Date.now() < shutdownDeadline) {
    try {
      shutdownAObserved = (await readFile(logA, "utf8")).includes('"method":"shutdown"');
    } catch {
      shutdownAObserved = false;
    }
    if (shutdownAObserved) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(shutdownAObserved, true, "cleanup must begin shutting down service A");

  const editB = call("edit", {
    workspaceId,
    path: "b/main.b",
    edits: [{ oldText: "1", newText: "2" }],
  });

  const activeDeadline = Date.now() + 2_000;
  while (
    context.codeIntelligence.stats().operationsInFlight === 0 &&
    Date.now() < activeDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    context.codeIntelligence.stats().operationsInFlight,
    1,
    "service B must be active while cleanup is still draining service A",
  );

  await writeFile(shutdownGate, "continue");
  await cleanup;
  await writeFile(diagnosticGate, "continue");
  const edited = await editB;
  assert.doesNotMatch(await readFile(logB, "utf8"), /"method":"shutdown"/);
  assert.equal(edited.isError, undefined);
  assert.match(allResponseText(edited), /pulled diagnostic 1/);
  assert.doesNotMatch(allResponseText(edited), /diagnostics warning|server crashed|start failed/i);
});


test("idle cleanup cannot SIGTERM a service re-acquired by edit during initialization", async (t) => {
  const context = await fixture(t, {
    codeIntelligenceOptions: {
      idleMs: 60_000,
      cleanupIntervalMs: 60_000,
      startTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
    },
  });
  const projectA = join(context.project, "slow");
  const projectB = join(context.project, "python-like");
  const logA = join(context.project, ".fake-lsp-slow.log");
  const logB = join(context.project, ".fake-lsp-retry.log");
  const crashOnceStatePath = join(context.project, ".fake-lsp-crashed-once");
  const initializeGatePath = join(context.project, ".fake-lsp-initialize-gate");
  const shutdownGate = join(context.project, ".shutdown-gate");

  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(join(projectA, "slow.project"), "\n");
  await writeFile(join(projectB, "python.project"), "\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "slow-cleanup": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: logA,
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_SHUTDOWN_DELAY_MS: "300",
        },
        languages: ["typescript"],
        extensions: [".slow"],
        projectMarkers: ["slow.project"],
      },
      "retry-initialize": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_LOG: logB,
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_INITIALIZE_CRASH_ONCE_STATE_PATH: crashOnceStatePath,
          FORGERELAY_FAKE_LSP_INITIALIZE_GATE_PATH: initializeGatePath,
          FORGERELAY_FAKE_LSP_IGNORE_SHUTDOWN: "1",
        },
        languages: ["python"],
        extensions: [".pyx"],
        projectMarkers: ["python.project"],
      },
    }, null, 2) + "\n",
  );

  const conversation = "chat-mutation-initialize-cleanup-race";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const call = (name: string, arguments_: Record<string, unknown>) => context.client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const firstA = await call("write", {
    workspaceId,
    path: "slow/main.slow",
    content: "const value = 1;\n",
  });
  assert.equal(firstA.isError, undefined);
  assert.match(allResponseText(firstA), /pulled diagnostic 1/);

  const firstB = await call("write", {
    workspaceId,
    path: "python-like/main.pyx",
    content: "value = 1\n",
  });
  assert.equal(firstB.isError, undefined);
  assert.match(allResponseText(firstB), /Automatic diagnostics warning/);
  assert.match(allResponseText(firstB), /exited during initialization \(91\)/);

  const internalManager = context.codeIntelligence as unknown as {
    closeIdle(now?: number): Promise<void>;
  };
  const cleanup = internalManager.closeIdle(Date.now() + 120_000);

  const shutdownDeadline = Date.now() + 2_000;
  let shutdownAObserved = false;
  while (Date.now() < shutdownDeadline) {
    try {
      shutdownAObserved = (await readFile(logA, "utf8")).includes('"method":"shutdown"');
    } catch {
      shutdownAObserved = false;
    }
    if (shutdownAObserved) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(shutdownAObserved, true, "cleanup must block while shutting down service A");

  const editB = call("edit", {
    workspaceId,
    path: "python-like/main.pyx",
    edits: [{ oldText: "1", newText: "2" }],
  });

  const secondInitializeDeadline = Date.now() + 2_000;
  let initializeCount = 0;
  while (Date.now() < secondInitializeDeadline) {
    try {
      initializeCount = (await readFile(logB, "utf8"))
        .split("\n")
        .filter((line) => line.includes('"method":"initialize"'))
        .length;
    } catch {
      initializeCount = 0;
    }
    if (initializeCount >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(initializeCount, 2, "edit must re-enter Language Server initialization");

  await writeFile(shutdownGate, "continue");
  await cleanup;
  await writeFile(initializeGatePath, "continue\n");
  const edited = await editB;
  assert.equal(edited.isError, undefined);
  assert.match(allResponseText(edited), /pulled diagnostic 1/);
  assert.doesNotMatch(allResponseText(edited), /SIGTERM|diagnostics warning/i);
});
