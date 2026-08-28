import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompositeWorkspaceRegistry } from "./composite-workspaces.js";

test("Composite Workspace identity survives Gateway registry restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-composite-workspaces-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const firstRegistry = new CompositeWorkspaceRegistry(stateDir);
  const created = firstRegistry.create("research-project");
  assert.match(created.id, /^cws_[a-f0-9]{10}$/);
  assert.equal(created.kind, "composite");
  assert.deepEqual(created.members, []);

  const restoredRegistry = new CompositeWorkspaceRegistry(stateDir);
  const restored = restoredRegistry.open(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.name, "research-project");
  assert.deepEqual(restored.members, []);
});
