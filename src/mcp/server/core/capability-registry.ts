import { z, type ZodType } from "zod";
import {
  MAX_CODE_INTELLIGENCE_RESULT_LIMIT,
  type CodeIntelligenceCapabilityInput,
} from "../../../lsp/code-intelligence-types.js";
import {
  batchExecuteInputSchema,
  type BatchExecuteInput,
} from "../../operations/batch/types.js";

export type CapabilityErrorCode =
  | "unknown_capability"
  | "capability_unavailable"
  | "capability_batch_unsupported"
  | "invalid_arguments"
  | "execution_failed"
  | `artifact.${string}`
  | `code.${string}`
  | `subagent.${string}`;

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export interface CapabilityGuideContext {
  name: string;
  description: string;
  whenToRead: string;
  path: string;
}

export interface CapabilityContext {
  workspaceId: string;
  workspaceKind: "workspace" | "composite";
  workspaceRoot?: string;
  guides: CapabilityGuideContext[];
}

export type CapabilityBatchPolicy = "parallel" | "serial" | "unsupported";

export interface CapabilityCatalogEntry {
  name: string;
  description: string;
  available: boolean;
  batchPolicy: CapabilityBatchPolicy;
  unavailableReason?: string;
  guide: {
    name: string;
    path: string;
    readBeforeFirstUse: boolean;
  };
}

export interface CapabilityDescription extends CapabilityCatalogEntry {
  guide: CapabilityCatalogEntry["guide"] & {
    description: string;
    whenToRead: string;
  };
  inputSchema: Record<string, unknown>;
  transport?: {
    nativeFileArgument: string;
    gatewayParameter: "file";
  };
}

export interface CapabilityExecution {
  value: unknown;
  changedPaths?: string[];
  card?: {
    summary?: object;
    files?: unknown[];
    payload?: Record<string, unknown>;
  };
}

export interface CapabilityRunOptions {
  nativeFile?: unknown;
  signal?: AbortSignal;
  requestMeta?: unknown;
  sessionId?: string;
  batch?: boolean;
  activityId?: string;
}

interface CapabilityDefinition {
  name: string;
  description: string;
  guideName: string;
  readGuideBeforeFirstUse: boolean;
  batchPolicy: CapabilityBatchPolicy;
  inputSchema: ZodType;
  nativeFileArgument?: string;
  availability: (context: CapabilityContext) => {
    available: boolean;
    reason?: string;
  };
  run: (
    input: unknown,
    context: CapabilityContext,
    options: CapabilityRunOptions,
  ) => Promise<CapabilityExecution>;
}

export type WorkspaceTasksCapabilityInput =
  | {
      operation: "get";
      level?: "summary";
    }
  | {
      operation: "get";
      level: "headers";
      listId?: string;
    }
  | {
      operation: "get";
      level: "detail";
      listId: string;
      taskId: string;
    }
  | {
      operation: "list.create";
      name: string;
      position?: number;
    }
  | {
      operation: "list.update";
      listId: string;
      name?: string;
      state?: "active" | "archived";
      position?: number;
    }
  | {
      operation: "list.delete";
      listId: string;
    }
  | {
      operation: "task.create";
      listId: string;
      subject: string;
      content?: string;
      status?: "pending" | "in_progress" | "completed";
      position?: number;
    }
  | {
      operation: "task.update";
      listId: string;
      taskId: string;
      subject?: string;
      content?: string;
      status?: "pending" | "in_progress" | "completed";
      position?: number;
    }
  | {
      operation: "task.delete";
      listId: string;
      taskId: string;
    };

export type SubagentSessionCapabilityInput =
  | {
      operation: "start";
      target: string;
      prompt: string;
      model?: string;
      thinking?: string;
    }
  | {
      operation: "resume";
      sessionId: string;
      prompt: string;
    }
  | {
      operation: "status";
      sessionId: string;
    }
  | {
      operation: "stop";
      sessionId: string;
    }
  | {
      operation: "delete";
      sessionId: string;
    }
  | {
      operation: "list";
    };

export interface CapabilityRegistryDependencies {
  inspectHooks: (workspaceRoot: string) => Promise<{
    globalHooks: number;
    projectHooks: number;
  }>;
  reviewChanges?: {
    available: boolean;
    unavailableReason?: string;
    run: (context: CapabilityContext) => Promise<CapabilityExecution>;
  };
  downloadArtifact?: {
    available: boolean;
    unavailableReason?: string;
    run: (
      input: { file: unknown; path: string },
      context: CapabilityContext,
    ) => Promise<CapabilityExecution>;
  };
  codeIntelligence?: {
    available: boolean;
    unavailableReason?: string;
    run: (
      input: CodeIntelligenceCapabilityInput,
      context: CapabilityContext,
      options: CapabilityRunOptions,
    ) => Promise<CapabilityExecution>;
  };
  batchExecute?: {
    available: boolean;
    unavailableReason?: string;
    run: (
      input: BatchExecuteInput,
      context: CapabilityContext,
      options: CapabilityRunOptions,
    ) => Promise<CapabilityExecution>;
  };
  workspaceTasks?: {
    available: boolean;
    unavailableReason?: string;
    run: (
      input: WorkspaceTasksCapabilityInput,
      context: CapabilityContext,
      options: CapabilityRunOptions,
    ) => Promise<CapabilityExecution>;
  };
  subagentSession?: {
    available: boolean;
    unavailableReason?: string;
    run: (
      input: SubagentSessionCapabilityInput,
      context: CapabilityContext,
      options: CapabilityRunOptions,
    ) => Promise<CapabilityExecution>;
  };
}

export class CapabilityRegistry {
  private readonly definitions: Map<string, CapabilityDefinition>;

  constructor(definitions: readonly CapabilityDefinition[]) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  catalog(context: CapabilityContext): CapabilityCatalogEntry[] {
    return [...this.definitions.values()].map((definition) => {
      const guide = context.guides.find((candidate) => candidate.name === definition.guideName);
      const availability = definition.availability(context);
      const available = Boolean(guide) && availability.available;
      const unavailableReason = !guide
        ? `Capability guide ${definition.guideName} is unavailable.`
        : availability.reason;
      return {
        name: definition.name,
        description: definition.description,
        available,
        batchPolicy: definition.batchPolicy,
        ...(!available && unavailableReason ? { unavailableReason } : {}),
        guide: {
          name: definition.guideName,
          path: guide?.path ?? "",
          readBeforeFirstUse: definition.readGuideBeforeFirstUse,
        },
      };
    }).filter((entry) => entry.available);
  }

  describe(name: string, context: CapabilityContext): CapabilityDescription {
    const definition = this.requireDefinition(name);
    const catalogEntry = this.catalogEntry(definition, context);
    const guide = context.guides.find((candidate) => candidate.name === definition.guideName);
    if (!guide) {
      throw new CapabilityError(
        "capability_unavailable",
        `Capability ${name} is unavailable: capability guide ${definition.guideName} is unavailable.`,
      );
    }

    return {
      ...catalogEntry,
      guide: {
        ...catalogEntry.guide,
        description: guide.description,
        whenToRead: guide.whenToRead,
      },
      inputSchema: z.toJSONSchema(definition.inputSchema, { target: "draft-7" }) as Record<string, unknown>,
      ...(definition.nativeFileArgument
        ? {
            transport: {
              nativeFileArgument: definition.nativeFileArgument,
              gatewayParameter: "file" as const,
            },
          }
        : {}),
    };
  }

  async run(
    name: string,
    argumentsValue: unknown,
    context: CapabilityContext,
    options: CapabilityRunOptions = {},
  ): Promise<CapabilityExecution> {
    const definition = this.requireDefinition(name);
    const catalogEntry = this.catalogEntry(definition, context);
    if (!catalogEntry.available) {
      throw new CapabilityError(
        "capability_unavailable",
        `Capability ${name} is unavailable${catalogEntry.unavailableReason ? `: ${catalogEntry.unavailableReason}` : "."}`,
      );
    }

    if (options.batch && definition.batchPolicy === "unsupported") {
      throw new CapabilityError(
        "capability_batch_unsupported",
        `Capability ${name} is not supported inside batch.execute.`,
      );
    }

    if (options.nativeFile !== undefined && !definition.nativeFileArgument) {
      throw new CapabilityError(
        "invalid_arguments",
        `Capability ${name} does not accept a Host-native file value.`,
      );
    }
    const input = definition.nativeFileArgument && options.nativeFile !== undefined
      ? { ...(isRecord(argumentsValue) ? argumentsValue : {}), [definition.nativeFileArgument]: options.nativeFile }
      : argumentsValue ?? {};
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`)
        .join("; ");
      throw new CapabilityError("invalid_arguments", `Invalid arguments for capability ${name}: ${details}`);
    }

    try {
      return await definition.run(parsed.data, context, options);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError(
        "execution_failed",
        `Capability ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  batchPolicy(name: string): CapabilityBatchPolicy | undefined {
    return this.definitions.get(name)?.batchPolicy;
  }

  private requireDefinition(name: string): CapabilityDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new CapabilityError("unknown_capability", `Unknown capability: ${name}`);
    }
    return definition;
  }

  private catalogEntry(
    definition: CapabilityDefinition,
    context: CapabilityContext,
  ): CapabilityCatalogEntry {
    const guide = context.guides.find((candidate) => candidate.name === definition.guideName);
    const availability = definition.availability(context);
    const available = Boolean(guide) && availability.available;
    const unavailableReason = !guide
      ? `Capability guide ${definition.guideName} is unavailable.`
      : availability.reason;
    return {
      name: definition.name,
      description: definition.description,
      available,
      batchPolicy: definition.batchPolicy,
      ...(!available && unavailableReason ? { unavailableReason } : {}),
      guide: {
        name: definition.guideName,
        path: guide?.path ?? "",
        readBeforeFirstUse: definition.readGuideBeforeFirstUse,
      },
    };
  }
}

export function createCapabilityRegistry(
  dependencies: CapabilityRegistryDependencies,
): CapabilityRegistry {
  const hooksCheckInput = z.object({}).strict();
  const positionInput = {
    path: z.string().min(1),
    line: z.number().int(),
    column: z.number().int(),
  };
  const workspaceTaskStatus = z.enum(["pending", "in_progress", "completed"]);
  const workspaceTaskListState = z.enum(["active", "archived"]);
  const workspaceTasksInput = z.union([
    z.object({
      operation: z.literal("get"),
      level: z.literal("summary").optional(),
    }).strict(),
    z.object({
      operation: z.literal("get"),
      level: z.literal("headers"),
      listId: z.string().min(1).optional(),
    }).strict(),
    z.object({
      operation: z.literal("get"),
      level: z.literal("detail"),
      listId: z.string().min(1),
      taskId: z.string().min(1),
    }).strict(),
    z.object({
      operation: z.literal("list.create"),
      name: z.string().trim().min(1),
      position: z.number().int().min(0).optional(),
    }).strict(),
    z.object({
      operation: z.literal("list.update"),
      listId: z.string().min(1),
      name: z.string().trim().min(1).optional(),
      state: workspaceTaskListState.optional(),
      position: z.number().int().min(0).optional(),
    }).strict().refine(
      (input) => input.name !== undefined || input.state !== undefined || input.position !== undefined,
      { message: "list.update requires at least one field to change" },
    ),
    z.object({
      operation: z.literal("list.delete"),
      listId: z.string().min(1),
    }).strict(),
    z.object({
      operation: z.literal("task.create"),
      listId: z.string().min(1),
      subject: z.string().trim().min(1),
      content: z.string().optional(),
      status: workspaceTaskStatus.optional(),
      position: z.number().int().min(0).optional(),
    }).strict(),
    z.object({
      operation: z.literal("task.update"),
      listId: z.string().min(1),
      taskId: z.string().min(1),
      subject: z.string().trim().min(1).optional(),
      content: z.string().optional(),
      status: workspaceTaskStatus.optional(),
      position: z.number().int().min(0).optional(),
    }).strict().refine(
      (input) =>
        input.subject !== undefined
        || input.content !== undefined
        || input.status !== undefined
        || input.position !== undefined,
      { message: "task.update requires at least one field to change" },
    ),
    z.object({
      operation: z.literal("task.delete"),
      listId: z.string().min(1),
      taskId: z.string().min(1),
    }).strict(),
  ]);
  const subagentSessionInput = z.discriminatedUnion("operation", [
    z.object({
      operation: z.literal("start"),
      target: z.string().min(1),
      prompt: z.string().min(1),
      model: z.string().min(1).optional(),
      thinking: z.string().min(1).optional(),
    }).strict(),
    z.object({
      operation: z.literal("resume"),
      sessionId: z.string().min(1),
      prompt: z.string().min(1),
    }).strict(),
    z.object({
      operation: z.literal("status"),
      sessionId: z.string().min(1),
    }).strict(),
    z.object({
      operation: z.literal("stop"),
      sessionId: z.string().min(1),
    }).strict(),
    z.object({
      operation: z.literal("delete"),
      sessionId: z.string().min(1),
    }).strict(),
    z.object({ operation: z.literal("list") }).strict(),
  ]);
  const codeIntelligenceInput = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("definition"), ...positionInput }).strict(),
    z.object({ operation: z.literal("hover"), ...positionInput }).strict(),
    z.object({
      operation: z.literal("references"),
      ...positionInput,
      limit: z.number().int().min(1).max(MAX_CODE_INTELLIGENCE_RESULT_LIMIT).optional(),
    }).strict(),
    z.object({
      operation: z.literal("documentSymbols"),
      path: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_CODE_INTELLIGENCE_RESULT_LIMIT).optional(),
    }).strict(),
    z.object({
      operation: z.literal("workspaceSymbols"),
      path: z.string().min(1),
      query: z.string(),
      limit: z.number().int().min(1).max(MAX_CODE_INTELLIGENCE_RESULT_LIMIT).optional(),
    }).strict(),
    z.object({
      operation: z.literal("diagnostics"),
      path: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_CODE_INTELLIGENCE_RESULT_LIMIT).optional(),
    }).strict(),
    z.object({ operation: z.literal("managed.status") }).strict(),
    z.object({
      operation: z.literal("managed.install"),
      servers: z.array(z.enum(["typescript", "pyright"])).min(1),
    }).strict(),
  ]);

  return new CapabilityRegistry([
    {
      name: "hooks.check",
      description: "Validate the active ForgeRelay Hook configuration for this workspace.",
      guideName: "lifecycle-hooks",
      readGuideBeforeFirstUse: true,
      batchPolicy: "parallel",
      inputSchema: hooksCheckInput,
      availability: (context) => filesystemWorkspaceAvailability(context),
      run: async (_input, context) => ({
        value: {
          ok: true,
          ...await dependencies.inspectHooks(requireWorkspaceRoot(context)),
        },
      }),
    },
    ...(dependencies.reviewChanges
      ? [{
          name: "review.changes",
          description: "Review accumulated workspace changes from the Git-backed review checkpoint.",
          guideName: "artifacts-review",
          readGuideBeforeFirstUse: true,
          batchPolicy: "serial",
          inputSchema: z.object({}).strict(),
          availability: (context) => filesystemWorkspaceAvailability(
            context,
            dependencies.reviewChanges?.available ?? false,
            dependencies.reviewChanges?.unavailableReason,
          ),
          run: async (_input: unknown, context: CapabilityContext) => dependencies.reviewChanges!.run(context),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.codeIntelligence
      ? [{
          name: "code.intelligence",
          description: "Read semantic code information and, when explicitly enabled by the user, manage ForgeRelay-owned Language Servers for this instance.",
          guideName: "code-intelligence",
          readGuideBeforeFirstUse: true,
          batchPolicy: "parallel",
          inputSchema: codeIntelligenceInput,
          availability: (context) => filesystemWorkspaceAvailability(
            context,
            dependencies.codeIntelligence?.available ?? false,
            dependencies.codeIntelligence?.unavailableReason,
          ),
          run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
            dependencies.codeIntelligence!.run(
              input as CodeIntelligenceCapabilityInput,
              context,
              options,
            ),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.workspaceTasks
      ? [{
          name: "workspace.tasks",
          description: "Maintain persistent Task Lists owned by the current Workspace.",
          guideName: "workspace-tasks",
          readGuideBeforeFirstUse: true,
          batchPolicy: "serial",
          inputSchema: workspaceTasksInput,
          availability: () => ({
            available: dependencies.workspaceTasks?.available ?? false,
            reason: dependencies.workspaceTasks?.unavailableReason,
          }),
          run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
            dependencies.workspaceTasks!.run(
              input as WorkspaceTasksCapabilityInput,
              context,
              options,
            ),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.subagentSession
      ? [{
          name: "subagent.session",
          description: "Delegate explicit work to provider-backed Subagent Sessions in the current Execution Workspace; disclose delegation and verify returned results before presenting them as final.",
          guideName: "subagents",
          readGuideBeforeFirstUse: true,
          batchPolicy: "unsupported",
          inputSchema: subagentSessionInput,
          availability: (context) => filesystemWorkspaceAvailability(
            context,
            dependencies.subagentSession?.available ?? false,
            dependencies.subagentSession?.unavailableReason,
          ),
          run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
            dependencies.subagentSession!.run(
              input as SubagentSessionCapabilityInput,
              context,
              options,
            ),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.batchExecute
      ? [{
          name: "batch.execute",
          description: "Execute multiple independent ForgeRelay core operations in one Agent interaction.",
          guideName: "batch-execution",
          readGuideBeforeFirstUse: true,
          batchPolicy: "unsupported",
          inputSchema: batchExecuteInputSchema,
          availability: (context) => filesystemWorkspaceAvailability(
            context,
            dependencies.batchExecute?.available ?? false,
            dependencies.batchExecute?.unavailableReason,
          ),
          run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
            dependencies.batchExecute!.run(input as BatchExecuteInput, context, options),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.downloadArtifact
      ? [{
          name: "artifact.download",
          description: "Save one Host-native file into a workspace-relative destination without overwriting.",
          guideName: "artifacts-review",
          readGuideBeforeFirstUse: true,
          batchPolicy: "unsupported",
          inputSchema: z.object({
            file: z.strictObject({
              download_url: z.string(),
              file_id: z.string(),
              mime_type: z.string().nullable().optional(),
              file_name: z.string().nullable().optional(),
              name: z.string().nullable().optional(),
              size: z.number().int().nonnegative().nullable().optional(),
            }),
            path: z.string().min(1),
          }).strict(),
          nativeFileArgument: "file",
          availability: (context) => filesystemWorkspaceAvailability(
            context,
            dependencies.downloadArtifact?.available ?? false,
            dependencies.downloadArtifact?.unavailableReason,
          ),
          run: async (input: unknown, context: CapabilityContext) =>
            dependencies.downloadArtifact!.run(input as { file: unknown; path: string }, context),
        } satisfies CapabilityDefinition]
      : []),
  ]);
}

function filesystemWorkspaceAvailability(
  context: CapabilityContext,
  available = true,
  reason?: string,
): { available: boolean; reason?: string } {
  if (context.workspaceKind !== "workspace" || !context.workspaceRoot) {
    return {
      available: false,
      reason: "This capability requires a filesystem-backed Workspace.",
    };
  }
  return { available, ...(reason ? { reason } : {}) };
}

function requireWorkspaceRoot(context: CapabilityContext): string {
  if (context.workspaceKind !== "workspace" || !context.workspaceRoot) {
    throw new CapabilityError(
      "capability_unavailable",
      "This capability requires a filesystem-backed Workspace.",
    );
  }
  return context.workspaceRoot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
