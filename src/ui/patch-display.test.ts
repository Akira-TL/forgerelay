import assert from "node:assert/strict";
import { getPatchDisplayParts, getRenderedFileChangeKind } from "./patch-display.js";

assert.deepEqual(getPatchDisplayParts({}), {
  title: "Applied patch",
  tone: "edit",
});

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", operation: "add" }] }),
  {
    title: "Added 1 file",
    iconKind: "added",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "a.ts", operation: "add" },
      { path: "b.ts", operation: "add" },
    ],
  }),
  {
    title: "Added 2 files",
    iconKind: "added",
    tone: "write",
  },
);

assert.equal(
  getRenderedFileChangeKind(
    [
      { path: "same.tmp", operation: "add" },
      { path: "same.tmp", operation: "delete" },
    ],
    { path: "same.tmp", type: "new" },
    0,
  ),
  "added",
);

assert.equal(
  getRenderedFileChangeKind(
    [
      { path: "same.tmp", operation: "add" },
      { path: "same.tmp", operation: "delete" },
    ],
    { path: "same.tmp", type: "deleted" },
    1,
  ),
  "deleted",
);

assert.equal(
  getRenderedFileChangeKind(
    [{ path: "report.md", operation: "add" }],
    { path: "report.md", type: "change" },
    0,
  ),
  "edited",
);

assert.equal(
  getRenderedFileChangeKind(
    [{ path: "renamed.md", previousPath: "old.md", operation: "move" }],
    { path: "renamed.md", type: "change" },
    0,
  ),
  "renamed",
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "created.ts", type: "new" }] }),
  {
    title: "Added 1 file",
    iconKind: "added",
    tone: "write",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "renamed.ts", type: "rename-changed" }] }),
  {
    title: "Renamed and edited 1 file",
    iconKind: "renamed-edited",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "removed.ts", type: "deleted" }] }),
  {
    title: "Deleted 1 file",
    iconKind: "deleted",
    tone: "delete",
  },
);

assert.deepEqual(
  getPatchDisplayParts({ files: [{ path: "unknown.ts" }] }),
  {
    title: "Changed 1 file",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "created.ts", operation: "add" },
      { path: "edited.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 2 files",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "same.ts", operation: "add" },
      { path: "same.ts", operation: "update" },
    ],
  }),
  {
    title: "Changed 1 file",
    tone: "edit",
  },
);

assert.deepEqual(
  getPatchDisplayParts({
    files: [
      { path: "edited.ts", operation: "update" },
      { path: "moved.ts", previousPath: "old.ts", operation: "move" },
      { path: "removed.ts", operation: "delete" },
    ],
  }),
  {
    title: "Changed 3 files",
    tone: "edit",
  },
);
