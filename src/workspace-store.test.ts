import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("migrated bootstrap history suppresses repeats without blocking another project", async (t) => {
  const stateDir = await createLegacyBindingState(t);
  const store = new SqliteWorkspaceStore(stateDir);

  try {
    assert.equal(store.claimConversationBootstrap("chat-existing", "/tmp/project"), false);
    assert.equal(store.claimConversationBootstrap("chat-existing", "/tmp/other-project"), true);
  } finally {
    store.close();
  }
});

test("migration preserves its deterministic timestamp choice for duplicate historical targets", async (t) => {
  const stateDir = await createLegacyBindingState(t);
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
});

async function createLegacyBindingState(t: TestContext): Promise<string> {
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

  return stateDir;
}
