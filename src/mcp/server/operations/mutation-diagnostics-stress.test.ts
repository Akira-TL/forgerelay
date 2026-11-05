import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
          FORGERELAY_FAKE_LSP_SHUTDOWN_DELAY_MS: "300",
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
          FORGERELAY_FAKE_LSP_DIAGNOSTIC_DELAY_MS: "600",
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

  await cleanup;
  const edited = await editB;
  assert.equal(edited.isError, undefined);
  assert.match(allResponseText(edited), /pulled diagnostic 1/);
  assert.doesNotMatch(allResponseText(edited), /diagnostics warning|server crashed|start failed/i);
});
