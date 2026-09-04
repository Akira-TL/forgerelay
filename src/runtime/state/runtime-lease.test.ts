import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRuntimeLease,
  inspectRuntimeLease,
  runtimeLeasePath,
} from "./runtime-lease.js";

const root = mkdtempSync(join(tmpdir(), "forgerelay-runtime-lease-test-"));
try {
  const stateDir = join(root, "state");
  const lease = acquireRuntimeLease(stateDir);
  assert.equal(lease.pid, process.pid);
  assert.deepEqual(inspectRuntimeLease(stateDir), {
    path: runtimeLeasePath(stateDir),
    active: true,
    stale: false,
    pid: process.pid,
    malformed: false,
  });
  assert.throws(() => acquireRuntimeLease(stateDir), /already in use/);
  lease.release();
  assert.deepEqual(inspectRuntimeLease(stateDir), {
    path: runtimeLeasePath(stateDir),
    active: false,
    stale: false,
    malformed: false,
  });

  writeFileSync(runtimeLeasePath(stateDir), JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-runtime-token-00000000",
    startedAt: "2026-01-01T00:00:00.000Z",
  }));
  const stale = inspectRuntimeLease(stateDir);
  assert.equal(stale.active, false);
  assert.equal(stale.stale, true);
  const recovered = acquireRuntimeLease(stateDir);
  assert.equal(inspectRuntimeLease(stateDir).active, true);
  recovered.release();

  writeFileSync(runtimeLeasePath(stateDir), "not-json\n");
  const malformed = inspectRuntimeLease(stateDir);
  assert.equal(malformed.active, true);
  assert.equal(malformed.malformed, true);
  assert.throws(() => acquireRuntimeLease(stateDir), /unknown process/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
