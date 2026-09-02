import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preflightEditFiles } from "../filesystem-tools.js";

test("bulk Edit preflight reuses exact Edit validation without writing files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-edit-preflight-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "before common after\n");
  await writeFile(join(root, "b.txt"), "common and common\n");
  const context = { cwd: root, root, fileRoots: [root] };
  const edits = [{ oldText: "common", newText: "changed" }];

  await assert.rejects(
    preflightEditFiles(["a.txt", "b.txt"], edits, context),
    /unique|multiple|match/i,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before common after\n");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "common and common\n");

  await preflightEditFiles(["a.txt"], edits, context);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before common after\n");

  await assert.rejects(
    preflightEditFiles(["a.txt", "./a.txt"], edits, context),
    /overlap|same file/i,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "before common after\n");
});
