import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompositeWorkspaceRegistry } from "./composite-workspaces.js";

test("Composite Workspace members can be updated, renamed, and restored", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-composite-members-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const registry = new CompositeWorkspaceRegistry(stateDir);
  const created = registry.create("member-update");
  registry.addMember(created.id, {
    name: "code",
    purpose: "Source control",
    workspaceId: "ws_source",
  });
  registry.addMember(created.id, {
    name: "compute",
    purpose: "Computation",
    workspaceId: "ws_compute",
  });

  const updated = registry.updateMember(created.id, "code", {
    name: "source",
    purpose: "Source control and review",
    workspaceId: "ws_source_next",
  });
  assert.deepEqual(updated.members, [
    {
      name: "source",
      purpose: "Source control and review",
      workspaceId: "ws_source_next",
    },
    {
      name: "compute",
      purpose: "Computation",
      workspaceId: "ws_compute",
    },
  ]);
  assert.throws(
    () => registry.updateMember(created.id, "source", { name: "compute" }),
    /already has member compute/,
  );

  const restored = new CompositeWorkspaceRegistry(stateDir).open(created.id);
  assert.deepEqual(restored.members, updated.members);
});

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
