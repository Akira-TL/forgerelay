import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatPrettyLogEntry } from "../../logger.js";
import {
  callOpen,
  createCodeIntelligenceServerFixture,
  structuredContent,
} from "../test-support/server-fixture.js";

const fakeServerPath = fileURLToPath(new URL("../test-fixtures/fake-lsp-server.mjs", import.meta.url));
const pause = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function definition(env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fakeServerPath],
    env,
    languages: ["typescript"],
    extensions: [".ts"],
    projectMarkers: ["tsconfig.json"],
  };
}

async function prepareSingleProject(
  project: string,
  env: Record<string, string> = {},
): Promise<void> {
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "tsconfig.json"), "{}\n");
  await writeFile(join(project, "src", "main.ts"), "const value = target();\n");
  await writeFile(join(project, "src", "target.ts"), "export const target = () => 1;\n");
  await writeServerConfig(project, { test: definition(env) });
}

async function prepareNestedProjects(
  project: string,
  names: readonly string[],
  env: Record<string, string> = {},
): Promise<void> {
  await mkdir(join(project, ".forgerelay"), { recursive: true });
  for (const name of names) {
    const root = join(project, name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "main.ts"), "const value = target();\n");
    await writeFile(join(root, "target.ts"), "export const target = () => 1;\n");
  }
  await writeServerConfig(project, { test: definition(env) });
}

async function writeServerConfig(
  project: string,
  definitions: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(project, ".forgerelay", "language-servers.json"),
    `${JSON.stringify(definitions, null, 2)}\n`,
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(20);
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function readEvents(logPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForMethod(logPath: string, method: string): Promise<void> {
  await waitFor(async () => (await readEvents(logPath)).some((event) => event.method === method));
}

function initializePidForRoot(
  events: Array<Record<string, unknown>>,
  root: string,
): number {
  const event = events.find((candidate) => {
    if (candidate.method !== "initialize") return false;
    const params = candidate.params as { rootUri?: string } | undefined;
    return typeof params?.rootUri === "string" && resolve(fileURLToPath(params.rootUri)) === resolve(root);
  });
  assert.ok(event);
  assert.equal(typeof event.pid, "number");
  return event.pid as number;
}

function git(project: string, args: string[]): void {
  execFileSync("git", args, { cwd: project, stdio: "ignore" });
}

test("logical workspaces share one Language service and idle cleanup releases retained state", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      idleMs: 1_000,
      cleanupIntervalMs: 20,
    },
  });
  const logPath = join(context.project, ".shared-idle.log");
  await prepareSingleProject(context.project, {
    FORGERELAY_FAKE_LSP_LOG: logPath,
    FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
    FORGERELAY_FAKE_LSP_DIAGNOSTIC_COUNT: "3",
  });

  const openedA = await callOpen(context.client, context.project, "lifecycle-logical-a");
  const openedB = await callOpen(context.client, context.project, "lifecycle-logical-b");
  const workspaceA = structuredContent(openedA).workspaceId as string;
  const workspaceB = structuredContent(openedB).workspaceId as string;
  assert.notEqual(workspaceA, workspaceB);

  const diagnostics = await context.client.callTool(capabilityCall(workspaceA, {
    operation: "diagnostics",
    path: "src/main.ts",
  }));
  assert.equal(diagnostics.isError, undefined);
  const hover = await context.client.callTool(capabilityCall(workspaceB, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(hover.isError, undefined);

  const live = context.codeIntelligence.stats();
  assert.equal(live.servicesTotal, 1);
  assert.equal(live.processesRunning, 1);
  assert.equal(live.openDocuments, 1);
  assert.equal(live.diagnosticSnapshots, 1);
  assert.equal(live.diagnosticsRetained, 3);
  const initializations = (await readEvents(logPath)).filter((event) => event.method === "initialize");
  assert.equal(initializations.length, 1);

  await waitFor(() => context.codeIntelligence.stats().servicesTotal === 0);
  const idle = context.codeIntelligence.stats();
  assert.deepEqual(
    {
      services: idle.servicesTotal,
      processes: idle.processesRunning,
      operations: idle.operationsInFlight,
      requests: idle.semanticRequestsActive,
      queued: idle.semanticRequestsQueued,
      documents: idle.openDocuments,
      snapshots: idle.diagnosticSnapshots,
      diagnostics: idle.diagnosticsRetained,
      stderr: idle.stderrBytes,
    },
    {
      services: 0,
      processes: 0,
      operations: 0,
      requests: 0,
      queued: 0,
      documents: 0,
      snapshots: 0,
      diagnostics: 0,
      stderr: 0,
    },
  );
  await waitForMethod(logPath, "shutdown");
  await waitForMethod(logPath, "exit");
});

test("service capacity evicts the least-recently-used idle service", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      maxServices: 2,
      idleMs: 30_000,
      cleanupIntervalMs: 30_000,
    },
  });
  const logPath = join(context.project, ".lru.log");
  await prepareNestedProjects(context.project, ["a", "b", "c"], {
    FORGERELAY_FAKE_LSP_LOG: logPath,
  });
  const opened = await callOpen(context.client, context.project, "lifecycle-lru");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const hover = (path: string) => context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path,
    line: 1,
    column: 15,
  }));

  assert.equal((await hover("a/main.ts")).isError, undefined);
  await pause(25);
  assert.equal((await hover("b/main.ts")).isError, undefined);
  await pause(25);
  assert.equal((await hover("a/main.ts")).isError, undefined);
  await pause(25);
  assert.equal((await hover("c/main.ts")).isError, undefined);

  const events = await readEvents(logPath);
  const pidA = initializePidForRoot(events, join(context.project, "a"));
  const pidB = initializePidForRoot(events, join(context.project, "b"));
  const shutdownPids = events
    .filter((event) => event.method === "shutdown")
    .map((event) => event.pid);
  assert.ok(shutdownPids.includes(pidB), "the older idle b service should be evicted");
  assert.ok(!shutdownPids.includes(pidA), "the recently reused a service should remain alive");
  const stats = context.codeIntelligence.stats();
  assert.equal(stats.servicesTotal, 2);
  assert.equal(stats.processesRunning, 2);
});

test("capacity refuses new work instead of killing a service with an active semantic request", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      maxServices: 1,
      requestTimeoutMs: 5_000,
      idleMs: 30_000,
      cleanupIntervalMs: 30_000,
    },
  });
  const logPath = join(context.project, ".active-capacity.log");
  await prepareNestedProjects(context.project, ["a", "b"], {
    FORGERELAY_FAKE_LSP_LOG: logPath,
    FORGERELAY_FAKE_LSP_REFERENCE_DELAY_MS: "2500",
    FORGERELAY_FAKE_LSP_CANCELLATION_MODE: "ignore",
  });
  const opened = await callOpen(context.client, context.project, "lifecycle-active-capacity");
  const workspaceId = structuredContent(opened).workspaceId as string;
  const controller = new AbortController();
  const pending = context.client.callTool(
    capabilityCall(workspaceId, {
      operation: "references",
      path: "a/main.ts",
      line: 1,
      column: 15,
    }),
    undefined,
    { signal: controller.signal },
  );
  await waitForMethod(logPath, "textDocument/references");
  controller.abort();
  await assert.rejects(pending);
  await waitFor(() => context.codeIntelligence.stats().semanticRequestsActive === 1);

  const blocked = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "b/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(blocked.isError, true);
  assert.equal(
    (structuredContent(blocked).error as { code?: string }).code,
    "code.language_service_capacity",
  );
  const active = context.codeIntelligence.stats();
  assert.equal(active.servicesTotal, 1);
  assert.equal(active.servicesActive, 1);
  assert.equal(active.processesRunning, 1);
  assert.equal(active.semanticRequestsActive, 1);
  assert.equal((await readEvents(logPath)).some((event) => event.method === "shutdown"), false);

  await waitFor(() => context.codeIntelligence.stats().semanticRequestsActive === 0, 4_000);
  const afterUnderlyingSettles = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "b/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(afterUnderlyingSettles.isError, undefined);
  assert.equal(context.codeIntelligence.stats().servicesTotal, 1);
});

test("managed-worktree finalization releases its Language service before removing the worktree", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      idleMs: 30_000,
      cleanupIntervalMs: 30_000,
    },
  });
  const logPath = join(dirname(context.project), "managed-worktree-lsp.log");
  await prepareSingleProject(context.project, {
    FORGERELAY_FAKE_LSP_LOG: logPath,
    FORGERELAY_FAKE_LSP_REFERENCE_DELAY_MS: "2500",
    FORGERELAY_FAKE_LSP_CANCELLATION_MODE: "ignore",
  });
  git(context.project, ["init"]);
  git(context.project, ["config", "user.name", "ForgeRelay Test"]);
  git(context.project, ["config", "user.email", "forgerelay@example.invalid"]);
  git(context.project, ["add", "."]);
  git(context.project, ["commit", "-m", "test: initialize managed worktree fixture"]);

  const opened = await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree" },
    _meta: { "openai/session": "lifecycle-managed-worktree" },
  } as Parameters<typeof context.client.callTool>[0]);
  const workspaceId = structuredContent(opened).workspaceId as string;
  const worktree = structuredContent(opened).worktree as { path?: string };
  assert.equal(typeof worktree.path, "string");

  const hover = await context.client.callTool(capabilityCall(workspaceId, {
    operation: "hover",
    path: "src/main.ts",
    line: 1,
    column: 15,
  }));
  assert.equal(hover.isError, undefined);
  assert.equal(context.codeIntelligence.stats().servicesTotal, 1);

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
  await waitForMethod(logPath, "textDocument/references");
  const blockedClose = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      commitMessage: "test: must not finalize active code intelligence",
    },
  });
  assert.equal(blockedClose.isError, true);
  const blockedContent = (blockedClose as { content?: Array<{ text?: string }> }).content;
  const blockedText = blockedContent?.[0]?.text ?? "";
  assert.match(blockedText, /Language service request\(s\) are still active/);
  await access(worktree.path!);

  controller.abort();
  await assert.rejects(pending);
  await waitFor(() => context.codeIntelligence.stats().semanticRequestsActive === 0, 4_000);

  const closed = await context.client.callTool({
    name: "close_workspace",
    arguments: {
      workspaceId,
      commitMessage: "test: finalize code-intelligence worktree",
    },
  });
  assert.equal(closed.isError, undefined);
  const after = context.codeIntelligence.stats();
  assert.equal(after.servicesTotal, 0);
  assert.equal(after.processesRunning, 0);
  assert.equal(after.retiredWorkspaceRoots, 0);
  await assert.rejects(() => access(worktree.path!), /ENOENT/);
  const events = await readEvents(logPath);
  assert.ok(events.some((event) => event.method === "shutdown"));
  assert.ok(events.some((event) => event.method === "exit"));
});

test("repeated open/query/config/crash/idle cycles keep Language-service resources bounded", async (t) => {
  const context = await createCodeIntelligenceServerFixture(t, {
    codeIntelligenceOptions: {
      idleMs: 80,
      cleanupIntervalMs: 20,
      maxServices: 2,
      crashCooldownMs: 100,
    },
  });
  await mkdir(join(context.project, ".forgerelay"), { recursive: true });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(join(context.project, "src", "main.ts"), "const value = target();\n");
  await writeFile(join(context.project, "src", "target.ts"), "export const target = () => 1;\n");
  const root = dirname(context.project);

  for (let cycle = 0; cycle < 4; cycle += 1) {
    await writeServerConfig(context.project, {
      test: definition({
        FORGERELAY_FAKE_LSP_CRASH_MODE: "once",
        FORGERELAY_FAKE_LSP_CRASH_STATE_PATH: join(root, `.soak-crash-${cycle}`),
        FORGERELAY_FAKE_LSP_LOG: join(root, ".soak-lsp.log"),
        FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
        FORGERELAY_FAKE_LSP_DIAGNOSTIC_COUNT: "4",
        FORGERELAY_FAKE_LSP_HOVER_TEXT: `cycle-${cycle}`,
      }),
    });
    const opened = await callOpen(context.client, context.project, `lifecycle-soak-${cycle}`);
    const workspaceId = structuredContent(opened).workspaceId as string;

    const recovered = await context.client.callTool(capabilityCall(workspaceId, {
      operation: "references",
      path: "src/main.ts",
      line: 1,
      column: 15,
    }));
    assert.equal(recovered.isError, undefined);
    const diagnostics = await context.client.callTool(capabilityCall(workspaceId, {
      operation: "diagnostics",
      path: "src/main.ts",
    }));
    assert.equal(diagnostics.isError, undefined);

    const live = context.codeIntelligence.stats();
    assert.ok(live.servicesTotal <= 1);
    assert.ok(live.processesRunning <= 1);
    assert.ok(live.openDocuments <= 1);
    assert.ok(live.diagnosticSnapshots <= 1);
    assert.ok(live.diagnosticsRetained <= 4);
    assert.ok(live.stderrBytes <= 64 * 1024);
    assert.equal(live.semanticRequestsQueued, 0);
    assert.equal(live.pendingCreations, 0);

    await waitFor(() => context.codeIntelligence.stats().servicesTotal === 0);
    const idle = context.codeIntelligence.stats();
    assert.equal(idle.processesRunning, 0);
    assert.equal(idle.openDocuments, 0);
    assert.equal(idle.diagnosticSnapshots, 0);
    assert.equal(idle.diagnosticsRetained, 0);
    assert.equal(idle.stderrBytes, 0);

    const closed = await context.client.callTool({
      name: "close_workspace",
      arguments: { workspaceId },
    });
    assert.equal(closed.isError, undefined);
  }
});

test("runtime resource telemetry renders aggregate Language-service state without source data", () => {
  const line = formatPrettyLogEntry({
    ts: "2026-08-11T00:00:00.000Z",
    level: "debug",
    event: "runtime_resources",
    rssBytes: 10 * 1024 * 1024,
    heapUsedBytes: 2 * 1024 * 1024,
    heapTotalBytes: 4 * 1024 * 1024,
    mcpTransports: 1,
    processesRunning: 0,
    processesCompleted: 0,
    cachedWorkspaces: 2,
    reviewStates: 0,
    languageServices: 2,
    languageServicesActive: 1,
    languageProcessesRunning: 2,
    languageRequestsActive: 1,
    languageRequestsQueued: 3,
    languageOpenDocuments: 4,
    languageDiagnosticSnapshots: 5,
    languageDiagnosticsRetained: 6,
    languageStderrBytes: 7,
    languageCrashCooldowns: 1,
  }, { colorize: false, validateStream: false });

  assert.match(line, /lsp=2 services\/1 active\/2 processes/);
  assert.match(line, /requests=1 active\/3 queued/);
  assert.match(line, /docs=4/);
  assert.match(line, /diagnostics=5 snapshots\/6 retained/);
  assert.match(line, /stderr=7B cooldowns=1/);
  assert.doesNotMatch(line, /source|main\.ts|target\.ts/);
});
