import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("migration backfills a deterministic bootstrap row from historical target keys", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const initial = openDatabase(stateDir);
  try {
    initial.sqlite.prepare(`
      insert into workspace_sessions (
        id, root, status, mode, managed, created_at, last_used_at
      ) values (?, ?, 'active', 'worktree', 'true', ?, ?)
    `).run(
      "ws_existing",
      "/tmp/project-worktree",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    initial.sqlite.prepare(`
      insert into workspace_conversation_bindings (
        conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at
      ) values (?, ?, ?, ?, ?)
    `).run(
      "chat-existing",
      JSON.stringify(["worktree", "/tmp/project", "HEAD"]),
      "ws_existing",
      "2026-01-01T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    );
    initial.sqlite.prepare(`
      insert into workspace_conversation_bindings (
        conversation_scope_id, target_key, workspace_session_id, created_at, last_used_at
      ) values (?, ?, ?, ?, ?)
    `).run(
      "chat-existing",
      JSON.stringify(["checkout", "/tmp/project", null]),
      "ws_existing",
      "2026-01-01T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    );
    initial.sqlite.exec(`
      drop table workspace_conversation_bootstraps;
      delete from devspace_schema_migrations where version = 5;
    `);
  } finally {
    initial.close();
  }

  const migrated = openDatabase(stateDir);
  try {
    assert.deepEqual(
      migrated.sqlite.prepare(`
        select conversation_scope_id, project_key, created_at, last_used_at
        from workspace_conversation_bootstraps
      `).all(),
      [{
        conversation_scope_id: "chat-existing",
        project_key: "/tmp/project",
        created_at: "2026-01-01T00:00:00.000Z",
        last_used_at: "2026-01-03T00:00:00.000Z",
      }],
    );
  } finally {
    migrated.close();
  }

  const migratedStore = new SqliteWorkspaceStore(stateDir);
  try {
    assert.equal(migratedStore.claimConversationBootstrap("chat-existing", "/tmp/project"), false);
  } finally {
    migratedStore.close();
  }
});
