import { z } from "zod";
import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityExecution,
  CapabilityRunOptions,
} from "../capability-registry.js";

export interface WorkspaceConversationHealthCapabilityDependency {
  available: boolean;
  unavailableReason?: string;
  run: (
    context: CapabilityContext,
    options: CapabilityRunOptions,
  ) => Promise<CapabilityExecution>;
}

export const workspaceConversationHealthInputSchema = z.object({}).strict();

export function workspaceConversationHealthCapabilityDefinitions(
  dependency: WorkspaceConversationHealthCapabilityDependency | undefined,
  availability: (
    context: CapabilityContext,
    available?: boolean,
    reason?: string,
  ) => { available: boolean; reason?: string },
): CapabilityDefinition[] {
  if (!dependency) return [];
  return [{
    name: "workspace.conversation-health",
    description: [
      "Inspect deterministic conversation-aging signals and bounded durable handoff metadata",
      "for the current Workspace.",
    ].join(" "),
    guideName: "workspace-conversation-health",
    readGuideBeforeFirstUse: true,
    batchPolicy: "unsupported",
    inputSchema: workspaceConversationHealthInputSchema,
    availability: (context) => availability(
      context,
      dependency.available,
      dependency.unavailableReason,
    ),
    run: async (_input, context, options) => dependency.run(context, options),
  }];
}
