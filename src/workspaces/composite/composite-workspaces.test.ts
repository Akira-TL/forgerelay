import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.equal(created.status, "active");
  assert.deepEqual(created.members, []);

  const restoredRegistry = new CompositeWorkspaceRegistry(stateDir);
  const restored = restoredRegistry.open(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(restored.name, "research-project");
  assert.equal(restored.status, "active");
  assert.deepEqual(restored.members, []);
});

test("Composite Workspace close preserves topology and reopen restores the same identity", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-composite-lifecycle-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const registry = new CompositeWorkspaceRegistry(stateDir);
  const created = registry.create("persistent-composite");
  registry.addMember(created.id, {
    name: "code",
    purpose: "Source work",
    workspaceId: "ws_source",
  });
  const beforeClose = registry.get(created.id);

  const closed = registry.close(created.id);
  assert.equal(closed.id, created.id);
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.members, beforeClose.members);
  assert.equal(registry.has(created.id), true);
  assert.equal(registry.isActive(created.id), false);
  assert.throws(() => registry.member(created.id, "code"), /is closed/i);
  assert.throws(
    () => registry.addMember(created.id, {
      name: "data",
      purpose: "Data work",
      workspaceId: "ws_data",
    }),
    /is closed/i,
  );

  const restoredClosed = new CompositeWorkspaceRegistry(stateDir);
  assert.equal(restoredClosed.get(created.id).status, "closed");
  assert.deepEqual(restoredClosed.get(created.id).members, beforeClose.members);

  const reopened = restoredClosed.open(created.id);
  assert.equal(reopened.id, created.id);
  assert.equal(reopened.status, "active");
  assert.deepEqual(reopened.members, beforeClose.members);
  assert.equal(restoredClosed.member(created.id, "code").workspaceId, "ws_source");

  const dissolved = restoredClosed.dissolve(created.id);
  assert.equal(dissolved.id, created.id);
  assert.equal(restoredClosed.has(created.id), false);
  assert.throws(() => restoredClosed.get(created.id), /Unknown Composite Workspace/);
});

test("legacy Composite Workspace state loads as active and upgrades on persistence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "forgerelay-composite-v1-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const statePath = join(stateDir, "composite-workspaces.json");
  await writeFile(statePath, JSON.stringify({
    version: 1,
    workspaces: [{
      id: "cws_1234567890",
      kind: "composite",
      name: "legacy-composite",
      members: [{ name: "code", purpose: "Legacy source", workspaceId: "ws_legacy" }],
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: "2026-08-01T00:00:00.000Z",
    }],
  }));

  const registry = new CompositeWorkspaceRegistry(stateDir);
  const legacy = registry.get("cws_1234567890");
  assert.equal(legacy.status, "active");
  registry.close(legacy.id);

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.workspaces[0]?.status, "closed");
});
