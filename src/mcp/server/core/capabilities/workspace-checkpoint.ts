import { z } from "zod";
import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityExecution,
  CapabilityRunOptions,
} from "../capability-registry.js";

export type WorkspaceCheckpointCapabilityInput =
  | {
      operation: "create";
      name: string;
    }
  | {
      operation: "list";
      offset?: number;
      limit?: number;
    }
  | {
      operation: "inspect";
      checkpointId: string;
    }
  | {
      operation: "restore.preflight";
      checkpointId: string;
    }
  | {
      operation: "restore";
      checkpointId: string;
      expectedCurrentSnapshot: string;
    }
  | {
      operation: "delete";
      checkpointId: string;
    };

export interface WorkspaceCheckpointCapabilityDependency {
  available: boolean;
  unavailableReason?: string;
  run: (
    input: WorkspaceCheckpointCapabilityInput,
    context: CapabilityContext,
    options: CapabilityRunOptions,
  ) => Promise<CapabilityExecution>;
}

export const workspaceCheckpointInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    name: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    operation: z.literal("list"),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    operation: z.literal("inspect"),
    checkpointId: z.string().regex(/^cp_[a-f0-9]{10}$/),
  }).strict(),
  z.object({
    operation: z.literal("restore.preflight"),
    checkpointId: z.string().regex(/^cp_[a-f0-9]{10}$/),
  }).strict(),
  z.object({
    operation: z.literal("restore"),
    checkpointId: z.string().regex(/^cp_[a-f0-9]{10}$/),
    expectedCurrentSnapshot: z.string().regex(/^[a-f0-9]{40,64}$/),
  }).strict(),
  z.object({
    operation: z.literal("delete"),
    checkpointId: z.string().regex(/^cp_[a-f0-9]{10}$/),
  }).strict(),
]);

export function workspaceCheckpointCapabilityDefinitions(
  dependency: WorkspaceCheckpointCapabilityDependency | undefined,
  availability: (
    context: CapabilityContext,
    available?: boolean,
    reason?: string,
  ) => { available: boolean; reason?: string },
): CapabilityDefinition[] {
  if (!dependency) return [];
  return [{
    name: "workspace.checkpoint",
    description: [
      "Create, list, inspect, safely restore, or delete immutable Git-backed checkpoints",
      "owned by the current persistent Workspace.",
    ].join(" "),
    guideName: "workspace-checkpoints",
    readGuideBeforeFirstUse: true,
    batchPolicy: "unsupported",
    inputSchema: workspaceCheckpointInputSchema,
    availability: (context) => availability(
      context,
      dependency.available,
      dependency.unavailableReason,
    ),
    run: async (input, context, options) =>
      dependency.run(input as WorkspaceCheckpointCapabilityInput, context, options),
  }];
}
