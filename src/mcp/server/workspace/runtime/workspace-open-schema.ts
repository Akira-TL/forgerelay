import * as z from "zod/v4";
import {
  capabilityCatalogOutputSchema,
  capabilityFingerprintOutputSchema,
  capabilityGuideOutputSchema,
  workspaceAgentsFileOutputSchema,
  workspaceAvailableAgentsFileOutputSchema,
  workspaceInspectionOutputSchema,
  workspaceInventoryEntryOutputSchema,
  workspaceInventoryPageOutputSchema,
  workspaceInventorySummaryOutputSchema,
  workspaceLocalAgentOutputSchema,
  workspaceSkillDiagnosticOutputSchema,
  workspaceSkillOutputSchema,
  workspaceSubagentProviderOutputSchema,
} from "../../core/schemas.js";

export const openWorkspaceToolDefinition = 
{
  title: "Open workspace",
  description:
    "Open or resume a ForgeRelay Workspace. Ordinary workspaces default to local execution; relay may name a registered remote ForgeRelay. Composite Workspaces use the same open lifecycle but have kind=\"composite\" and a name instead of a mounted root. Reuse the returned workspaceId for later calls. Bootstrap context is delivered automatically only when needed and can be suppressed or refreshed.",
  inputSchema: {
    action: z
      .enum(["open", "list", "inspect", "member"])
      .optional()
      .describe("Defaults to open. Use list for lightweight inventory, inspect for bounded read-only metadata about one known Workspace without opening/resuming it, or member to change Composite membership."),
    memberAction: z
      .enum(["add", "update", "remove"])
      .optional()
      .describe("Required with action=member."),
    member: z.object({
      name: z.string().describe("Stable member name such as code or compute. For update/remove this identifies the existing member."),
      newName: z.string().optional().describe("Optional replacement member name for memberAction=update."),
      purpose: z.string().optional().describe("Agent-facing purpose. Required when adding a member; optional replacement when updating."),
      workspaceId: z.string().optional().describe("Existing ordinary or relayed Workspace to mount. Mutually exclusive with path."),
      path: z.string().optional().describe("Workspace path to open internally and mount. Mutually exclusive with workspaceId."),
      relay: z.string().optional().describe("Optional registered remote ForgeRelay alias for a path-backed member."),
      mode: z.enum(["checkout", "worktree"]).optional(),
      baseRef: z.string().optional(),
      newWorktree: z.boolean().optional(),
      newWorkspace: z.boolean().optional(),
    }).optional().describe("Composite member definition used by action=member."),
    kind: z
      .enum(["workspace", "composite"])
      .optional()
      .describe("Workspace kind for action=open. Defaults to workspace. Use composite with name and no path to create or reopen a named Composite Workspace."),
    name: z
      .string()
      .optional()
      .describe("Composite Workspace name. Used only with kind=\"composite\" when creating/opening by name."),
    memberName: z
      .string()
      .optional()
      .describe("For action=open on a Composite Workspace, load bootstrap context for this named member without making it an implicit current member."),
    path: z
      .string()
      .optional()
      .describe(
        "Project path to open for an ordinary Workspace. Required for action=open unless workspaceId is supplied or kind=\"composite\" with name is used. With mode=\"worktree\", this may also be a managed worktree path previously returned by ForgeRelay.",
      ),
    relay: z
      .string()
      .optional()
      .describe(
        "Optional registered remote ForgeRelay alias. When supplied for action=open, the workspace is opened and executed on that remote instance while this Gateway returns its own workspaceId.",
      ),
    workspaceId: z
      .string()
      .optional()
      .describe(
        "For action=open, an existing Workspace ID to resume or reuse. Historical duplicate IDs from earlier ForgeRelay versions may resolve to the canonical Workspace ID. For action=list, filters inventory. For action=inspect, identifies the single Workspace to inspect without opening or binding it.",
      ),
    mode: z
      .enum(["checkout", "worktree"])
      .optional()
      .describe(
        "For action=open, defaults to checkout and uses the actual directory unless worktree isolation is explicitly requested. For action=list, filters by workspace mode.",
      ),
    baseRef: z
      .string()
      .optional()
      .describe("Local branch to base a managed worktree on and eventually merge back into. Only used with mode=\"worktree\". Defaults to the source checkout's current branch."),
    newWorktree: z
      .boolean()
      .optional()
      .describe(
        "When true, create another isolated managed Git worktree instead of reusing the existing physical worktree. Use only when the user explicitly requests separate Git isolation.",
      ),
    newWorkspace: z
      .boolean()
      .optional()
      .describe(
        "Deprecated compatibility flag. It no longer creates another Workspace identity for the same physical checkout or managed worktree; ForgeRelay reuses that target's canonical Workspace. Use newWorktree=true when the user explicitly needs separate Git isolation.",
      ),
    context: z
      .enum(["auto", "full", "none"])
      .optional()
      .describe(
        "Bootstrap context policy for action=open. auto (default) sends full project context only when this conversation has not received the current context fingerprint; full forces a refresh; none opens/resumes without returning the full bootstrap context.",
      ),
    root: z
      .string()
      .optional()
      .describe("For action=list, filter by canonical workspace root or source root."),
    status: z
      .string()
      .optional()
      .describe("For action=list, filter by persisted workspace status such as active or closed."),
    state: z
      .enum(["active", "stale", "invalid", "closed"])
      .optional()
      .describe("For action=list, filter by derived lifecycle state."),
    staleOnly: z
      .boolean()
      .optional()
      .describe("For action=list, return only active Workspaces idle for more than two days."),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("For action=list, zero-based inventory offset. Defaults to 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("For action=list, maximum records to return. Defaults to 50; maximum 100."),
  },
  outputSchema: {
    action: z.enum(["open", "list", "inspect", "member"]),
    workspaceId: z.string().optional(),
    memberAction: z.enum(["add", "update", "remove"]).optional(),
    kind: z.enum(["workspace", "composite"]).optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    state: z.enum(["active", "stale", "invalid", "closed"]).optional(),
    members: z.array(z.object({
      name: z.string(),
      purpose: z.string(),
      workspaceId: z.string(),
    })).optional(),
    memberContext: z.unknown().optional(),
    root: z.string().optional(),
    mode: z.enum(["checkout", "worktree"]).optional(),
    sourceRoot: z.string().optional(),
    worktree: z
      .object({
        path: z.string(),
        baseRef: z.string(),
        baseSha: z.string(),
        branch: z.string().optional(),
        targetBranch: z.string().optional(),
        dirtySource: z.boolean(),
        detached: z.boolean(),
        managed: z.boolean(),
      })
      .optional(),
    worktrees: z.array(
      z.object({
        workspaceId: z.string(),
        path: z.string(),
        baseRef: z.string(),
        baseSha: z.string(),
        branch: z.string().optional(),
        targetBranch: z.string().optional(),
        managed: z.boolean(),
        current: z.boolean(),
      }),
    ).optional(),
    staleWorkspaces: z.array(
      z.object({
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        lastUsedAt: z.string(),
        idleMs: z.number().nonnegative(),
        branch: z.string().optional(),
        targetBranch: z.string().optional(),
        managed: z.boolean(),
      }),
    ).optional(),
    capabilityFingerprint: capabilityFingerprintOutputSchema.optional(),
    contextFingerprint: z.string().optional(),
    capabilityCatalog: z.array(capabilityCatalogOutputSchema).optional(),
    capabilityGuides: z.array(capabilityGuideOutputSchema).optional(),
    agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
    availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
    skills: z.array(workspaceSkillOutputSchema).optional(),
    agentProviders: z.array(workspaceSubagentProviderOutputSchema).optional(),
    agents: z.array(workspaceLocalAgentOutputSchema).optional(),
    skillDiagnostics: z.array(workspaceSkillDiagnosticOutputSchema).optional(),
    workspaces: z.array(workspaceInventoryEntryOutputSchema).optional(),
    compositeWorkspaces: z.array(z.object({
      workspaceId: z.string(),
      kind: z.literal("composite"),
      name: z.string(),
      status: z.enum(["active", "closed"]),
      state: z.enum(["active", "closed"]),
      members: z.array(z.object({
        name: z.string(),
        purpose: z.string(),
        workspaceId: z.string(),
      })),
      createdAt: z.string(),
      lastUsedAt: z.string(),
    })).optional(),
    summary: workspaceInventorySummaryOutputSchema.optional(),
    page: workspaceInventoryPageOutputSchema.optional(),
    inspection: workspaceInspectionOutputSchema.optional(),
    instruction: z.string(),
  },
  _meta: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export type OpenWorkspaceToolInput = z.infer<z.ZodObject<typeof openWorkspaceToolDefinition.inputSchema>>;
