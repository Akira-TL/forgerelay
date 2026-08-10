import { z, type ZodType } from "zod";

export type CapabilityErrorCode =
  | "unknown_capability"
  | "capability_unavailable"
  | "invalid_arguments"
  | "execution_failed";

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

export interface CapabilityCatalogEntry {
  name: string;
  description: string;
  available: boolean;
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
}

interface CapabilityDefinition {
  name: string;
  description: string;
  guideName: string;
  readGuideBeforeFirstUse: boolean;
  inputSchema: ZodType;
  availability: (context: CapabilityContext) => {
    available: boolean;
    reason?: string;
  };
  run: (input: unknown, context: CapabilityContext) => Promise<unknown>;
}

export interface CapabilityRegistryDependencies {
  inspectHooks: (workspaceRoot: string) => Promise<{
    globalHooks: number;
    projectHooks: number;
  }>;
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
        ...(!available && unavailableReason ? { unavailableReason } : {}),
        guide: {
          name: definition.guideName,
          path: guide?.path ?? "",
          readBeforeFirstUse: definition.readGuideBeforeFirstUse,
        },
      };
    });
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
    };
  }

  async run(name: string, argumentsValue: unknown, context: CapabilityContext): Promise<unknown> {
    const definition = this.requireDefinition(name);
    const catalogEntry = this.catalogEntry(definition, context);
    if (!catalogEntry.available) {
      throw new CapabilityError(
        "capability_unavailable",
        `Capability ${name} is unavailable${catalogEntry.unavailableReason ? `: ${catalogEntry.unavailableReason}` : "."}`,
      );
    }

    const parsed = definition.inputSchema.safeParse(argumentsValue ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`)
        .join("; ");
      throw new CapabilityError("invalid_arguments", `Invalid arguments for capability ${name}: ${details}`);
    }

    try {
      return await definition.run(parsed.data, context);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError(
        "execution_failed",
        `Capability ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  return new CapabilityRegistry([
    {
      name: "hooks.check",
      description: "Validate the active ForgeRelay Hook configuration for this workspace.",
      guideName: "lifecycle-hooks",
      readGuideBeforeFirstUse: true,
      inputSchema: hooksCheckInput,
      availability: () => ({ available: true }),
      run: async (_input, context) => ({
        ok: true,
        ...await dependencies.inspectHooks(context.workspaceRoot),
      }),
    },
  ]);
}
