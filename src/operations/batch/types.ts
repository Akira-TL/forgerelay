import { z } from "zod";

const taskId = z.string().min(1).max(128);
const path = z.string().min(1);
const capabilityName = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
const editEntry = z.object({
  oldText: z.string(),
  newText: z.string(),
}).strict();

export const batchCoreTaskSchema = z.discriminatedUnion("operation", [
  z.object({
    id: taskId,
    operation: z.literal("read"),
    path,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("write"),
    path,
    content: z.string(),
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("edit"),
    path,
    edits: z.array(editEntry).min(1),
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("rename"),
    path,
    newPath: path,
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("delete"),
    path,
    recursive: z.boolean().optional(),
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("capability.run"),
    name: capabilityName,
    arguments: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: taskId,
    operation: z.literal("bash.run"),
    command: z.string().min(1),
    tty: z.boolean().optional(),
    columns: z.number().int().min(1).max(1_000).optional(),
    rows: z.number().int().min(1).max(1_000).optional(),
    workingDirectory: z.string().optional(),
    yieldTimeMs: z.number().int().min(0).max(300_000).optional(),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    maxOutputTokens: z.number().int().positive().max(100_000).optional(),
  }).strict(),
]);

export const batchExecuteInputSchema = z.object({
  tasks: z.array(batchCoreTaskSchema).min(1).max(100),
  concurrency: z.number().int().min(1).max(10).optional(),
}).strict().superRefine((input, context) => {
  const ids = new Set<string>();
  for (const task of input.tasks) {
    if (ids.has(task.id)) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: `Batch task ids must be unique; duplicate id: ${task.id}.`,
      });
      return;
    }
    ids.add(task.id);
  }
});

export type BatchCoreTask = z.infer<typeof batchCoreTaskSchema>;
export type BatchExecuteInput = z.infer<typeof batchExecuteInputSchema>;

export interface BatchChildResult {
  id: string;
  operation: BatchCoreTask["operation"];
  status: "done" | "error";
  result?: {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: true;
  };
  error?: string;
}

export interface BatchExecuteValue {
  status: "done" | "partial";
  tasks: number;
  completed: number;
  failed: number;
  results: BatchChildResult[];
}
