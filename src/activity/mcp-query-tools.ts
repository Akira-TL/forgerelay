import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { logEvent, transportSessionIdPrefix, type LoggingConfig } from "../logger.js";
import { hostConversationScopeId } from "../request-meta.js";
import { ActivityQueryService } from "./query-service.js";
import {
  ACTIVITY_PANEL_DEFAULT_EXPANDED_META_KEY,
  ACTIVITY_PANEL_WORKSPACE_META_KEY,
} from "./ui/contract.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const activitySummarySchema = z.object({
  activityId: z.string(),
  parentActivityId: z.string().optional(),
  tool: z.string(),
  kind: z.string(),
  status: z.enum(["working", "done", "error"]),
  state: z.enum(["executing", "returned", "done", "failed", "blocked"]),
  title: z.string(),
  target: z.string(),
  detailAvailable: z.boolean(),
  workspaceId: z.string().optional(),
  processId: z.number().int().positive().optional(),
  outputId: z.string().optional(),
  commandLength: z.number().int().nonnegative().optional(),
  bashPhase: z.enum(["executing", "returned", "done", "error"]).optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  children: z.object({
    total: z.number().int().nonnegative(),
    working: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }).optional(),
});

const snapshotOutputSchema = {
  turnId: z.string(),
  revision: z.number().int().nonnegative(),
  changed: z.boolean(),
  state: z.enum(["working", "done", "error"]),
  activities: z.array(activitySummarySchema),
  [ACTIVITY_PANEL_WORKSPACE_META_KEY]: z.record(z.string(), z.unknown()).optional(),
};

export function registerActivityQueryTools(
  server: McpServer,
  queries: ActivityQueryService,
  connectionScopeId: string,
  panelMeta: Record<string, unknown> = {},
  panelDefaultExpanded = false,
  logging?: LoggingConfig,
  workspacePanelState?: (workspaceId: string) => Record<string, unknown> | undefined,
): void {
  const panelUi = typeof panelMeta.ui === "object" && panelMeta.ui !== null
    ? panelMeta.ui as Record<string, unknown>
    : {};
  registerAppTool(
    server,
    "activity_panel",
    {
      title: "Begin ForgeRelay Panel",
      description:
        "Begin one ForgeRelay Host Turn for project work in workspaceId as the single ForgeRelay UI render tool for that Workspace. If this Host Turn calls open_workspace, open_workspace must run first and its returned workspaceId must be passed here. A different workspaceId creates a different card. Call exactly once after workspace resolution and before the first non-lifecycle ForgeRelay work tool.",
      inputSchema: {
        workspaceId: z.string().min(1).describe(
          "Workspace identifier returned by open_workspace for the project work in this Host Turn.",
        ),
      },
      outputSchema: snapshotOutputSchema,
      _meta: {
        ...panelMeta,
        ui: {
          ...panelUi,
          visibility: ["model", "app"],
        },
      },
      annotations: {
        ...READ_ONLY_ANNOTATIONS,
        idempotentHint: false,
      },
    },
    async ({ workspaceId }, extra) => {
      const workspace = workspacePanelState?.(workspaceId);
      if (!workspace) {
        throw new Error(
          `No Workspace presentation is available for ${workspaceId}. Call open_workspace for that workspace before activity_panel.`,
        );
      }
      const snapshot = queries.beginTurn(
        hostConversationScopeId(extra._meta, extra.sessionId, connectionScopeId),
        workspaceId,
      );
      if (logging) {
        logEvent(logging, "debug", "activity_panel_call", {
          turnId: snapshot.turnId,
          revision: snapshot.revision,
          state: snapshot.state,
          activities: snapshot.activities.length,
          workspaceId,
          transportSessionIdPrefix: transportSessionIdPrefix(extra.sessionId),
        });
      }
      return {
        _meta: {
          [ACTIVITY_PANEL_DEFAULT_EXPANDED_META_KEY]: panelDefaultExpanded,
          [ACTIVITY_PANEL_WORKSPACE_META_KEY]: workspace,
        },
        content: [{
          type: "text" as const,
          text: `Started ForgeRelay Panel Host Turn ${snapshot.turnId} for ${workspaceId}.`,
        }],
        structuredContent: {
          ...snapshot,
          [ACTIVITY_PANEL_WORKSPACE_META_KEY]: workspace,
        },
      };
    },
  );

  registerAppTool(
    server,
    "activity_snapshot",
    {
      title: "Read Activity snapshot",
      description: "App-only data source for lightweight Activity summaries in one durable Host Turn.",
      inputSchema: {
        turnId: z.string().optional().describe(
          "Existing Host Turn identifier. Omit only for initial App bootstrap; ForgeRelay then resolves the current Host Turn from conversation metadata.",
        ),
        workspaceId: z.string().min(1).optional().describe(
          "Workspace identifier used by the App during initial bootstrap so ForgeRelay can restore the Workspace section.",
        ),
        knownRevision: z.number().int().nonnegative().optional(),
      },
      outputSchema: snapshotOutputSchema,
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ turnId, workspaceId, knownRevision }, extra) => {
      const conversationScopeId = hostConversationScopeId(
        extra._meta,
        extra.sessionId,
        connectionScopeId,
      );
      const resolvedTurnId = turnId ?? queries.currentTurnId(conversationScopeId, workspaceId);
      if (!resolvedTurnId) {
        throw new Error(
          "Activity snapshot bootstrap could not resolve the current Host Turn from conversation and workspace metadata.",
        );
      }
      const snapshot = queries.snapshot(resolvedTurnId, knownRevision);
      if (logging) {
        logEvent(logging, "debug", "activity_snapshot_call", {
          turnId: resolvedTurnId,
          bootstrap: turnId === undefined,
          knownRevision,
          revision: snapshot.revision,
          changed: snapshot.changed,
          state: snapshot.state,
          activities: snapshot.activities.length,
          transportSessionIdPrefix: transportSessionIdPrefix(extra.sessionId),
        });
      }
      const workspace = workspaceId ? workspacePanelState?.(workspaceId) : undefined;
      if (workspaceId && !workspace) {
        throw new Error(`No Workspace presentation is available for ${workspaceId}.`);
      }
      return {
        _meta: {
          [ACTIVITY_PANEL_DEFAULT_EXPANDED_META_KEY]: panelDefaultExpanded,
          ...(workspace ? { [ACTIVITY_PANEL_WORKSPACE_META_KEY]: workspace } : {}),
        },
        content: [{
          type: "text" as const,
          text: snapshot.changed
            ? `Activity snapshot ${resolvedTurnId} revision ${snapshot.revision}.`
            : `Activity snapshot ${resolvedTurnId} unchanged at revision ${snapshot.revision}.`,
        }],
        structuredContent: {
          ...snapshot,
          ...(workspace ? { [ACTIVITY_PANEL_WORKSPACE_META_KEY]: workspace } : {}),
        },
      };
    },
  );

  registerAppTool(
    server,
    "activity_detail",
    {
      title: "Read Activity detail",
      description: "App-only lazy data source for one selected expandable Activity.",
      inputSchema: {
        turnId: z.string(),
        activityId: z.string(),
      },
      outputSchema: {
        activity: activitySummarySchema,
        request: z.unknown().optional(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ turnId, activityId }, extra) => {
      const detail = queries.detail(turnId, activityId);
      if (logging) {
        logEvent(logging, "debug", "activity_detail_call", {
          turnId,
          activityId,
          tool: detail.activity.tool,
          kind: detail.activity.kind,
          state: detail.activity.state,
          transportSessionIdPrefix: transportSessionIdPrefix(extra.sessionId),
        });
      }
      return {
        content: [{ type: "text" as const, text: `Activity detail ${activityId}.` }],
        structuredContent: { ...detail },
      };
    },
  );

  registerAppTool(
    server,
    "activity_output",
    {
      title: "Read Bash output",
      description: "App-only lazy data source for complete durable Bash command/output by stable outputId.",
      inputSchema: {
        turnId: z.string(),
        outputId: z.string(),
      },
      outputSchema: {
        outputId: z.string(),
        activityId: z.string(),
        processId: z.number().int().positive(),
        command: z.string(),
        output: z.string(),
        status: z.enum(["running", "done", "failed"]),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        timedOut: z.boolean(),
        startedAt: z.string(),
        finishedAt: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ turnId, outputId }, extra) => {
      const output = queries.bashOutput(turnId, outputId);
      if (logging) {
        logEvent(logging, "debug", "activity_output_call", {
          turnId,
          outputId,
          activityId: output.activityId,
          processId: output.processId,
          status: output.status,
          outputBytes: Buffer.byteLength(output.output),
          transportSessionIdPrefix: transportSessionIdPrefix(extra.sessionId),
        });
      }
      return {
        content: [{ type: "text" as const, text: `Bash output ${outputId}.` }],
        structuredContent: { ...output },
      };
    },
  );
}
