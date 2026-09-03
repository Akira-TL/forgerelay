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
  options: {
    referenceDelayMs?: number;
    referenceGatePath?: string;
    cancellationMode?: "aware" | "ignore";
    logPath?: string;
  } = {},
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
          FORGERELAY_FAKE_LSP_REFERENCE_DELAY_MS: String(options.referenceDelayMs ?? 0),
          FORGERELAY_FAKE_LSP_CANCELLATION_MODE: options.cancellationMode ?? "aware",
          ...(options.referenceGatePath ? { FORGERELAY_FAKE_LSP_REFERENCE_GATE_PATH: options.referenceGatePath } : {}),
          ...(options.logPath ? { FORGERELAY_FAKE_LSP_LOG: options.logPath } : {}),
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }) + "\n",
  );
}

function capabilityCall(workspaceId: string, argumentsValue: Record<string, unknown>) {
  return {
    name: "capability",
    arguments: {
      workspaceId,
      name: "code.intelligence",
      action: "run",
      arguments: argumentsValue,
    },
  } as const;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLog(logPath: string, pattern: RegExp, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(logPath, "utf8");
      if (pattern.test(text)) return text;
    } catch {
      // The fake server may not have created the log yet.
    }
    await pause(20);
  }
  throw new Error(`Timed out waiting for ${pattern} in ${logPath}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause(20);
  }
  throw new Error("Timed out waiting for semantic request state.");
}

test("Host cancellation propagates to an aware LSP server and the shared service remains usable", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: { requestTimeoutMs: 2_000 },
  });
  const logPath = join(context.project, ".cancel-aware.log");
  await configureProject(context.project, { referenceDelayMs: 500, cancellationMode: "aware", logPath });
  const opened = await callOpen(context.client, context.project, "request-cancel-aware");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const primed = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(primed.isError, undefined);
  const controller = new AbortController();
  const pending = context.client.callTool(
    capabilityCall(workspaceId, {
      operation: "references",
      path: "src/main.ts",
      line: 1,
      column: 15,
    }),
    undefined,
    { signal: controller.signal },
  );
  await waitForLog(logPath, /"method":"textDocument\/references"/);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.message.includes("AbortError"),
  );
  const log = await waitForLog(logPath, /"method":"\$\/cancelRequest"/);
  assert.match(log, /"method":"\$\/cancelRequest"/);

  const hover = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(hover.isError, undefined);
});

test("a server that ignores cancellation cannot block all semantic request slots", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      requestTimeoutMs: 2_000,
      maxConcurrentSemanticRequests: 2,
      maxQueuedSemanticRequests: 2,
    },
  });
  const logPath = join(context.project, ".cancel-ignore.log");
  const referenceGatePath = join(context.project, ".cancel-ignore-release");
  await configureProject(context.project, { referenceGatePath, cancellationMode: "ignore", logPath });
  const opened = await callOpen(context.client, context.project, "request-cancel-ignore");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const primed = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(primed.isError, undefined);
  await writeFile(logPath, "");
  const controller = new AbortController();
  const pending = context.client.callTool(
    capabilityCall(workspaceId, {
      operation: "references",
      path: "src/main.ts",
      line: 1,
      column: 15,
    }),
    undefined,
    { signal: controller.signal },
  );
  await waitForLog(logPath, /"method":"textDocument\/references"/);
  controller.abort();
  await assert.rejects(pending);

  const hoverPending = context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  await waitForLog(logPath, /"method":"textDocument\/hover"/);
  await writeFile(referenceGatePath, "release\n");
  const hover = await hoverPending;
  assert.equal(hover.isError, undefined);
  const log = await waitForLog(logPath, /"method":"\$\/cancelRequest"/);
  assert.match(log, /"method":"\$\/cancelRequest"/);
});

test("semantic deadlines return a stable timeout error and preserve a healthy service", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: { requestTimeoutMs: 80 },
  });
  await configureProject(context.project, { referenceDelayMs: 400, cancellationMode: "aware" });
  const opened = await callOpen(context.client, context.project, "request-timeout");
  const workspaceId = structuredContent(opened).workspaceId as string;

  const timedOut = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "references",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(timedOut.isError, true);
  assert.equal((structuredContent(timedOut).error as { code?: string }).code, "code.request_timeout");

  const hover = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(hover.isError, undefined);
});

test("semantic request concurrency and queue length are both bounded", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      requestTimeoutMs: 5_000,
      maxConcurrentSemanticRequests: 2,
      maxQueuedSemanticRequests: 1,
    },
  });
  await configureProject(context.project, { referenceDelayMs: 1_500, cancellationMode: "ignore" });
  const opened = await callOpen(context.client, context.project, "request-capacity");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const refs = () => context.client.callTool(capabilityCall(workspaceId, {
    operation: "references",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));

  const first = refs();
  const second = refs();
  const queued = refs();
  await waitFor(() => {
    const stats = context.codeIntelligence.stats();
    return stats.semanticRequestsActive === 2 && stats.semanticRequestsQueued === 1;
  });
  const rejected = await refs();
  assert.equal(rejected.isError, true);
  assert.equal((structuredContent(rejected).error as { code?: string }).code, "code.request_capacity");

  const completed = await Promise.all([first, second, queued]);
  assert.ok(completed.every((result) => result.isError === undefined));
});
