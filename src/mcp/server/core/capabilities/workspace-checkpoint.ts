import { z } from "zod";

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
