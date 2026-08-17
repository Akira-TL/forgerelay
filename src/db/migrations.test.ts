import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BashOutputStore } from "../activity/bash-output-store.js";

test("database migration repairs a partial historical Bash output schema before completion writes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-migration-bash-output-test-"));
  const databasePath = join(stateDir, "devspace.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table bash_output_streams (
      id text primary key,
      activity_id text not null,
      turn_id text not null,
      conversation_scope_id text,
      process_id integer not null,
      workspace_id text not null,
      workspace_root text not null,
      command text not null,
      tty integer not null default 0,
      status text not null default 'running',
      exit_code integer,
      signal text,
      timed_out integer not null default 0,
      started_at text not null,
      finished_at text
    );

    create table bash_output_chunks (
      output_id text not null,
      sequence integer not null,
      channel text not null,
      data blob not null,
      created_at text not null,
      primary key (output_id, sequence)
    );
  `);
  const recordMigration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (let version = 1; version <= 11; version += 1) {
    recordMigration.run(version, `legacy-${version}`, "2026-08-15T00:00:00.000Z");
  }
  legacy.close();

  const store = new BashOutputStore(stateDir, {
    now: () => new Date("2026-08-17T05:00:00.000Z"),
    outputId: () => "out_legacy_schema",
  });

  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const outputId = store.begin({
    activityId: "act_legacy",
    turnId: "turn_legacy",
    processId: 1,
    workspaceId: "ws_legacy",
    workspaceRoot: stateDir,
    command: "printf legacy",
    tty: false,
  });
  store.append(outputId, "stdout", "legacy\n");

  // v0.5.5 crashes here against the historical partial schema because `error` is missing.
  store.finish(outputId, { exitCode: 0, timedOut: false });
  store.markReturned(outputId);
  const claimed = store.claimCompletion(outputId);

  assert.equal(claimed?.status, "done");
  assert.equal(claimed?.returned, true);
  assert.equal(claimed?.output, "legacy\n");
  assert.equal(store.claimCompletion(outputId), undefined);
});
