import { z } from "zod";
import type {
  ExternalMcpCapabilityInput,
  ExternalMcpCapabilityResult,
} from "../../../operations/external-mcp/external-mcp.js";
import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityExecution,
  CapabilityRunOptions,
} from "../capability-registry.js";

export interface ExternalMcpCapabilityDependency {
  available: boolean;
  unavailableReason?: string;
  run: (
    input: ExternalMcpCapabilityInput,
    context: CapabilityContext,
    options: CapabilityRunOptions,
  ) => Promise<CapabilityExecution & { value: ExternalMcpCapabilityResult }>;
}

const externalMcpInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("servers") }).strict(),
  z.object({
    operation: z.literal("tools"),
    server: z.string().min(1),
  }).strict(),
  z.object({
    operation: z.literal("call"),
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
]);

export function externalMcpCapabilityDefinitions(
  dependency: ExternalMcpCapabilityDependency | undefined,
): CapabilityDefinition[] {
  if (!dependency) return [];
  return [{
    name: "mcp.external",
    description: "Discover and call tools from user-configured external MCP servers through the ForgeRelay Capability gateway.",
    guideName: "external-mcp",
    readGuideBeforeFirstUse: true,
    batchPolicy: "unsupported",
    inputSchema: externalMcpInputSchema,
    availability: () => ({
      available: dependency.available,
      reason: dependency.unavailableReason,
    }),
    run: async (input: unknown, context: CapabilityContext, options: CapabilityRunOptions) =>
      dependency.run(input as ExternalMcpCapabilityInput, context, options),
  } satisfies CapabilityDefinition];
}
