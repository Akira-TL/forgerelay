import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHoverContents } from "./hover-normalization.js";

test("hover normalization keeps plaintext and markdown content stable", () => {
  assert.deepEqual(
    normalizeHoverContents({ kind: "plaintext", value: "target: () => void" }),
    { contents: "target: () => void" },
  );
  assert.deepEqual(
    normalizeHoverContents({ kind: "markdown", value: "**target**: `() => void`" }),
    { contents: "**target**: `() => void`" },
  );
});

test("hover normalization supports legacy MarkedString payloads", () => {
  assert.deepEqual(normalizeHoverContents("legacy hover"), { contents: "legacy hover" });
  assert.deepEqual(
    normalizeHoverContents({ language: "typescript", value: "const target: () => void" }),
    { contents: "const target: () => void", language: "typescript" },
  );
  assert.deepEqual(
    normalizeHoverContents([
      "Target signature:",
      { language: "typescript", value: "const target: () => void" },
    ]),
    { contents: "Target signature:\n\n```typescript\nconst target: () => void\n```" },
  );
});
