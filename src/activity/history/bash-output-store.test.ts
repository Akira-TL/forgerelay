import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ProcessManager } from "../../mcp/process/process-sessions.js";
import { ACTIVITY_LOG_SEGMENT_BYTES } from "../storage/segmented-log.js";
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
    status: "done",
    exitCode: 0,
    timedOut: false,
    returned: false,
    outputBytes: Buffer.byteLength("A🐉B\nproblem\n"),
    startedAt: "2026-08-14T15:30:00.000Z",
    finishedAt: "2026-08-14T15:30:00.000Z",
    output: "A🐉B\nproblem\n",
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
  assert.equal(first?.outputBytes, Buffer.byteLength("late output\n"));
  assert.equal(store.read(outputId)?.output, "late output\n");
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

test("Bash output uses bounded shards, byte cursors, and no SQLite chunk payload rows", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-bash-output-shard-test-"));
  const store = new BashOutputStore(stateDir, {
    outputId: () => "out_sharded",
    flushBytes: 1024,
    flushIntervalMs: 60_000,
  });
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_sharded",
    turnId: "turn_sharded",
    processId: 55,
    workspaceId: "ws_sharded",
    workspaceRoot: "/tmp/sharded",
    command: "large-output",
    tty: false,
  });
  const prefix = Buffer.alloc(ACTIVITY_LOG_SEGMENT_BYTES - 3, 0x61);
  const suffix = Buffer.from("XYZ0123456789", "utf8");
  store.append(outputId, "stdout", prefix);
  store.append(outputId, "stdout", suffix);
  store.finish(outputId, { exitCode: 0, timedOut: false });

  const cursor = ACTIVITY_LOG_SEGMENT_BYTES - 5;
  const slice = store.readSince(outputId, cursor);
  assert.equal(slice?.cursor, prefix.length + suffix.length);
  assert.equal(slice?.output, `${"a".repeat(2)}${suffix.toString("utf8")}`);

  const bashDir = join(stateDir, "workspaces", "ws_sharded", "activity", "bash");
  const shards = (await readdir(bashDir)).filter((file) => file.startsWith(`${outputId}.`)).sort();
  assert.equal(shards.length, 2);
  for (const shard of shards) {
    assert.ok((await stat(join(bashDir, shard))).size <= ACTIVITY_LOG_SEGMENT_BYTES);
  }

  const sqlite = new Database(join(stateDir, "forgerelay.sqlite"), { readonly: true });
  try {
    const chunkCount = sqlite.prepare(
      "select count(*) as count from bash_output_chunks where output_id = ?",
    ).get(outputId) as { count: number };
    assert.equal(chunkCount.count, 0);
    const metadata = sqlite.prepare(
      `select log_file, output_bytes, command, error,
              command_file, command_offset, command_length
         from bash_output_streams where id = ?`,
    ).get(outputId) as {
      log_file: string | null;
      output_bytes: number;
      command: string;
      error: string | null;
      command_file: string | null;
      command_offset: number | null;
      command_length: number | null;
    };
    assert.ok(metadata.log_file);
    assert.equal(metadata.output_bytes, prefix.length + suffix.length);
    assert.equal(metadata.command, "");
    assert.equal(metadata.error, null);
    assert.ok(metadata.command_file);
    assert.equal(metadata.command_offset, 0);
    assert.equal(metadata.command_length, Buffer.byteLength("large-output"));
    assert.equal(store.readMetadata(outputId)?.command, "large-output");
  } finally {
    sqlite.close();
  }
});
