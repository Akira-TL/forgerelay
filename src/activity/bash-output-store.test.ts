import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../process-sessions.js";
import { BashOutputStore } from "./bash-output-store.js";

test("Bash output stream persists complete ordered raw output across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-test-"));
  let store = new BashOutputStore(stateDir, {
    now: () => new Date("2026-08-14T15:30:00.000Z"),
    outputId: () => "out_test_complete",
  });

  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_bash",
    turnId: "turn_bash",
    conversationScopeId: "conversation_bash",
    processId: 41,
    workspaceId: "ws_bash",
    workspaceRoot: "/tmp/workspace",
    command: "node script.js",
    tty: false,
  });
  assert.equal(outputId, "out_test_complete");

  const unicode = Buffer.from("A🐉B\n", "utf8");
  store.append(outputId, "stdout", unicode.subarray(0, 3));
  store.append(outputId, "stdout", unicode.subarray(3));
  store.append(outputId, "stderr", Buffer.from("problem\n", "utf8"));
  store.finish(outputId, { exitCode: 0, timedOut: false });

  store.close();
  store = new BashOutputStore(stateDir, {
    now: () => new Date("2026-08-14T15:31:00.000Z"),
  });

  const restored = store.read(outputId);
  assert.deepEqual(restored, {
    outputId: "out_test_complete",
    activityId: "act_bash",
    turnId: "turn_bash",
    conversationScopeId: "conversation_bash",
    processId: 41,
    workspaceId: "ws_bash",
    workspaceRoot: "/tmp/workspace",
    command: "node script.js",
    tty: false,
    output: "A🐉B\nproblem\n",
    chunks: [
      { sequence: 1, channel: "stdout", data: "A" },
      { sequence: 2, channel: "stdout", data: "🐉B\n" },
      { sequence: 3, channel: "stderr", data: "problem\n" },
    ],
    status: "done",
    exitCode: 0,
    timedOut: false,
    returned: false,
    startedAt: "2026-08-14T15:30:00.000Z",
    finishedAt: "2026-08-14T15:30:00.000Z",
  });
});

test("ProcessManager streams complete output to durable audit even when its response buffer is tiny", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-process-test-"));
  const store = new BashOutputStore(stateDir, {
    outputId: () => "out_process_complete",
  });
  const manager = new ProcessManager({
    maxBufferCharacters: 48,
    outputAudit: store,
  });

  t.after(async () => {
    manager.shutdown();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const expected = Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n") + "\n";
  const encoded = Buffer.from(expected, "utf8").toString("base64");
  const snapshot = await manager.start({
    workspaceId: "ws_process",
    workspaceRoot: "/tmp/process",
    command: `node -e "process.stdout.write(Buffer.from('${encoded}', 'base64'))"`,
    cwd: stateDir,
    yieldTimeMs: 10_000,
    audit: {
      activityId: "act_process",
      turnId: "turn_process",
      conversationScopeId: "conversation_process",
    },
  });

  assert.equal(snapshot.running, false);
  assert.equal(snapshot.outputId, "out_process_complete");
  assert.equal(snapshot.outputTruncated, true);
  assert.notEqual(snapshot.output, expected);
  assert.equal(store.read("out_process_complete")?.output, expected);
  assert.equal(store.read("out_process_complete")?.activityId, "act_process");
  assert.equal(store.read("out_process_complete")?.status, "done");
});

test("returned Bash completion can be claimed exactly once across restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-claim-test-"));
  let store = new BashOutputStore(stateDir, {
    outputId: () => "out_claim_once",
  });

  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_returned",
    turnId: "turn_returned",
    conversationScopeId: "conversation_returned",
    processId: 77,
    workspaceId: "ws_returned",
    workspaceRoot: "/tmp/returned",
    command: "sleep 1",
    tty: false,
  });
  store.markReturned(outputId);
  store.append(outputId, "stdout", "late output\n");
  store.finish(outputId, { exitCode: 0, timedOut: false });

  store.close();
  store = new BashOutputStore(stateDir);

  const first = store.claimCompletion(outputId);
  assert.equal(first?.activityId, "act_returned");
  assert.equal(first?.returned, true);
  assert.equal(first?.output, "late output\n");
  assert.equal(store.claimCompletion(outputId), undefined);
});

test("foreground Bash completion is not claimable as a Bash result", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-foreground-test-"));
  const store = new BashOutputStore(stateDir, {
    outputId: () => "out_foreground",
  });

  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_foreground",
    turnId: "turn_foreground",
    processId: 11,
    workspaceId: "ws_foreground",
    workspaceRoot: "/tmp/foreground",
    command: "printf done",
    tty: false,
  });
  store.finish(outputId, { exitCode: 0, timedOut: false });
  assert.equal(store.claimCompletion(outputId), undefined);
});

test("Bash output stream records failed process metadata without deleting output", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-failed-test-"));
  const store = new BashOutputStore(stateDir, {
    now: () => new Date("2026-08-14T16:00:00.000Z"),
    outputId: () => "out_test_failed",
  });

  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_failed",
    turnId: "turn_failed",
    processId: 9,
    workspaceId: "ws_failed",
    workspaceRoot: "/tmp/failed",
    command: "exit 7",
    tty: false,
  });
  store.append(outputId, "stderr", Buffer.from("boom\n"));
  store.finish(outputId, { exitCode: 7, timedOut: false });

  const record = store.read(outputId);
  assert.equal(record?.status, "failed");
  assert.equal(record?.output, "boom\n");
  assert.equal(record?.exitCode, 7);
});
