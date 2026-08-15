import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityError,
  createCapabilityRegistry,
  type CapabilityContext,
} from "./capability-registry.js";

const context: CapabilityContext = {
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/project",
  guides: [
    {
      name: "lifecycle-hooks",
      description: "Hook events, blocking, reports, and configuration.",
      whenToRead: "Read for ForgeRelay Hook setup or debugging.",
      path: "~/capabilities/lifecycle-hooks/GUIDE.md",
    },
  ],
};

test("capability registry catalogs, describes, validates, and runs explicit capabilities", async () => {
  const registry = createCapabilityRegistry({
    inspectHooks: async (workspaceRoot) => {
      assert.equal(workspaceRoot, context.workspaceRoot);
      return { globalHooks: 2, projectHooks: 1 };
    },
  });

  assert.deepEqual(registry.catalog(context), [
    {
      name: "hooks.check",
      description: "Validate the active ForgeRelay Hook configuration for this workspace.",
      available: true,
      batchPolicy: "parallel",
      guide: {
        name: "lifecycle-hooks",
        path: "~/capabilities/lifecycle-hooks/GUIDE.md",
        readBeforeFirstUse: true,
      },
    },
  ]);

  const described = registry.describe("hooks.check", context);
  assert.equal(described.name, "hooks.check");
  assert.equal(described.available, true);
  assert.equal(described.batchPolicy, "parallel");
  assert.equal(described.guide.name, "lifecycle-hooks");
  assert.equal(described.inputSchema.type, "object");
  assert.deepEqual(described.inputSchema.properties, {});
  assert.equal(described.inputSchema.additionalProperties, false);

  assert.deepEqual(await registry.run("hooks.check", {}, context), {
    value: {
      ok: true,
      globalHooks: 2,
      projectHooks: 1,
    },
  });

  await assert.rejects(
    () => registry.run("hooks.check", { unexpected: true }, context),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );

  assert.throws(
    () => registry.describe("missing.capability", context),
    (error: unknown) => error instanceof CapabilityError && error.code === "unknown_capability",
  );

  await assert.rejects(
    () => registry.run("hooks.check", {}, { ...context, guides: [] }),
    (error: unknown) => error instanceof CapabilityError && error.code === "capability_unavailable",
  );
});

test("capability registry advertises only available optional capabilities and routes native files explicitly", async () => {
  const registry = createCapabilityRegistry({
    inspectHooks: async () => ({ globalHooks: 0, projectHooks: 0 }),
    reviewChanges: {
      available: false,
      unavailableReason: "Review mode is disabled.",
      run: async () => ({ value: { result: "unused" } }),
    },
    downloadArtifact: {
      available: true,
      run: async (input) => ({
        value: { path: input.path },
        changedPaths: [input.path],
      }),
    },
  });
  const artifactContext = {
    ...context,
    guides: [
      ...context.guides,
      {
        name: "artifacts-review",
        description: "Artifacts and review.",
        whenToRead: "Read for artifacts or review.",
        path: "~/capabilities/artifacts-review/GUIDE.md",
      },
    ],
  };

  assert.deepEqual(registry.catalog(artifactContext).map((entry) => entry.name), [
    "hooks.check",
    "artifact.download",
  ]);
  assert.equal(registry.describe("artifact.download", artifactContext).transport?.gatewayParameter, "file");
  assert.equal(registry.describe("artifact.download", artifactContext).batchPolicy, "unsupported");
  assert.equal(registry.batchPolicy("hooks.check"), "parallel");
  assert.equal(registry.batchPolicy("review.changes"), "serial");
  assert.equal(registry.batchPolicy("artifact.download"), "unsupported");
  assert.equal(registry.batchPolicy("missing.capability"), undefined);
  await assert.rejects(
    () => registry.run("review.changes", {}, artifactContext),
    (error: unknown) => error instanceof CapabilityError && error.code === "capability_unavailable",
  );
  assert.deepEqual(
    await registry.run(
      "artifact.download",
      { path: "downloads/result.txt" },
      artifactContext,
      {
        nativeFile: {
          download_url: "https://files.oaiusercontent.com/file_123/download",
          file_id: "file_123",
        },
      },
    ),
    {
      value: { path: "downloads/result.txt" },
      changedPaths: ["downloads/result.txt"],
    },
  );
  const sensitiveExtraValue = "Bearer should-not-leak";
  await assert.rejects(
    () => registry.run(
      "artifact.download",
      { path: "downloads/rejected.txt" },
      artifactContext,
      {
        nativeFile: {
          download_url: "https://files.oaiusercontent.com/file_123/download?sig=secret",
          file_id: "file_123",
          authorization: sensitiveExtraValue,
        },
      },
    ),
    (error: unknown) =>
      error instanceof CapabilityError
      && error.code === "invalid_arguments"
      && !error.message.includes(sensitiveExtraValue),
  );
  await assert.rejects(
    () => registry.run("hooks.check", {}, artifactContext, { nativeFile: {} }),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => registry.run(
      "artifact.download",
      { path: "downloads/no-batch.txt" },
      artifactContext,
      { batch: true },
    ),
    (error: unknown) =>
      error instanceof CapabilityError && error.code === "capability_batch_unsupported",
  );
});

test("capability registry converts handler failures into stable execution errors", async () => {
  const registry = createCapabilityRegistry({
    inspectHooks: async () => {
      throw new Error("Hook check failed: broken project hook");
    },
  });

  await assert.rejects(
    () => registry.run("hooks.check", {}, context),
    (error: unknown) =>
      error instanceof CapabilityError &&
      error.code === "execution_failed" &&
      /broken project hook/.test(error.message),
  );
});
