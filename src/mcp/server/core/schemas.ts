import * as z from "zod/v4";
import type { Workspace } from "../../../workspaces.js";

export function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

export const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export const workspaceSkillDiagnosticOutputSchema = z.object({
  type: z.enum(["warning", "error", "collision"]),
  message: z.string(),
  collision: z.object({
    resourceType: z.enum(["extension", "skill", "prompt", "theme"]),
    name: z.string(),
  }).optional(),
});

export function redactSkillDiagnosticPaths(
  diagnostics: Workspace["skillDiagnostics"],
): Array<z.infer<typeof workspaceSkillDiagnosticOutputSchema>> {
  return diagnostics.map((diagnostic) => {
    let message = diagnostic.message;
    const hiddenPaths = [
      diagnostic.path,
      diagnostic.collision?.winnerPath,
      diagnostic.collision?.loserPath,
    ].filter((path): path is string => Boolean(path));
    for (const path of hiddenPaths) {
      message = message.split(path).join("<skill-path>");
    }

    return {
      type: diagnostic.type,
      message,
      ...(diagnostic.collision
        ? {
            collision: {
              resourceType: diagnostic.collision.resourceType,
              name: diagnostic.collision.name,
            },
          }
        : {}),
    };
  });
}

export const capabilityFingerprintOutputSchema = z.object({
  version: z.string(),
  toolMode: z.enum(["minimal", "full", "codex"]),
  capabilities: z.array(z.string()),
});

export const capabilityGuideOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToRead: z.string(),
  path: z.string(),
});

export const capabilityCatalogGuideOutputSchema = z.object({
  name: z.string(),
  path: z.string(),
  readBeforeFirstUse: z.boolean(),
});

export const capabilityCatalogOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  batchPolicy: z.enum(["parallel", "serial", "unsupported"]),
  guide: capabilityCatalogGuideOutputSchema,
});

export const capabilityErrorOutputSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

export const workspaceSubagentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  continuationSupported: z.boolean(),
  reason: z.string().optional(),
});
export const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

export const managedWorktreeRecoveryOutputSchema = z.object({
  classification: z.enum(["healthy", "recoverable", "manual-intervention"]),
  conditions: z.array(z.enum([
    "backing-missing",
    "managed-branch-missing",
    "git-registration-stale",
    "git-registration-missing",
    "git-registration-unavailable",
    "branch-mismatch",
    "source-missing",
    "source-unavailable",
    "target-branch-missing",
  ])),
  backing: z.enum(["present", "missing"]),
  source: z.enum(["available", "missing", "unavailable"]),
  gitRegistration: z.enum(["registered", "stale", "missing", "unavailable"]),
  managedBranch: z.enum(["present", "missing", "unknown"]),
  targetBranch: z.enum(["present", "missing", "unknown"]),
  backingBranch: z.enum(["matching", "mismatched", "unavailable"]),
});

export const workspaceInventoryEntryOutputSchema = z.object({
  label: z.string(),
  workspaceId: z.string(),
  root: z.string(),
  status: z.string(),
  state: z.enum(["active", "stale", "invalid", "closed"]),
  mode: z.enum(["checkout", "worktree"]),
  sourceRoot: z.string().optional(),
  branch: z.string().optional(),
  targetBranch: z.string().optional(),
  managed: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  idleMs: z.number().nonnegative(),
  rootValid: z.boolean(),
  recovery: managedWorktreeRecoveryOutputSchema.optional(),
  current: z.boolean(),
});

export const workspaceInventorySummaryOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  matching: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

export const workspaceInventoryPageOutputSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});

export const workspaceTaskInspectionSummaryOutputSchema = z.object({
  level: z.literal("summary"),
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  lists: z.array(z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(["active", "archived"]),
    revision: z.number().int().positive(),
    taskCount: z.number().int().nonnegative(),
    unfinishedTaskCount: z.number().int().nonnegative(),
  })),
});

export const workspaceInspectionMemberOutputSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  workspaceId: z.string(),
  known: z.boolean(),
  location: z.enum(["local", "relay"]).optional(),
  state: z.enum(["active", "stale", "invalid", "closed"]).optional(),
  status: z.string().optional(),
  routeState: z.literal("known").optional(),
  mode: z.enum(["checkout", "worktree"]).optional(),
  rootValid: z.boolean().optional(),
});

export const workspaceInspectionOutputSchema = z.union([
  z.object({
    workspaceId: z.string(),
    kind: z.literal("workspace"),
    location: z.literal("local"),
    label: z.string(),
    root: z.string(),
    status: z.string(),
    state: z.enum(["active", "stale", "invalid", "closed"]),
    mode: z.enum(["checkout", "worktree"]),
    sourceRoot: z.string().optional(),
    branch: z.string().optional(),
    targetBranch: z.string().optional(),
    managed: z.boolean(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    idleMs: z.number().nonnegative(),
    rootValid: z.boolean(),
    recovery: managedWorktreeRecoveryOutputSchema.optional(),
    taskSummary: workspaceTaskInspectionSummaryOutputSchema.optional(),
  }),
  z.object({
    workspaceId: z.string(),
    kind: z.literal("workspace"),
    location: z.literal("relay"),
    root: z.string(),
    routeState: z.literal("known"),
    status: z.string().optional(),
    state: z.enum(["active", "stale", "invalid", "closed"]).optional(),
    mode: z.enum(["checkout", "worktree"]),
    sourceRoot: z.string().optional(),
    branch: z.string().optional(),
    targetBranch: z.string().optional(),
    managed: z.boolean().optional(),
    createdAt: z.string().optional(),
    lastUsedAt: z.string().optional(),
    idleMs: z.number().nonnegative().optional(),
    rootValid: z.boolean().optional(),
    recovery: managedWorktreeRecoveryOutputSchema.optional(),
    taskSummary: workspaceTaskInspectionSummaryOutputSchema.optional(),
    relay: z.string(),
    executionLocation: z.string(),
  }),
  z.object({
    workspaceId: z.string(),
    kind: z.literal("composite"),
    name: z.string(),
    status: z.enum(["active", "closed"]),
    state: z.enum(["active", "closed"]),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    members: z.array(workspaceInspectionMemberOutputSchema),
    taskSummary: workspaceTaskInspectionSummaryOutputSchema.optional(),
  }),
]);

export const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

export const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

