import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withFileLock } from "./file-lock.js";

test("withFileLock waits asynchronously without blocking the Node event loop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-file-lock-test-"));
  const lockPath = join(root, "state.lock");
  t.after(() => rm(root, { recursive: true, force: true }));

  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered = false;
  let secondEntered = false;

  const first = withFileLock(lockPath, async () => {
    firstEntered = true;
    await holdFirst;
  }, { retryMs: 5, timeoutMs: 1_000, staleMs: 5_000 });

  while (!firstEntered) await new Promise((resolve) => setTimeout(resolve, 1));

  let timerFired = false;
  const timer = new Promise<void>((resolve) => {
    setTimeout(() => {
      timerFired = true;
      resolve();
    }, 20);
  });
  const second = withFileLock(lockPath, async () => {
    secondEntered = true;
  }, { retryMs: 5, timeoutMs: 1_000, staleMs: 5_000 });

  await timer;
  assert.equal(timerFired, true);
  assert.equal(secondEntered, false);

  releaseFirst();
  await first;
  await second;
  assert.equal(secondEntered, true);
});

test("withFileLock recovers an abandoned stale lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-file-lock-stale-test-"));
  const lockPath = join(root, "state.lock");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(lockPath, "abandoned-owner\n", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  let entered = false;
  await withFileLock(lockPath, async () => {
    entered = true;
  }, { retryMs: 5, timeoutMs: 1_000, staleMs: 10 });

  assert.equal(entered, true);
});
