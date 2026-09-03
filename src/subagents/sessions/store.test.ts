import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../runtime/state/db/client.js";
import { SubagentSessionStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "forgerelay-subagent-store-test-"));
const stores: SubagentSessionStore[] = [];

try {
  const store = new SubagentSessionStore(root);
  stores.push(store);
  const created = store.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "reviewer",
    provider: "codex",
    model: "gpt-5.4",
    thinking: "high",
    activeRun: {
      id: "run_first",
      activityId: "act_first",
      startedAt: "2026-08-30T00:00:00.000Z",
    },
  });

  assert.match(created.id, /^agt_[a-f0-9]{8}$/);
  assert.equal(created.status, "running");
  assert.equal(created.activeRun?.id, "run_first");
  assert.equal(created.activeRun?.activityId, "act_first");
  assert.equal(store.get(created.id)?.thinking, "high");
  assert.equal(store.get(created.id)?.profileName, "reviewer");
  assert.equal(store.get(created.id.slice(0, 7))?.id, created.id);
  assert.equal(store.getInScope(created.id, { workspaceId: "ws_other" }), undefined);
  assert.equal(store.getInScope(created.id, { workspaceId: "ws_1" })?.id, created.id);

  const updated = store.update(created.id, {
    status: "idle",
    activeRun: undefined,
    providerSessionId: "thread_123",
    thinking: "medium",
    latestRun: {
      id: "run_first",
      status: "succeeded",
      finishedAt: "2026-08-30T00:01:00.000Z",
    },
  });

  assert.equal(updated.status, "idle");
  assert.equal(updated.thinking, "medium");
  assert.equal(updated.activeRun, undefined);
  assert.equal(updated.latestRun?.status, "succeeded");
  assert.equal(store.get("thread_123")?.id, created.id);
  assert.equal(store.get(created.id)?.thinking, "medium");
  assert.deepEqual(store.list({ workspaceId: "ws_1" }).map((agent) => agent.id), [created.id]);
  assert.deepEqual(store.list({ workspaceId: "ws_other" }), []);
  assert.deepEqual(store.list({ workspaceRoot: join(root, "other") }), []);

  const sqlite = openDatabase(root);
  try {
    const legacy = sqlite.sqlite.prepare(
      "select latest_response, error, hook_reports_json from local_agent_sessions where id = ?",
    ).get(created.id) as {
      latest_response: string | null;
      error: string | null;
      hook_reports_json: string | null;
    };
    assert.deepEqual(legacy, {
      latest_response: null,
      error: null,
      hook_reports_json: null,
    });
  } finally {
    sqlite.close();
  }

  const otherStore = new SubagentSessionStore(root);
  stores.push(otherStore);
  const createdFromOtherStore = otherStore.create({
    workspaceId: "ws_1",
    workspaceRoot: join(root, "project"),
    profileName: "explorer",
    provider: "claude",
  });

  assert.deepEqual(
    store.list({ workspaceId: "ws_1" }).map((agent) => agent.id).sort(),
    [created.id, createdFromOtherStore.id].sort(),
  );
} finally {
  for (const store of stores) {
    store.close();
  }
  rmSync(root, { recursive: true, force: true });
}
