import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { BashOutputStore } from "../activity/bash-output-store.js";
import { HostTurnStore } from "../activity/host-turn-store.js";
import { openDatabase } from "./client.js";

test("database migration backfills Host Turn workspace identity when historical Activity data is available", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-migration-host-turn-workspace-test-"));
  const databasePath = join(stateDir, "devspace.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table activity_host_turns (
      turn_id text primary key,
      conversation_scope_id text,
      created_at text not null
    );

    create table activity_audit_events (
      turn_id text,
      workspace_id text,
      created_at text not null
    );

    insert into activity_host_turns (turn_id, conversation_scope_id, created_at)
      values ('turn_backfilled', 'conversation_backfilled', '2026-08-15T00:00:00.000Z');
    insert into activity_host_turns (turn_id, conversation_scope_id, created_at)
      values ('turn_unknown', 'conversation_backfilled', '2026-08-15T00:01:00.000Z');
    insert into activity_audit_events (turn_id, workspace_id, created_at)
      values ('turn_backfilled', 'ws_backfilled', '2026-08-15T00:00:01.000Z');
  `);
  const recordMigration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (let version = 1; version <= 12; version += 1) {
    recordMigration.run(version, `legacy-${version}`, "2026-08-15T00:00:00.000Z");
  }
  legacy.close();

  const turns = new HostTurnStore(stateDir);
  t.after(async () => {
    turns.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  assert.equal(turns.get("turn_backfilled")?.workspaceId, "ws_backfilled");
  assert.equal(
    turns.current("conversation_backfilled", "ws_backfilled")?.turnId,
    "turn_backfilled",
  );
  assert.equal(turns.get("turn_unknown")?.workspaceId, undefined);
});

test("database migration adds persistent Workspace alias storage after the v0.7.4 schema", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-migration-workspace-alias-test-"));
  const databasePath = join(stateDir, "devspace.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      branch text,
      target_branch text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );
  `);
  const recordMigration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (let version = 1; version <= 15; version += 1) {
    recordMigration.run(version, `legacy-${version}`, "2026-08-30T00:00:00.000Z");
  }
  legacy.close();

  const migrated = openDatabase(stateDir);
  t.after(async () => {
    migrated.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const table = migrated.sqlite.prepare(
    "select name from sqlite_master where type = 'table' and name = 'workspace_session_aliases'",
  ).get() as { name?: string } | undefined;
  assert.equal(table?.name, "workspace_session_aliases");
  const migration = migrated.sqlite.prepare(
    "select name from devspace_schema_migrations where version = 16",
  ).get() as { name?: string } | undefined;
  assert.equal(migration?.name, "workspace-session-aliases");
});

test("database migration adds component fingerprints to historical Workspace context deliveries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-migration-context-components-test-"));
  const databasePath = join(stateDir, "devspace.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );

    create table workspace_context_deliveries (
      conversation_scope_id text not null,
      target_key text not null,
      context_fingerprint text not null,
      delivered_at text not null,
      primary key (conversation_scope_id, target_key)
    );

    insert into workspace_context_deliveries (
      conversation_scope_id,
      target_key,
      context_fingerprint,
      delivered_at
    ) values ('chat-legacy', '/project', 'legacy-fingerprint', '2026-08-31T00:00:00.000Z');
  `);
  const recordMigration = legacy.prepare(
    "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
  );
  for (let version = 1; version <= 16; version += 1) {
    recordMigration.run(version, `legacy-${version}`, "2026-08-31T00:00:00.000Z");
  }
  legacy.close();

  const migrated = openDatabase(stateDir);
  t.after(async () => {
    migrated.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const columns = migrated.sqlite.prepare("pragma table_info(workspace_context_deliveries)").all() as Array<{
    name: string;
  }>;
  assert.equal(columns.some((column) => column.name === "component_fingerprints_json"), true);
  const historical = migrated.sqlite.prepare(`
    select context_fingerprint, component_fingerprints_json
      from workspace_context_deliveries
     where conversation_scope_id = 'chat-legacy' and target_key = '/project'
  `).get() as { context_fingerprint?: string; component_fingerprints_json?: string | null } | undefined;
  assert.equal(historical?.context_fingerprint, "legacy-fingerprint");
  assert.equal(historical?.component_fingerprints_json, null);
  const migration = migrated.sqlite.prepare(
    "select name from devspace_schema_migrations where version = 17",
  ).get() as { name?: string } | undefined;
  assert.equal(migration?.name, "workspace-context-components");
});

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
