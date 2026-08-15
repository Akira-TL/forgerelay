import { z, type ZodType } from "zod";
import {
  MAX_CODE_INTELLIGENCE_RESULT_LIMIT,
  type CodeIntelligenceInput,
} from "./lsp/code-intelligence-types.js";
import {
  batchExecuteInputSchema,
  type BatchExecuteInput,
} from "./operations/batch/types.js";

export type CapabilityErrorCode =
  | "unknown_capability"
  | "capability_unavailable"
  | "capability_batch_unsupported"
  | "invalid_arguments"
  | "execution_failed"
  | `artifact.${string}`
  | `code.${string}`;

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
  workspaceRoot: string;
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
      input: CodeIntelligenceInput,
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
  ]);

  return new CapabilityRegistry([
    {
      name: "hooks.check",
      description: "Validate the active ForgeRelay Hook configuration for this workspace.",
      guideName: "lifecycle-hooks",
      readGuideBeforeFirstUse: true,
      batchPolicy: "parallel",
      inputSchema: hooksCheckInput,
      availability: () => ({ available: true }),
      run: async (_input, context) => ({
        value: {
          ok: true,
          ...await dependencies.inspectHooks(context.workspaceRoot),
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
          availability: () => ({
            available: dependencies.reviewChanges?.available ?? false,
            reason: dependencies.reviewChanges?.unavailableReason,
          }),
          run: async (_input: unknown, context: CapabilityContext) => dependencies.reviewChanges!.run(context),
        } satisfies CapabilityDefinition]
      : []),
    ...(dependencies.codeIntelligence
      ? [{
          name: "code.intelligence",
          description: "Read semantic code information through an available Language server without changing the Workspace.",
          guideName: "code-intelligence",
          readGuideBeforeFirstUse: true,
          batchPolicy: "parallel",
          inputSchema: codeIntelligenceInput,
          availability: () => ({
            available: dependencies.codeIntelligence?.available ?? false,
            reason: dependencies.codeIntelligence?.unavailableReason,
          }),
          run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
            dependencies.codeIntelligence!.run(
              input as CodeIntelligenceInput,
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
          availability: () => ({
            available: dependencies.batchExecute?.available ?? false,
            reason: dependencies.batchExecute?.unavailableReason,
          }),
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
          availability: () => ({
            available: dependencies.downloadArtifact?.available ?? false,
            reason: dependencies.downloadArtifact?.unavailableReason,
          }),
          run: async (input: unknown, context: CapabilityContext) =>
            dependencies.downloadArtifact!.run(input as { file: unknown; path: string }, context),
        } satisfies CapabilityDefinition]
      : []),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
