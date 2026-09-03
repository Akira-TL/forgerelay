import assert from "node:assert/strict";
import test from "node:test";
import { executeSequentialBulkMutation } from "./bulk-mutation.js";

test("sequential bulk mutation stops on the first failed child and marks remaining targets unexecuted", async () => {
  const calls: string[] = [];
  const execution = await executeSequentialBulkMutation({
    paths: ["a", "b", "c"],
    run: async (path) => {
      calls.push(path);
      return { isError: path === "b", result: path };
    },
    isError: (response) => response.isError,
    resultText: (response) => response.result,
  });

  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(execution.items.map(({ path, status }) => [path, status]), [
    ["a", "done"],
    ["b", "error"],
    ["c", "unexecuted"],
  ]);
  assert.deepEqual(
    { completed: execution.completed, failed: execution.failed, unexecuted: execution.unexecuted },
    { completed: 1, failed: 1, unexecuted: 1 },
  );
});

test("sequential bulk mutation reports thrown child failure and never starts later targets", async () => {
  const calls: string[] = [];
  const execution = await executeSequentialBulkMutation({
    paths: ["a", "b", "c"],
    run: async (path) => {
      calls.push(path);
      if (path === "b") throw new Error("disk failure");
      return { result: path };
    },
    isError: () => false,
    resultText: (response) => response.result,
  });

  assert.deepEqual(calls, ["a", "b"]);
  assert.match(execution.items[1]?.result ?? "", /disk failure/);
  assert.equal(execution.items[2]?.status, "unexecuted");
});
