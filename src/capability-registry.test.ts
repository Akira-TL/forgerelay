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
  assert.equal(described.guide.name, "lifecycle-hooks");
  assert.equal(described.inputSchema.type, "object");
  assert.deepEqual(described.inputSchema.properties, {});
  assert.equal(described.inputSchema.additionalProperties, false);

  assert.deepEqual(await registry.run("hooks.check", {}, context), {
    ok: true,
    globalHooks: 2,
    projectHooks: 1,
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
