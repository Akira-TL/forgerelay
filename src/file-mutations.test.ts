import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { deletePath, renamePath } from "./file-mutations.js";

async function rootFixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "forgerelay-file-mutations-test-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  t.after(async () => rm(parent, { recursive: true, force: true }));
  return { root, outside };
}

test("rename moves a file without overwriting an existing destination", async (t) => {
  const { root } = await rootFixture(t);
  await writeFile(join(root, "before.txt"), "before\n");

  const renamed = await renamePath({ path: "before.txt", newPath: "after.txt" }, {
    cwd: root,
    allowedRoots: [root],
  });

  assert.deepEqual(renamed, { path: "before.txt", newPath: "after.txt" });
  assert.equal(await readFile(join(root, "after.txt"), "utf8"), "before\n");
  await assert.rejects(readFile(join(root, "before.txt"), "utf8"), /ENOENT/);

  await writeFile(join(root, "occupied.txt"), "occupied\n");
  await assert.rejects(
    renamePath({ path: "after.txt", newPath: "occupied.txt" }, { cwd: root, allowedRoots: [root] }),
    /already exists/i,
  );
});

test("rename validates both source and destination roots", async (t) => {
  const { root, outside } = await rootFixture(t);
  await writeFile(join(root, "inside.txt"), "inside\n");
  await writeFile(join(outside, "outside.txt"), "outside\n");

  await assert.rejects(
    renamePath({ path: "inside.txt", newPath: join(outside, "moved.txt") }, { cwd: root, allowedRoots: [root] }),
    /outside allowed roots/i,
  );
  await assert.rejects(
    renamePath({ path: join(outside, "outside.txt"), newPath: "moved.txt" }, { cwd: root, allowedRoots: [root] }),
    /outside allowed roots/i,
  );
});

test("delete removes files and empty directories, with recursive deletion explicit", async (t) => {
  const { root } = await rootFixture(t);
  await writeFile(join(root, "file.txt"), "file\n");
  await mkdir(join(root, "empty"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "child.txt"), "child\n");

  assert.deepEqual(
    await deletePath({ path: "file.txt" }, { cwd: root, allowedRoots: [root] }),
    { path: "file.txt", recursive: false },
  );
  await assert.rejects(readFile(join(root, "file.txt"), "utf8"), /ENOENT/);

  await deletePath({ path: "empty" }, { cwd: root, allowedRoots: [root] });
  await assert.rejects(lstat(join(root, "empty")), /ENOENT/);

  await assert.rejects(
    deletePath({ path: "nested" }, { cwd: root, allowedRoots: [root] }),
    /ENOTEMPTY|not empty/i,
  );
  await deletePath({ path: "nested", recursive: true }, { cwd: root, allowedRoots: [root] });
  await assert.rejects(lstat(join(root, "nested")), /ENOENT/);
});

test("rename and delete cannot mutate an allowed root itself", async (t) => {
  const { root } = await rootFixture(t);

  await assert.rejects(
    renamePath({ path: root, newPath: `${root}-moved` }, { cwd: root, allowedRoots: [root] }),
    /allowed root itself/i,
  );
  await assert.rejects(
    deletePath({ path: root, recursive: true }, { cwd: root, allowedRoots: [root] }),
    /allowed root itself/i,
  );
});

test("escaping symlinks cannot be renamed or deleted", async (t) => {
  if (process.platform === "win32") {
    t.skip("File symlink creation requires extra privileges on some Windows setups.");
    return;
  }

  const { root, outside } = await rootFixture(t);
  const outsideFile = join(outside, "outside.txt");
  const escaped = join(root, "escaped.txt");
  await writeFile(outsideFile, "outside\n");
  await symlink(outsideFile, escaped);

  await assert.rejects(
    renamePath({ path: escaped, newPath: join(root, "renamed.txt") }, { cwd: root, allowedRoots: [root] }),
    /outside allowed roots/i,
  );
  await assert.rejects(
    deletePath({ path: escaped }, { cwd: root, allowedRoots: [root] }),
    /outside allowed roots/i,
  );
});
