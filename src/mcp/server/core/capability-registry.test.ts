import assert from "node:assert/strict";
import test from "node:test";
import {
  CapabilityError,
  createCapabilityRegistry,
  type CapabilityContext,
} from "./capability-registry.js";

const context: CapabilityContext = {
  workspaceId: "ws_test",
  workspaceKind: "workspace",
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

test("workspace.tasks is current-workspace scoped and exposes a strict serial task contract", async () => {
  const taskContext: CapabilityContext = {
    ...context,
    guides: [
      ...context.guides,
      {
        name: "workspace-tasks",
        description: "Persistent Task Lists owned by the current Workspace.",
        whenToRead: "Read before creating or maintaining Workspace Tasks.",
        path: "~/capabilities/workspace-tasks/GUIDE.md",
      },
    ],
  };
  const calls: Array<{ input: unknown; workspaceId: string }> = [];
  const registry = createCapabilityRegistry({
    inspectHooks: async () => ({ globalHooks: 0, projectHooks: 0 }),
    workspaceTasks: {
      available: true,
      run: async (input, capabilityContext) => {
        calls.push({ input, workspaceId: capabilityContext.workspaceId });
        return { value: { operation: input.operation, workspaceId: capabilityContext.workspaceId } };
      },
    },
  });

  const catalogEntry = registry.catalog(taskContext).find((entry) => entry.name === "workspace.tasks");
  assert.equal(catalogEntry?.batchPolicy, "serial");
  assert.equal(catalogEntry?.guide.name, "workspace-tasks");

  const described = registry.describe("workspace.tasks", taskContext);
  assert.equal(described.inputSchema.type, undefined);
  assert.ok(Array.isArray(described.inputSchema.anyOf));
  assert.equal(JSON.stringify(described.inputSchema).includes("workspaceId"), false);

  assert.deepEqual(
    await registry.run("workspace.tasks", { operation: "get" }, taskContext),
    { value: { operation: "get", workspaceId: taskContext.workspaceId } },
  );
  assert.deepEqual(
    await registry.run(
      "workspace.tasks",
      { operation: "get", level: "headers", listId: "tl_1234567890" },
      taskContext,
    ),
    { value: { operation: "get", workspaceId: taskContext.workspaceId } },
  );
  assert.deepEqual(
    await registry.run(
      "workspace.tasks",
      {
        operation: "get",
        level: "detail",
        listId: "tl_1234567890",
        taskId: "tsk_1234567890",
      },
      taskContext,
    ),
    { value: { operation: "get", workspaceId: taskContext.workspaceId } },
  );
  assert.deepEqual(
    await registry.run(
      "workspace.tasks",
      { operation: "list.create", name: "Release" },
      taskContext,
    ),
    { value: { operation: "list.create", workspaceId: taskContext.workspaceId } },
  );
  assert.deepEqual(
    await registry.run(
      "workspace.tasks",
      {
        operation: "task.create",
        listId: "tl_1234567890",
        subject: "Ship release",
        content: "Run acceptance and publish.",
        status: "in_progress",
        position: 0,
      },
      taskContext,
    ),
    { value: { operation: "task.create", workspaceId: taskContext.workspaceId } },
  );
  assert.equal(calls.every((call) => call.workspaceId === taskContext.workspaceId), true);

  await assert.rejects(
    () => registry.run(
      "workspace.tasks",
      { operation: "get", workspaceId: "ws_other" },
      taskContext,
    ),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => registry.run(
      "workspace.tasks",
      { operation: "get", level: "summary", listId: "tl_1234567890" },
      taskContext,
    ),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => registry.run(
      "workspace.tasks",
      { operation: "get", level: "detail", listId: "tl_1234567890" },
      taskContext,
    ),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => registry.run(
      "workspace.tasks",
      { operation: "task.update", listId: "tl_1234567890", taskId: "task_1234567890" },
      taskContext,
    ),
    (error: unknown) => error instanceof CapabilityError && error.code === "invalid_arguments",
  );
});

test("Composite capability context exposes workspace.tasks without a filesystem root", async () => {
  const compositeContext: CapabilityContext = {
    workspaceId: "cws_1234567890",
    workspaceKind: "composite",
    guides: [
      {
        name: "workspace-tasks",
        description: "Persistent Task Lists owned by the current Workspace.",
        whenToRead: "Read before creating or maintaining Workspace Tasks.",
        path: "~/capabilities/workspace-tasks/GUIDE.md",
      },
      ...context.guides,
    ],
  };
  const registry = createCapabilityRegistry({
    inspectHooks: async () => ({ globalHooks: 0, projectHooks: 0 }),
    workspaceTasks: {
      available: true,
      run: async (input, capabilityContext) => ({
        value: { operation: input.operation, workspaceId: capabilityContext.workspaceId },
      }),
    },
  });

  assert.deepEqual(registry.catalog(compositeContext).map((entry) => entry.name), ["workspace.tasks"]);
  assert.deepEqual(
    await registry.run("workspace.tasks", { operation: "get" }, compositeContext),
    { value: { operation: "get", workspaceId: compositeContext.workspaceId } },
  );
  const hooksDescription = registry.describe("hooks.check", compositeContext);
  assert.equal(hooksDescription.available, false);
  assert.match(hooksDescription.unavailableReason ?? "", /filesystem-backed Workspace/);
});

test("subagent.session is a deep batch-unsupported capability when explicitly enabled", async () => {
  const subagentContext: CapabilityContext = {
    ...context,
    guides: [
      ...context.guides,
      {
        name: "subagents",
        description: "Local Subagent delegation.",
        whenToRead: "Read before delegating.",
        path: "~/capabilities/subagents/GUIDE.md",
      },
    ],
  };
  const registry = createCapabilityRegistry({
    inspectHooks: async () => ({ globalHooks: 0, projectHooks: 0 }),
    subagentSession: {
      available: true,
      run: async (input) => ({ value: { operation: input.operation } }),
    },
  });

  const catalog = registry.catalog(subagentContext);
  const subagent = catalog.find((entry) => entry.name === "subagent.session");
  assert.equal(subagent?.batchPolicy, "unsupported");
  assert.equal(subagent?.guide.name, "subagents");
  assert.ok(Object.keys(registry.describe("subagent.session", subagentContext).inputSchema).length > 0);
  assert.deepEqual(
    await registry.run(
      "subagent.session",
      { operation: "list" },
      subagentContext,
    ),
    { value: { operation: "list" } },
  );
  await assert.rejects(
    () => registry.run(
      "subagent.session",
      { operation: "list" },
      subagentContext,
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
