import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { openAiConversationScopeId } from "../request-meta.js";
import { ActivityQueryService } from "./query-service.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const activitySummarySchema = z.object({
  activityId: z.string(),
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
});

const snapshotOutputSchema = {
  turnId: z.string(),
  revision: z.number().int().nonnegative(),
  changed: z.boolean(),
  state: z.enum(["working", "done", "error"]),
  activities: z.array(activitySummarySchema),
};

export function registerActivityQueryTools(
  server: McpServer,
  queries: ActivityQueryService,
): void {
  registerAppTool(
    server,
    "activity_panel",
    {
      title: "Begin Activity Panel",
      description:
        "Begin one ForgeRelay Host Turn lifecycle for subsequent project work. This orchestration call does not read or modify project files. Call it once before the first ForgeRelay work operation in a Host Turn that performs project work.",
      inputSchema: {},
      outputSchema: snapshotOutputSchema,
      _meta: { ui: { visibility: ["model", "app"] } },
      annotations: {
        ...READ_ONLY_ANNOTATIONS,
        idempotentHint: false,
      },
    },
    async (_input, extra) => {
      const snapshot = queries.beginTurn(openAiConversationScopeId(extra._meta));
      return {
        content: [{
          type: "text" as const,
          text: `Started ForgeRelay Activity Panel Host Turn ${snapshot.turnId}.`,
        }],
        structuredContent: { ...snapshot },
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
        turnId: z.string(),
        knownRevision: z.number().int().nonnegative().optional(),
      },
      outputSchema: snapshotOutputSchema,
      _meta: { ui: { visibility: ["app"] } },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ turnId, knownRevision }) => {
      const snapshot = queries.snapshot(turnId, knownRevision);
      return {
        content: [{
          type: "text" as const,
          text: snapshot.changed
            ? `Activity snapshot ${turnId} revision ${snapshot.revision}.`
            : `Activity snapshot ${turnId} unchanged at revision ${snapshot.revision}.`,
        }],
        structuredContent: { ...snapshot },
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
    async ({ turnId, activityId }) => {
      const detail = queries.detail(turnId, activityId);
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
    async ({ turnId, outputId }) => {
      const output = queries.bashOutput(turnId, outputId);
      return {
        content: [{ type: "text" as const, text: `Bash output ${outputId}.` }],
        structuredContent: { ...output },
      };
    },
  );
}
