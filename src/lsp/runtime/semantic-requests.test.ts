import assert from "node:assert/strict";
import test from "node:test";
import { CodeIntelligenceError } from "../code-intelligence-error.js";
import { SemanticRequestCoordinator } from "./semantic-requests.js";

test("semantic request coordinator returns stable cancellation for an already-aborted Host signal", async () => {
  const coordinator = new SemanticRequestCoordinator({ maxConcurrent: 1, maxQueued: 1, deadlineMs: 500 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    coordinator.run("test request", controller.signal, async () => "unreachable"),
    (error: unknown) =>
      error instanceof CodeIntelligenceError && error.code === "code.request_cancelled",
  );
});

test("semantic request coordinator cancels the LSP token on deadline", async () => {
  const coordinator = new SemanticRequestCoordinator({ maxConcurrent: 1, maxQueued: 1, deadlineMs: 30 });
  let observedCancellation = false;

  await assert.rejects(
    coordinator.run("slow request", undefined, async (token) => {
      await new Promise<void>((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("cancellation was not observed")), 500);
        const disposable = token.onCancellationRequested(() => {
          observedCancellation = true;
          clearTimeout(guard);
          disposable.dispose();
          resolve();
        });
      });
      return "late";
    }),
    (error: unknown) =>
      error instanceof CodeIntelligenceError && error.code === "code.request_timeout",
  );
  assert.equal(observedCancellation, true);
});
