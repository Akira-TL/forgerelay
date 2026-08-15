import assert from "node:assert/strict";
import test from "node:test";
import { batchTaskIsExclusive } from "./executor.js";

const policy = (name: string): "parallel" | "serial" | "unsupported" | undefined => ({
  "hooks.check": "parallel",
  "review.changes": "serial",
  "artifact.download": "unsupported",
}[name] as "parallel" | "serial" | "unsupported" | undefined);

test("Batch executor maps serial Capability policy and Bash to exclusive scheduling", () => {
  assert.equal(batchTaskIsExclusive({
    id: "hooks",
    operation: "capability.run",
    name: "hooks.check",
    arguments: {},
  }, policy), false);
  assert.equal(batchTaskIsExclusive({
    id: "review",
    operation: "capability.run",
    name: "review.changes",
    arguments: {},
  }, policy), true);
  assert.equal(batchTaskIsExclusive({
    id: "artifact",
    operation: "capability.run",
    name: "artifact.download",
    arguments: {},
  }, policy), false);
  assert.equal(batchTaskIsExclusive({
    id: "shell",
    operation: "bash.run",
    command: "echo ok",
  }, policy), true);
  assert.equal(batchTaskIsExclusive({
    id: "read",
    operation: "read",
    path: "README.md",
  }, policy), false);
});
