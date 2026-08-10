import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("workspace touches stay in memory until flush and close persists the latest values", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-workspace-store-test-"));
  let now = new Date("2026-08-10T00:00:00.000Z");
  const clock = () => new Date(now);
  const primary = new SqliteWorkspaceStore(stateDir, {
    now: clock,
    touchFlushIntervalMs: 60 * 60 * 1_000,
  });
  const observer = new SqliteWorkspaceStore(stateDir, {
    now: clock,
    touchFlushIntervalMs: 60 * 60 * 1_000,
  });
  let primaryClosed = false;

  t.after(async () => {
    if (!primaryClosed) primary.close();
    observer.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const created = primary.createSession({
    id: "ws_buffered",
    root: "/tmp/forgerelay-buffered-workspace",
  });
  assert.equal(created.lastUsedAt, "2026-08-10T00:00:00.000Z");
  assert.equal(observer.getSession("ws_buffered")?.lastUsedAt, created.lastUsedAt);

  now = new Date("2026-08-10T00:01:00.000Z");
  for (let index = 0; index < 100; index += 1) primary.touchSession("ws_buffered");
  assert.equal(primary.pendingTouchCount, 1);
  assert.equal(primary.getSession("ws_buffered")?.lastUsedAt, "2026-08-10T00:01:00.000Z");
  assert.equal(observer.getSession("ws_buffered")?.lastUsedAt, "2026-08-10T00:00:00.000Z");

  primary.flushTouches();
  assert.equal(primary.pendingTouchCount, 0);
  assert.equal(observer.getSession("ws_buffered")?.lastUsedAt, "2026-08-10T00:01:00.000Z");

  const binding = primary.setConversationBinding({
    conversationScopeId: "conversation-1",
    targetKey: "checkout:/tmp/forgerelay-buffered-workspace",
    workspaceSessionId: "ws_buffered",
  });
  assert.equal(binding.lastUsedAt, "2026-08-10T00:01:00.000Z");

  now = new Date("2026-08-10T00:02:00.000Z");
  primary.touchSession("ws_buffered");
  primary.touchConversationBinding(
    "conversation-1",
    "checkout:/tmp/forgerelay-buffered-workspace",
  );
  assert.equal(primary.pendingTouchCount, 2);
  assert.equal(
    primary.getConversationBinding(
      "conversation-1",
      "checkout:/tmp/forgerelay-buffered-workspace",
    )?.lastUsedAt,
    "2026-08-10T00:02:00.000Z",
  );
  assert.equal(
    observer.getConversationBinding(
      "conversation-1",
      "checkout:/tmp/forgerelay-buffered-workspace",
    )?.lastUsedAt,
    "2026-08-10T00:01:00.000Z",
  );

  primary.close();
  primaryClosed = true;
  assert.equal(observer.getSession("ws_buffered")?.lastUsedAt, "2026-08-10T00:02:00.000Z");
  assert.equal(
    observer.getConversationBinding(
      "conversation-1",
      "checkout:/tmp/forgerelay-buffered-workspace",
    )?.lastUsedAt,
    "2026-08-10T00:02:00.000Z",
  );
});
