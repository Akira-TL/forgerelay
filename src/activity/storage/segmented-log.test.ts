import assert from "node:assert/strict";
import { readdir, rm, stat } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SegmentedLogStore } from "./segmented-log.js";
import { ensurePrivateDirectory, stateRelativePath } from "./paths.js";

test("segmented log rolls over without creating oversized shard files", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "forgerelay-segmented-log-test-"));
  const directory = join(stateDir, "workspaces", "ws_segmented", "activity");
  ensurePrivateDirectory(directory);
  const prefixPath = join(directory, "events");
  const store = new SegmentedLogStore(stateDir, 16);
  const first = Buffer.from("abcdefghijkl", "utf8");
  const second = Buffer.from("mnopqrstuvwxyz0123456789", "utf8");

  t.after(async () => rm(stateDir, { recursive: true, force: true }));

  const firstRef = store.append(prefixPath, first);
  const secondRef = store.append(prefixPath, second);
  assert.equal(firstRef.prefix, stateRelativePath(stateDir, prefixPath));
  assert.deepEqual(store.read(firstRef), first);
  assert.deepEqual(store.read(secondRef), second);

  const files = (await readdir(directory)).filter((file) => file.startsWith("events.")).sort();
  assert.ok(files.length >= 2);
  for (const file of files) {
    assert.ok((await stat(join(directory, file))).size <= 16, `${file} exceeded shard limit`);
  }
});
