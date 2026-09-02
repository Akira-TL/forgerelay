import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import { ActivityAuditStore, type ActivityWorkspaceSnapshot } from "./activity/audit-store.js";
import { BashOutputStore, type BashOutputRecord } from "./activity/bash-output-store.js";
import { HostTurnStore } from "./activity/host-turn-store.js";
import { registerActivityQueryTools } from "./activity/mcp-query-tools.js";
import {
  ActivityLifecycle,
  type ActivityExecutionContext,
  type ActivityOutcome,
} from "./activity/lifecycle.js";
import { ActivityQueryService } from "./activity/query-service.js";
import { buildCapabilityFingerprint, loadCapabilityGuides } from "./capabilities.js";
import {
  CapabilityError,
  createCapabilityRegistry,
  type CapabilityContext,
  type WorkspaceTasksCapabilityInput,
} from "./capability-registry.js";
import { deletePath, renamePath } from "./file-mutations.js";
import {
  downloadIncomingArtifact,
  isArtifactDownloadSupportedPlatform,
} from "./artifact-tools.js";
import { ArtifactError } from "./artifact-error.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { CodeIntelligenceError } from "./lsp/code-intelligence.js";
import { CodeIntelligenceManager } from "./lsp/runtime/manager.js";
import { attachHookReports, HookRunner, runToolWithHooks, type ToolHookOptions } from "./hooks.js";
import { checkHookConfiguration } from "./hook-cli.js";
import {
  buildServerInstructions,
  buildShellMutationPolicy,
  buildToolDescriptions,
  toolNames,
} from "./mcp/server-instructions.js";
import {
  createOpenAIIncomingArtifactAdapter,
  IncomingArtifactAdapterRegistry,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  transportSessionIdPrefix,
  workspaceLogLabel,
} from "./logger.js";
import {
  editFileTool,
  readFileTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createForgeRelayAuthRouter } from "./oauth/router.js";
import { publicEndpointUrl } from "./oauth/public-url.js";
import { BatchExecutor } from "./operations/batch/executor.js";
import { executeBulkRead } from "./operations/bulk-read.js";
import { NativeBulkMutationExecutor } from "./operations/native-bulk-mutations.js";
import {
  createCoreOperationExecutor,
  type CoreOperationContext,
  type CapabilityRunOperationInput,
  type DeleteOperationInput,
  type EditOperationInput,
  type ReadOperationInput,
  type RenameOperationInput,
  type ShellRunOperationInput,
  type WriteOperationInput,
} from "./operations/core-operation-executor.js";
import {
  McpTransportRegistry,
  type McpTransportCloseResult,
} from "./mcp-sessions.js";
import {
  ProcessManager,
  resolveProcessId,
  type CompletedProcessSnapshot,
  type ProcessSnapshot,
} from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { CompositeActivityCoordinator } from "./composite-activity.js";
import { CompositeWorkspaceRegistry } from "./composite-workspaces.js";
import { RemoteWorkspaceRelay } from "./remote-workspace-relay.js";
import { hostConversationScopeId, openAiConversationScopeId } from "./request-meta.js";
import {
  ACTIVITY_PANEL_APP_LEGACY_URI,
  ACTIVITY_PANEL_APP_URI_TEMPLATE,
  MCP_APP_RESOURCE_TEMPLATE_REVISION,
  readActivityPanelAppManifestEntry,
  readWorkspaceAppManifestEntry,
  readWorkspaceLifecycleAppManifestEntry,
  resolveActivityPanelAppIdentity,
  resolveWorkspaceAppIdentity,
  resolveWorkspaceLifecycleAppIdentity,
  WORKSPACE_APP_LEGACY_URI,
  WORKSPACE_APP_URI_TEMPLATE,
  WORKSPACE_LIFECYCLE_APP_LEGACY_URI,
  WORKSPACE_LIFECYCLE_APP_URI_TEMPLATE,
  type WorkspaceAppManifestEntry,
} from "./mcp-app-template.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceTaskReminderTracker } from "./workspace-task-reminders.js";
import { WorkspaceTaskStore } from "./workspace-tasks.js";
import { compactWorkspacePresentation } from "./workspace-presentation.js";
import {
  formatAgentsPath,
  WorkspaceRegistry,
  type Workspace,
  type WorkspaceBootstrapComponent,
} from "./workspaces.js";
import { formatAvailableSubagentProfile, summarizeSubagentProfile } from "./subagents/profiles.js";
import {
  formatSubagentProviderAvailabilitySummary,
  formatUnavailableSubagentProvider,
  getSubagentProviderAvailabilitySnapshot,
  type SubagentProviderAvailability,
} from "./subagents/providers/availability.js";
import { capabilityActivityAuditRequest, capabilityActivityAuditResult } from "./subagents/sessions/mcp/audit.js";
import { createSubagentMcpRuntime, type SubagentMcpRuntimeOptions } from "./subagents/sessions/mcp/runtime.js";

type Transport = StreamableHTTPServerTransport;
// Legacy MCP Streamable HTTP clients can reconnect without closing the previous
// transport. Bound stale transport-session retention so abandoned transports do
// not accumulate for the life of the process.
const MCP_TRANSPORT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_MCP_TRANSPORT_SESSIONS = 64;
const FORGERELAY_VERSION = readForgeRelayVersion();
const MCP_TRANSPORT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  subagentProviders: SubagentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "activity"
  | "read"
  | "write"
  | "edit"
  | "shell"
  | "capability";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model", "app"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  if (mode === "off") return false;
  return kind === "activity";
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  const resourceUri = kind === "activity"
    ? currentActivityPanelAppIdentity(config).uri
    : currentWorkspaceLifecycleAppIdentity(config).uri;
  return {
    _meta: {
      ui: {
        resourceUri,
        visibility: ["model", "app"],
      },
    },
  };
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  workspace?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  exitCode?: number;
  running?: boolean;
  processId?: number;
  capability?: string;
  action?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

function workspaceLogContext(
  workspace: Workspace,
  _transportSessionId?: string,
): Pick<ToolLogFields, "workspaceId" | "workspace"> {
  return {
    workspaceId: workspace.id,
    workspace: workspaceLogLabel(workspace.root, workspace.id),
  };
}

function formatDiscoveredWorkspaceInstructions(
  files: Array<{ path: string; content: string }>,
  workspaceRoot: string,
): string {
  return [
    "Workspace instructions discovered for this path. Apply them to follow-up work under their directories:",
    ...files.flatMap((file) => [
      `--- ${formatAgentsPath(file.path, workspaceRoot)} ---`,
      file.content.trimEnd(),
    ]),
  ].join("\n");
}

async function assertWorkspaceInstructionsLoadedBeforeSideEffect(
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  paths: string[],
): Promise<void> {
  const discovered = new Map<string, { path: string; content: string }>();
  for (const path of paths) {
    const absolutePath = resolve(workspace.root, path);
    for (const file of await workspaces.discoverPathInstructions(workspace, absolutePath)) {
      discovered.set(file.path, file);
    }
  }
  if (discovered.size === 0) return;

  throw new Error([
    formatDiscoveredWorkspaceInstructions([...discovered.values()], workspace.root),
    "Apply these instructions, then retry this tool call. No mutation or command was executed.",
  ].join("\n"));
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const workspaceSkillDiagnosticOutputSchema = z.object({
  type: z.enum(["warning", "error", "collision"]),
  message: z.string(),
  collision: z.object({
    resourceType: z.enum(["extension", "skill", "prompt", "theme"]),
    name: z.string(),
  }).optional(),
});

function redactSkillDiagnosticPaths(
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

const capabilityFingerprintOutputSchema = z.object({
  version: z.string(),
  toolMode: z.enum(["minimal", "full", "codex"]),
  capabilities: z.array(z.string()),
});

const capabilityGuideOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToRead: z.string(),
  path: z.string(),
});

const capabilityCatalogGuideOutputSchema = z.object({
  name: z.string(),
  path: z.string(),
  readBeforeFirstUse: z.boolean(),
});

const capabilityCatalogOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().optional(),
  batchPolicy: z.enum(["parallel", "serial", "unsupported"]),
  guide: capabilityCatalogGuideOutputSchema,
});

const capabilityErrorOutputSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceSubagentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  continuationSupported: z.boolean(),
  reason: z.string().optional(),
});
const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const workspaceInventoryEntryOutputSchema = z.object({
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
  current: z.boolean(),
});

const workspaceInventorySummaryOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  matching: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

const workspaceInventoryPageOutputSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});

const workspaceTaskInspectionSummaryOutputSchema = z.object({
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

const workspaceInspectionMemberOutputSchema = z.object({
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

const workspaceInspectionOutputSchema = z.union([
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

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function mcpRequestDebugFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};

  const request = body as Record<string, unknown>;
  const rpcMethod = typeof request.method === "string" ? request.method : undefined;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : undefined;
  const rpcMeta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? params._meta as Record<string, unknown>
    : undefined;
  const rpcMetaKeys = rpcMeta ? Object.keys(rpcMeta).sort() : [];
  let rpcTarget: string | undefined;
  if (rpcMethod === "resources/read" && typeof params?.uri === "string") {
    rpcTarget = params.uri;
  } else if (rpcMethod === "tools/call" && typeof params?.name === "string") {
    rpcTarget = params.name;
  }

  return {
    rpcMethod,
    rpcTarget,
    ...(rpcMetaKeys.length > 0 ? { rpcMetaKeys } : {}),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function attachWorkspaceTaskReminder<T>(result: T, reminder: string | undefined): T {
  if (!reminder || toolResultIsError(result) || typeof result !== "object" || result === null) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: [...content, textBlock(reminder)],
  } as T;
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function uiBuildDirectoryUrl(): URL {
  return new URL("../dist/ui/", import.meta.url);
}

const cachedWorkspaceAppIdentities = new Map<
  string,
  ReturnType<typeof resolveWorkspaceAppIdentity>
>();
const cachedWorkspaceLifecycleAppIdentities = new Map<
  string,
  ReturnType<typeof resolveWorkspaceLifecycleAppIdentity>
>();
const cachedActivityPanelAppIdentities = new Map<
  string,
  ReturnType<typeof resolveActivityPanelAppIdentity>
>();

function appResourceContractRevision(config: ServerConfig): string {
  return [
    MCP_APP_RESOURCE_TEMPLATE_REVISION,
    `publicBaseUrls=${JSON.stringify(config.publicBaseUrls)}`,
  ].join("\0");
}

function appIdentityOptions(config: ServerConfig) {
  return {
    manifestUrl: uiManifestUrl(),
    buildDirectoryUrl: uiBuildDirectoryUrl(),
    fallbackRevision: FORGERELAY_VERSION,
    resourceTemplateRevision: appResourceContractRevision(config),
  };
}

function currentWorkspaceAppIdentity(
  config: ServerConfig,
): ReturnType<typeof resolveWorkspaceAppIdentity> {
  const key = appResourceContractRevision(config);
  let identity = cachedWorkspaceAppIdentities.get(key);
  if (!identity) {
    identity = resolveWorkspaceAppIdentity(appIdentityOptions(config));
    cachedWorkspaceAppIdentities.set(key, identity);
  }
  return identity;
}

function currentWorkspaceLifecycleAppIdentity(
  config: ServerConfig,
): ReturnType<typeof resolveWorkspaceLifecycleAppIdentity> {
  const key = appResourceContractRevision(config);
  let identity = cachedWorkspaceLifecycleAppIdentities.get(key);
  if (!identity) {
    identity = resolveWorkspaceLifecycleAppIdentity(appIdentityOptions(config));
    cachedWorkspaceLifecycleAppIdentities.set(key, identity);
  }
  return identity;
}

function currentActivityPanelAppIdentity(
  config: ServerConfig,
): ReturnType<typeof resolveActivityPanelAppIdentity> {
  const key = appResourceContractRevision(config);
  let identity = cachedActivityPanelAppIdentities.get(key);
  if (!identity) {
    identity = resolveActivityPanelAppIdentity(appIdentityOptions(config));
    cachedActivityPanelAppIdentities.set(key, identity);
  }
  return identity;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  return readWorkspaceAppManifestEntry(uiManifestUrl());
}

function getWorkspaceLifecycleAppManifestEntry(): WorkspaceAppManifestEntry {
  return readWorkspaceLifecycleAppManifestEntry(uiManifestUrl());
}

function getActivityPanelAppManifestEntry(): WorkspaceAppManifestEntry {
  return readActivityPanelAppManifestEntry(uiManifestUrl());
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function mcpAppHtml(
  config: ServerConfig,
  entry: WorkspaceAppManifestEntry,
  title: string,
  waitingMessage: string,
): string {
  const baseUrl = assetBaseUrl(config);
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">${waitingMessage}</section>
    </main>
  </body>
</html>`;
}

function workspaceAppHtml(config: ServerConfig): string {
  return mcpAppHtml(
    config,
    getWorkspaceAppManifestEntry(),
    "ForgeRelay Workspace",
    "Waiting for a workspace result.",
  );
}

function workspaceLifecycleAppHtml(config: ServerConfig): string {
  return mcpAppHtml(
    config,
    getWorkspaceLifecycleAppManifestEntry(),
    "ForgeRelay Workspace Lifecycle",
    "Waiting for a workspace result.",
  );
}

function activityPanelAppHtml(config: ServerConfig): string {
  return mcpAppHtml(
    config,
    getActivityPanelAppManifestEntry(),
    "ForgeRelay Activity Panel",
    "Waiting for Activity Panel state.",
  );
}

function appDomain(config: ServerConfig): string {
  return new URL(config.publicBaseUrl).origin;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  return {
    resourceDomains: [...config.publicBaseUrls],
    connectDomains: [...config.publicBaseUrls],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertMcpAppAssets(entry: WorkspaceAppManifestEntry): Promise<void> {
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) await access(candidate);
}

type AppResourceVariant = "current" | "legacy" | "historical";

function appResourceVariant(
  requestedUri: string,
  currentUri: string,
  legacyUri: string,
): AppResourceVariant {
  if (requestedUri === currentUri) return "current";
  if (requestedUri === legacyUri) return "legacy";
  return "historical";
}

async function readMcpAppResource(
  config: ServerConfig,
  options: {
    requestedUri: string;
    currentUri: string;
    legacyUri: string;
    entry: WorkspaceAppManifestEntry;
    html: string;
    transportSessionId?: string;
  },
) {
  const compatibility = appResourceVariant(
    options.requestedUri,
    options.currentUri,
    options.legacyUri,
  );

  try {
    await assertMcpAppAssets(options.entry);
    const result = {
      contents: [{
        uri: options.requestedUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: options.html,
        _meta: {
          ui: {
            domain: appDomain(config),
            csp: appCsp(config),
          },
          // MCP Apps defines resource metadata under `_meta.ui`. Inspector 2.3.0
          // reads the content-item CSP/domain from `_meta` directly, so mirror
          // these values until that installed-host compatibility gap is gone.
          domain: appDomain(config),
          csp: appCsp(config),
        },
      }],
    };
    logEvent(config.logging, "debug", "mcp_app_template_read", {
      requestedUri: options.requestedUri,
      currentUri: options.currentUri,
      compatibility,
      transportSessionIdPrefix: transportSessionIdPrefix(options.transportSessionId),
    });
    return result;
  } catch (error) {
    logEvent(config.logging, "warn", "mcp_app_template_read_failed", {
      requestedUri: options.requestedUri,
      currentUri: options.currentUri,
      compatibility,
      error: error instanceof Error ? error.message : String(error),
      transportSessionIdPrefix: transportSessionIdPrefix(options.transportSessionId),
    });
    throw error;
  }
}

function readWorkspaceAppResource(
  config: ServerConfig,
  requestedUri: string,
  transportSessionId?: string,
  currentUri = currentWorkspaceAppIdentity(config).uri,
  legacyUri = WORKSPACE_APP_LEGACY_URI,
) {
  return readMcpAppResource(config, {
    requestedUri,
    currentUri,
    legacyUri,
    entry: getWorkspaceAppManifestEntry(),
    html: workspaceAppHtml(config),
    transportSessionId,
  });
}

function readWorkspaceLifecycleAppResource(
  config: ServerConfig,
  requestedUri: string,
  transportSessionId?: string,
) {
  return readMcpAppResource(config, {
    requestedUri,
    currentUri: currentWorkspaceLifecycleAppIdentity(config).uri,
    legacyUri: WORKSPACE_LIFECYCLE_APP_LEGACY_URI,
    entry: getWorkspaceLifecycleAppManifestEntry(),
    html: workspaceLifecycleAppHtml(config),
    transportSessionId,
  });
}

function readActivityPanelAppResource(
  config: ServerConfig,
  requestedUri: string,
  transportSessionId?: string,
) {
  return readMcpAppResource(config, {
    requestedUri,
    currentUri: currentActivityPanelAppIdentity(config).uri,
    legacyUri: ACTIVITY_PANEL_APP_LEGACY_URI,
    entry: getActivityPanelAppManifestEntry(),
    html: activityPanelAppHtml(config),
    transportSessionId,
  });
}

const PROCESS_RESPONSE_OUTPUT_LINES = 10;

function compactProcessOutput(output: string): { output: string; truncated: boolean } {
  if (!output) return { output: "", truncated: false };
  const trailingNewline = output.endsWith("\n");
  const body = trailingNewline ? output.slice(0, -1) : output;
  const lines = body.split("\n");
  if (lines.length <= PROCESS_RESPONSE_OUTPUT_LINES) return { output, truncated: false };
  const compact = lines.slice(-PROCESS_RESPONSE_OUTPUT_LINES).join("\n");
  return {
    output: trailingNewline ? `${compact}\n` : compact,
    truncated: true,
  };
}

function outputIdNotice(outputId: string | undefined): string {
  return outputId ? `Full output ID: ${outputId}.` : "";
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with process ID ${snapshot.processId}.`
    : snapshot.timedOut
      ? "Process timed out and was terminated."
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const compact = compactProcessOutput(snapshot.output).output.replace(/\n$/, "");
  return [compact, status, outputIdNotice(snapshot.outputId)].filter(Boolean).join("\n");
}

function completedProcessResult(snapshot: CompletedProcessSnapshot): string {
  const status = snapshot.timedOut
    ? `Background process ${snapshot.processId} timed out and was terminated.`
    : snapshot.signal
      ? `Background process ${snapshot.processId} exited after signal ${snapshot.signal}.`
      : `Background process ${snapshot.processId} exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const command = `Command: ${snapshot.command}`;
  const output = compactProcessOutput(snapshot.output).output.replace(/\n$/, "");
  return [status, command, output, outputIdNotice(snapshot.outputId)].filter(Boolean).join("\n");
}

function attachCompletedProcessNotices<T>(
  processSessions: ProcessManager,
  workspaceId: string,
  result: T,
  onCompleted?: (snapshot: CompletedProcessSnapshot) => void,
): T {
  if (result instanceof Error) {
    const completed = processSessions.takeCompleted(workspaceId);
    for (const snapshot of completed) onCompleted?.(snapshot);
    if (completed.length > 0) {
      result.message = [
        result.message,
        ...completed.map((snapshot) => completedProcessResult(snapshot)),
      ].join("\n\n");
    }
    return result;
  }
  if (typeof result !== "object" || result === null) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;

  const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  const currentProcessId = structured?.running === true
    ? typeof structured.processId === "number"
      ? structured.processId
      : typeof structured.sessionId === "number"
        ? structured.sessionId
        : undefined
    : undefined;
  const completed = processSessions.takeCompleted(workspaceId, undefined, currentProcessId);
  for (const snapshot of completed) onCompleted?.(snapshot);
  if (completed.length === 0) return result;

  return {
    ...result,
    content: [
      ...content,
      ...completed.map((snapshot) => textBlock(completedProcessResult(snapshot))),
    ],
  } as T;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    processId: z.number().int().positive().optional().describe("Canonical process handle for bash(action=\"process\") or the active command adapter."),
    sessionId: z.number().int().positive().optional().describe("Deprecated alias of processId for compatibility."),
    outputId: z.string().optional().describe("Stable local audit identifier for retrieving the complete original process output."),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    timedOut: z.boolean(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function readForgeRelayVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read ForgeRelay package version.");
  }
  return packageJson.version;
}

function processToolResponse(
  tool: "bash" | "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const compact = compactProcessOutput(snapshot.output);
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(compact.output ? [textBlock(compact.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      processId: snapshot.processId,
      sessionId: snapshot.sessionId,
      outputId: snapshot.outputId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      timedOut: snapshot.timedOut,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated || compact.truncated,
    },
  };
}

function durableOutputResult(record: BashOutputRecord): string {
  const status = record.status === "running"
    ? `Process ${record.processId} is still running.`
    : record.timedOut
      ? `Process ${record.processId} timed out and was terminated.`
      : record.signal
        ? `Process ${record.processId} exited after signal ${record.signal}.`
        : `Process ${record.processId} exited with code ${record.exitCode ?? "unknown"}.`;
  return [record.output.replace(/\n$/, ""), status, `Full output ID: ${record.outputId}.`]
    .filter(Boolean)
    .join("\n");
}

function durableOutputResponse(
  tool: "bash" | "write_stdin",
  workspaceId: string,
  record: BashOutputRecord,
) {
  const result = durableOutputResult(record);
  const content = [textBlock(result)];
  const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  const startedAt = Date.parse(record.startedAt);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: textSummary(record.output ? [textBlock(record.output)] : []),
        payload: { content },
      },
    },
    structuredContent: {
      result,
      processId: record.processId,
      sessionId: record.processId,
      outputId: record.outputId,
      running: record.status === "running",
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      wallTimeMs: Math.max(0, Number.isFinite(finishedAt - startedAt) ? finishedAt - startedAt : 0),
      outputTruncated: false,
    },
  };
}

function markReturnedOutput(store: BashOutputStore, result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return;
  const record = structured as { running?: unknown; outputId?: unknown };
  if (record.running === true && typeof record.outputId === "string") {
    store.markReturned(record.outputId);
  }
}

function readWorkspaceBashOutput(
  store: BashOutputStore,
  workspaceId: string,
  outputId: string,
): BashOutputRecord {
  const record = store.read(outputId);
  if (!record) throw new Error(`Unknown Bash output: ${outputId}`);
  if (record.workspaceId !== workspaceId) {
    throw new Error(`Bash output ${outputId} does not belong to workspace ${workspaceId}.`);
  }
  return record;
}

function bashCompletionError(record: BashOutputRecord): string {
  if (record.error) return record.error;
  if (record.timedOut) return `Background process ${record.processId} timed out.`;
  if (record.signal) return `Background process ${record.processId} exited after signal ${record.signal}.`;
  return `Background process ${record.processId} exited with code ${record.exitCode ?? "unknown"}.`;
}

function recordBashCompletion(
  lifecycle: ActivityLifecycle,
  store: BashOutputStore,
  outputId: string | undefined,
): void {
  if (!outputId) return;
  const completion = store.claimCompletion(outputId);
  if (!completion) return;
  lifecycle.recordLinked({
    sourceActivityId: completion.activityId,
    tool: "bash_result",
    request: {
      processId: completion.processId,
      outputId: completion.outputId,
    },
    result: {
      processId: completion.processId,
      outputId: completion.outputId,
      exitCode: completion.exitCode,
      signal: completion.signal,
      timedOut: completion.timedOut,
    },
    outcome: completion.status === "failed"
      ? { type: "failed", error: bashCompletionError(completion) }
      : { type: "succeeded" },
  });
}

function workspaceHookInvocation(workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    workspaceMode: workspace.mode,
    sourceRoot: workspace.sourceRoot,
  };
}

function capabilityContextFor(workspace: Workspace): CapabilityContext {
  return {
    workspaceId: workspace.id,
    workspaceKind: "workspace",
    workspaceRoot: workspace.root,
    guides: workspace.capabilityGuides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    })),
  };
}

function compositeCapabilityContext(
  workspaceId: string,
  guides: ReturnType<typeof loadCapabilityGuides>,
): CapabilityContext {
  return {
    workspaceId,
    workspaceKind: "composite",
    guides: guides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    })),
  };
}

function requireCapabilityWorkspaceRoot(context: CapabilityContext): string {
  if (!context.workspaceRoot) {
    throw new CapabilityError(
      "capability_unavailable",
      `Capability execution requires a filesystem-backed Workspace; ${context.workspaceId} is ${context.workspaceKind}.`,
    );
  }
  return context.workspaceRoot;
}

function runWorkspaceTasksCapability(
  store: WorkspaceTaskStore,
  workspaceId: string,
  input: WorkspaceTasksCapabilityInput,
) {
  switch (input.operation) {
    case "get":
      if (input.level === "headers") return store.readHeaders(workspaceId, input.listId);
      if (input.level === "detail") return store.readTaskDetail(workspaceId, input.listId, input.taskId);
      return store.readSummary(workspaceId);
    case "list.create":
      store.createList(workspaceId, { name: input.name, position: input.position });
      return store.readSummary(workspaceId);
    case "list.update":
      store.updateList(workspaceId, input.listId, {
        name: input.name,
        state: input.state,
        position: input.position,
      });
      return store.readSummary(workspaceId);
    case "list.delete":
      store.deleteList(workspaceId, input.listId);
      return store.readSummary(workspaceId);
    case "task.create":
      store.createTask(workspaceId, input.listId, {
        subject: input.subject,
        content: input.content,
        status: input.status,
        position: input.position,
      });
      return store.readHeaders(workspaceId, input.listId);
    case "task.update":
      store.updateTask(workspaceId, input.listId, input.taskId, {
        subject: input.subject,
        content: input.content,
        status: input.status,
        position: input.position,
      });
      return store.readHeaders(workspaceId, input.listId);
    case "task.delete":
      store.deleteTask(workspaceId, input.listId, input.taskId);
      return store.readHeaders(workspaceId, input.listId);
  }
}

async function reviewWorkspaceChanges(
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  workspace: Pick<Workspace, "id" | "root">,
) {
  return reviewCheckpoints.reviewChanges({
    workspaceId: workspace.id,
    root: workspace.root,
    markReviewed: true,
  });
}

function toolResultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return String(result ?? "");
  const record = result as { content?: unknown; structuredContent?: unknown };
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return "";
        const value = (entry as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof record.structuredContent === "object" && record.structuredContent !== null) {
    const value = (record.structuredContent as { result?: unknown }).result;
    if (typeof value === "string") return value;
  }
  return "";
}

function toolResultContent(result: unknown): ToolContent[] {
  if (typeof result !== "object" || result === null) return [];
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? content as ToolContent[] : [];
}

function remapCompositeToolResult<T>(
  result: T,
  executionWorkspaceId: string,
  compositeWorkspaceId: string,
  member: string,
): T {
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  const remapped = replaceWorkspaceIdentity(record, executionWorkspaceId, compositeWorkspaceId) as Record<string, unknown>;
  const meta = typeof remapped._meta === "object" && remapped._meta !== null
    ? { ...(remapped._meta as Record<string, unknown>) }
    : undefined;
  if (meta) {
    const card = typeof meta.card === "object" && meta.card !== null
      ? { ...(meta.card as Record<string, unknown>), workspaceId: compositeWorkspaceId, member }
      : undefined;
    if (card) meta.card = card;
    remapped._meta = meta;
  }
  const structured = typeof remapped.structuredContent === "object" && remapped.structuredContent !== null
    ? { ...(remapped.structuredContent as Record<string, unknown>), member }
    : undefined;
  if (structured) remapped.structuredContent = structured;
  return remapped as T;
}

function replaceWorkspaceIdentity(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((entry) => replaceWorkspaceIdentity(entry, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, replaceWorkspaceIdentity(entry, from, to)]),
  );
}

function toolResultAgentsFiles(result: unknown): Array<{ path: string; content: string }> {
  if (typeof result !== "object" || result === null) return [];
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return [];
  const agentsFiles = (structured as { agentsFiles?: unknown }).agentsFiles;
  if (!Array.isArray(agentsFiles)) return [];
  return agentsFiles.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    return typeof path === "string" && typeof content === "string" ? [{ path, content }] : [];
  });
}

function workspaceActivitySnapshot(workspace: Workspace): ActivityWorkspaceSnapshot {
  return {
    id: workspace.id,
    root: workspace.root,
    mode: workspace.mode,
    ...(workspace.sourceRoot ? { sourceRoot: workspace.sourceRoot } : {}),
    ...(workspace.worktree?.branch ? { branch: workspace.worktree.branch } : {}),
    ...(workspace.worktree?.targetBranch ? { targetBranch: workspace.worktree.targetBranch } : {}),
  };
}

function activityFailureMessage(result: unknown): string {
  if (typeof result !== "object" || result === null) return "Tool returned a failed result.";
  const record = result as { content?: unknown; structuredContent?: unknown };
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return "";
        const value = (entry as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof record.structuredContent === "object" && record.structuredContent !== null) {
    const value = (record.structuredContent as { result?: unknown }).result;
    if (typeof value === "string" && value) return value;
  }
  return "Tool returned a failed result.";
}

function standardActivityOutcome(result: unknown): ActivityOutcome {
  return toolResultIsError(result)
    ? { type: "failed", error: activityFailureMessage(result) }
    : { type: "succeeded" };
}

function processActivityOutcome(result: unknown): ActivityOutcome {
  if (toolResultIsError(result)) return { type: "failed", error: activityFailureMessage(result) };
  if (typeof result !== "object" || result === null) return { type: "succeeded" };
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return { type: "succeeded" };
  const process = structured as {
    running?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    timedOut?: unknown;
  };
  if (process.running === true) return { type: "returned" };
  if (
    process.timedOut === true ||
    typeof process.signal === "string" ||
    (typeof process.exitCode === "number" && process.exitCode !== 0)
  ) {
    return { type: "failed", error: activityFailureMessage(result) };
  }
  return { type: "succeeded" };
}

interface ActivityRelationContext {
  parentActivityId?: string;
  turnId?: string;
}

function activityRelationFor(context: CoreOperationContext): ActivityRelationContext {
  return {
    ...(context.parentActivityId ? { parentActivityId: context.parentActivityId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

function activityRequestFor(input: unknown, context: CoreOperationContext): unknown {
  if (!context.activityMember || !input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    member: context.activityMember,
  };
}

function runActivityTool<T>(
  lifecycle: ActivityLifecycle,
  workspace: Workspace,
  conversationScopeId: string,
  tool: string,
  request: unknown,
  operation: (context: ActivityExecutionContext) => Promise<T>,
  outcome: (result: T) => ActivityOutcome = standardActivityOutcome,
  relation: ActivityRelationContext = {},
  auditResult?: (result: T) => unknown,
): Promise<T> {
  return lifecycle.run({
    tool,
    workspace: workspaceActivitySnapshot(workspace),
    conversationScopeId,
    request,
    operation,
    outcome,
    ...(auditResult ? { auditResult } : {}),
    ...relation,
  });
}

function runActivityToolWithHooks<T>(
  lifecycle: ActivityLifecycle,
  hooks: HookRunner,
  workspace: Workspace,
  conversationScopeId: string,
  request: unknown,
  hookOptions: ToolHookOptions<T>,
  relation: ActivityRelationContext = {},
): Promise<T> {
  return runActivityTool(
    lifecycle,
    workspace,
    conversationScopeId,
    hookOptions.tool,
    request,
    () => runToolWithHooks(hooks, hookOptions),
    standardActivityOutcome,
    relation,
  );
}

type SharedShellRun = (
  input: ShellRunOperationInput,
  context: CoreOperationContext,
) => Promise<ReturnType<typeof processToolResponse> & { isError?: true }>;

type ProcessExecutionTarget =
  | {
      executionWorkspaceId: string;
      compositeWorkspaceId?: undefined;
      memberName?: undefined;
    }
  | {
      executionWorkspaceId: string;
      compositeWorkspaceId: string;
      memberName: string;
    };

interface ProcessToolRouting {
  resolve: (workspaceId: string, member?: string) => ProcessExecutionTarget;
  prepare: (
    target: ProcessExecutionTarget,
    requestMeta: unknown,
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
  ) => Promise<CoreOperationContext>;
  present: <T>(result: T, target: ProcessExecutionTarget) => T;
  presentSemantic: <T>(result: T, target: ProcessExecutionTarget) => T;
  isRemote: (workspaceId: string) => boolean;
  execCommandRemote: (
    workspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId: string,
  ) => Promise<Awaited<ReturnType<RemoteWorkspaceRelay["execCommand"]>>>;
  writeStdinRemote: (
    workspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId: string,
  ) => Promise<Awaited<ReturnType<RemoteWorkspaceRelay["writeStdin"]>>>;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
}

function registerProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessManager,
  hooks: HookRunner,
  activityLifecycle: ActivityLifecycle,
  bashOutputStore: BashOutputStore,
  shellRun: SharedShellRun,
  routing: ProcessToolRouting,
): void {
  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "exec_command",
    {
      title: "Execute command",
      description:
        `Run a command inside an open workspace. Returns its result when it exits during the yield window, otherwise returns a processId for write_stdin. Use this for file inspection, tests, builds, package scripts, generators, formatters, and long-running processes. ${buildShellMutationPolicy()} Call open_workspace first and pass workspaceId.`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this process."),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .optional()
          .describe("Feedback window before returning a processId. Use 0 for immediate background handoff. Defaults to 10000ms."),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(86_400_000)
          .optional()
          .describe("Total execution timeout from process start. On expiry ForgeRelay terminates the process. Omit for no ForgeRelay execution deadline."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, timeoutMs, maxOutputTokens }, extra) => {
      const target = routing.resolve(workspaceId, member);
      const context = await routing.prepare(target, extra._meta, extra.signal, extra.sessionId);
      if (routing.isRemote(target.executionWorkspaceId)) {
        return routing.presentSemantic(await routing.execCommandRemote(
          target.executionWorkspaceId,
          {
            cmd,
            ...(tty !== undefined ? { tty } : {}),
            ...(columns !== undefined ? { columns } : {}),
            ...(rows !== undefined ? { rows } : {}),
            ...(workingDirectory !== undefined ? { workingDirectory } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          },
          routing.hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      return routing.presentSemantic(await shellRun(
        {
          workspaceId: target.executionWorkspaceId,
          command: cmd,
          surface: "exec_command",
          tty,
          columns,
          rows,
          workingDirectory,
          yieldTimeMs,
          timeoutMs,
          maxOutputTokens,
        },
        context,
      ), target);
    },
    );
  }

  if (config.toolMode !== "codex") return;

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a running process returned by exec_command, or retrieve complete durable process output by outputId. Omit chars or pass an empty string to poll. Waiting never kills the process; pass \\u0003 to explicitly send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns the process."),
        processId: z.number().int().positive().optional().describe("Canonical process identifier returned by bash or exec_command."),
        sessionId: z.number().int().positive().optional().describe("Deprecated alias for processId. Retained for compatibility."),
        outputId: z.string().optional().describe("Stable output identifier returned by exec_command. When supplied, retrieve the complete durable output instead of controlling a process."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .optional()
          .describe("Milliseconds to keep waiting before returning again, max 300000. Polling defaults to 5000; interaction defaults to 250."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, processId, sessionId, outputId, chars, columns, rows, yieldTimeMs, maxOutputTokens }, extra) => {
      const target = routing.resolve(workspaceId, member);
      await routing.prepare(target, extra._meta, extra.signal, extra.sessionId);
      if (routing.isRemote(target.executionWorkspaceId)) {
        return routing.present(await routing.writeStdinRemote(
          target.executionWorkspaceId,
          {
            ...(processId !== undefined ? { processId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(outputId !== undefined ? { outputId } : {}),
            ...(chars !== undefined ? { chars } : {}),
            ...(columns !== undefined ? { columns } : {}),
            ...(rows !== undefined ? { rows } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          },
          routing.hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      const executionWorkspaceId = target.executionWorkspaceId;
      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      if (outputId !== undefined) {
        if (
          processId !== undefined || sessionId !== undefined || chars !== undefined || columns !== undefined ||
          rows !== undefined || yieldTimeMs !== undefined || maxOutputTokens !== undefined
        ) {
          throw new Error("write_stdin outputId lookup cannot be combined with process control fields.");
        }
        return runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: "write_stdin",
          invocation: workspaceHookInvocation(workspace),
          payload: { outputId },
          operation: async () => durableOutputResponse(
            "write_stdin",
            executionWorkspaceId,
            readWorkspaceBashOutput(bashOutputStore, executionWorkspaceId, outputId),
          ),
        });
      }
      const resolvedProcessId = resolveProcessId(processId, sessionId);
      return runToolWithHooks(hooks, {
        signal: extra.signal,
        tool: "write_stdin",
        invocation: workspaceHookInvocation(workspace),
        payload: {
          processId: resolvedProcessId,
          charactersWritten: chars?.length ?? 0,
          columns,
          rows,
        },
        operation: async () => {
          const startedAt = performance.now();
          const snapshot = await processSessions.write({
            workspaceId: executionWorkspaceId,
            processId: resolvedProcessId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            signal: extra.signal,
          });

          logToolCall(config, {
            tool: "write_stdin",
            ...workspaceLogContext(workspace, extra.sessionId),
            exitCode: snapshot.exitCode,
            running: snapshot.running,
            processId: snapshot.processId,
            success: snapshot.running || snapshot.exitCode === 0,
            durationMs: Math.round(performance.now() - startedAt),
          });

          const response = processToolResponse("write_stdin", executionWorkspaceId, snapshot, {
            processId: resolvedProcessId,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          });
          if (!snapshot.running) {
            recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId);
          }
          return response;
        },
      }).then((result) => routing.present(result, target));
    },
  );
}

interface CreateMcpServerOptions extends SubagentMcpRuntimeOptions {
  taskReminders?: WorkspaceTaskReminderTracker;
  remoteWorkspaces?: RemoteWorkspaceRelay;
  compositeWorkspaces?: CompositeWorkspaceRegistry;
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessManager,
  subagentProviders: SubagentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  codeIntelligence: CodeIntelligenceManager,
  activityLifecycle: ActivityLifecycle,
  bashOutputStore: BashOutputStore,
  activityQueries: ActivityQueryService,
  options: CreateMcpServerOptions = {},
): McpServer {
  const connectionScopeId = `mcp-connection:${randomUUID()}`;
  const ownsRemoteWorkspaces = options.remoteWorkspaces === undefined;
  const remoteWorkspaces = options.remoteWorkspaces
    ?? new RemoteWorkspaceRelay(config.configDir, config.stateDir);
  const compositeWorkspaces = options.compositeWorkspaces
    ?? new CompositeWorkspaceRegistry(config.stateDir);
  const workspaceTasks = new WorkspaceTaskStore(config.stateDir);
  const taskReminders = options.taskReminders
    ?? new WorkspaceTaskReminderTracker(config.taskReminderInterval, workspaceTasks);
  const compositeTaskGuides = loadCapabilityGuides(config).filter((guide) => guide.name === "workspace-tasks");
  const compositeActivity = new CompositeActivityCoordinator(
    compositeWorkspaces,
    activityQueries,
    remoteWorkspaces,
  );
  const resolveExecutionTarget = (workspaceId: string, memberName?: string) => {
    if (!compositeWorkspaces.has(workspaceId)) {
      if (memberName !== undefined) {
        throw new Error(`Workspace ${workspaceId} is not composite and does not accept member.`);
      }
      return { executionWorkspaceId: workspaceId };
    }
    if (!memberName) {
      throw new Error(`Composite Workspace ${workspaceId} requires member for this operation.`);
    }
    const member = compositeWorkspaces.member(workspaceId, memberName);
    try {
      if (!remoteWorkspaces.has(member.workspaceId)) workspaces.getWorkspace(member.workspaceId);
    } catch (error) {
      throw new Error(
        `Composite Workspace ${workspaceId} member ${member.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      executionWorkspaceId: member.workspaceId,
      compositeWorkspaceId: workspaceId,
      memberName: member.name,
    };
  };
  const subagentMcp = createSubagentMcpRuntime(config, activityLifecycle, options);
  const presentExecutionResult = <T>(
    result: T,
    target: ReturnType<typeof resolveExecutionTarget>,
  ): T => {
    const presented = !target.compositeWorkspaceId || !target.memberName
      ? result
      : remapCompositeToolResult(
          result,
          target.executionWorkspaceId,
          target.compositeWorkspaceId,
          target.memberName,
        );
    return subagentMcp.decorateResult(target.executionWorkspaceId, presented);
  };
  const taskReminderWorkspaceIdFor = (
    target: ReturnType<typeof resolveExecutionTarget>,
  ): string | undefined => {
    if (target.compositeWorkspaceId) return target.compositeWorkspaceId;
    if (remoteWorkspaces.has(target.executionWorkspaceId)) return undefined;
    try {
      return workspaces.getWorkspace(target.executionWorkspaceId).id;
    } catch {
      return undefined;
    }
  };
  const presentSemanticWorkResult = <T>(
    result: T,
    target: ReturnType<typeof resolveExecutionTarget>,
  ): T => {
    const presented = presentExecutionResult(result, target);
    if (toolResultIsError(presented)) return presented;
    const reminderWorkspaceId = taskReminderWorkspaceIdFor(target);
    return attachWorkspaceTaskReminder(
      presented,
      reminderWorkspaceId ? taskReminders.recordWork(reminderWorkspaceId) : undefined,
    );
  };
  const hostScopeIdFor = (requestMeta: unknown, transportSessionId?: string): string =>
    hostConversationScopeId(requestMeta, transportSessionId, connectionScopeId);
  const prepareExecutionContext = async (
    target: ReturnType<typeof resolveExecutionTarget>,
    requestMeta: unknown,
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
  ): Promise<CoreOperationContext> => {
    const conversationScopeId = hostScopeIdFor(requestMeta, sessionId);
    const turnId = target.compositeWorkspaceId && target.memberName
      ? await compositeActivity.prepareMember(
          target.compositeWorkspaceId,
          target.memberName,
          target.executionWorkspaceId,
          conversationScopeId,
        )
      : undefined;
    return {
      requestMeta,
      signal,
      sessionId,
      ...(turnId ? { turnId } : {}),
      ...(target.memberName ? { activityMember: target.memberName } : {}),
    };
  };
  const toolDescriptions = buildToolDescriptions(config);
  const hooks = new HookRunner(
    config.hooks,
    config.logging,
    process.env,
    (workspaceId, result) => attachCompletedProcessNotices(
      processSessions,
      workspaceId,
      result,
      (snapshot) => recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId),
    ),
  );
  const incomingArtifactRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);
  const artifactDownloadAvailable = config.artifactsEnabled && isArtifactDownloadSupportedPlatform();
  const reviewChangesAvailable = config.widgets === "changes";
  let batchExecutor: BatchExecutor | undefined;
  const batchExecuteAvailable = config.toolMode !== "codex";
  const capabilityRegistry = createCapabilityRegistry({
    inspectHooks: (workspaceRoot) => checkHookConfiguration(workspaceRoot, config.hooks),
    ...subagentMcp.registryDependencies,
    workspaceTasks: {
      available: true,
      run: async (input, context) => {
        const value = runWorkspaceTasksCapability(workspaceTasks, context.workspaceId, input);
        if (input.operation !== "get") taskReminders.reset(context.workspaceId);
        return { value };
      },
    },
    batchExecute: {
      available: batchExecuteAvailable,
      unavailableReason: batchExecuteAvailable
        ? undefined
        : "batch.execute is unavailable in Codex tool mode because v0.5.5 core batch tasks use the regular Read/Write/Edit/Bash operation surface.",
      run: async (input, context, options) => {
        if (!batchExecutor) throw new Error("Batch executor is not initialized.");
        return {
          value: await batchExecutor.run(context.workspaceId, input, {
            requestMeta: options.requestMeta,
            signal: options.signal,
            sessionId: options.sessionId,
          }),
        };
      },
    },
    codeIntelligence: {
      available: true,
      run: async (input, context, options) => {
        try {
          return {
            value: await codeIntelligence.run(requireCapabilityWorkspaceRoot(context), input, { signal: options.signal }),
          };
        } catch (error) {
          if (error instanceof CodeIntelligenceError) {
            throw new CapabilityError(error.code, error.message);
          }
          throw error;
        }
      },
    },
    reviewChanges: {
      available: reviewChangesAvailable,
      unavailableReason: reviewChangesAvailable
        ? undefined
        : "Aggregate change review is disabled; start ForgeRelay with widgets=changes.",
      run: async (context) => {
        const review = await reviewWorkspaceChanges(reviewCheckpoints, {
          id: context.workspaceId,
          root: requireCapabilityWorkspaceRoot(context),
        });
        return {
          value: {
            result: review.result,
            summary: review.summary,
            files: review.files,
          },
          card: {
            summary: review.summary,
            files: review.files,
            payload: { patch: review.patch },
          },
        };
      },
    },
    downloadArtifact: {
      available: artifactDownloadAvailable,
      unavailableReason: !config.artifactsEnabled
        ? "Native artifact ingress is disabled."
        : !isArtifactDownloadSupportedPlatform()
          ? "Native artifact ingress is unsupported on this platform."
          : undefined,
      run: async (input, context) => {
        try {
          const downloaded = await downloadIncomingArtifact({
            registry: incomingArtifactRegistry,
            workspaceId: context.workspaceId,
            workspaceRoot: requireCapabilityWorkspaceRoot(context),
            maxFileBytes: config.artifactMaxFileBytes,
            file: input.file,
            path: input.path,
          });
          return {
            value: { path: downloaded.path },
            changedPaths: [downloaded.path],
          };
        } catch (error) {
          if (error instanceof ArtifactError) {
            throw new CapabilityError(`artifact.${error.code}`, error.message);
          }
          throw error;
        }
      },
    },
  });
  const loadCompositeMemberContext = async (
    compositeWorkspaceId: string,
    memberName: string,
    contextPolicy: "auto" | "full" | "none",
    conversationScopeId: string | undefined,
    protectedWorkspaceIds: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> => {
    const target = resolveExecutionTarget(compositeWorkspaceId, memberName);
    if (remoteWorkspaces.has(target.executionWorkspaceId)) {
      const resumed = await remoteWorkspaces.resumeWorkspace(
        target.executionWorkspaceId,
        contextPolicy,
        conversationScopeId,
      );
      const presented = presentExecutionResult(resumed, target) as {
        structuredContent?: Record<string, unknown>;
      };
      return {
        member: memberName,
        ...(presented.structuredContent ?? {}),
      };
    }

    const opened = await workspaces.openWorkspace(
      { workspaceId: target.executionWorkspaceId, context: contextPolicy },
      { conversationScopeId, protectedWorkspaceIds },
    );
    const workspace = opened.workspace;
    const capabilityFingerprint = buildCapabilityFingerprint(config, FORGERELAY_VERSION, {
      artifactDownloadSupported: isArtifactDownloadSupportedPlatform(),
    });
    const capabilityCatalog = capabilityRegistry.catalog(capabilityContextFor(workspace));
    const agentsFiles = opened.agentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
      content: file.content,
    }));
    const availableAgentsFiles = opened.availableAgentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
    }));
    const skills = workspace.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description }));
    const capabilityGuides = workspace.capabilityGuides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    }));
    const agentProviders = config.subagents ? subagentProviders : [];
    const agents = workspace.agentProfiles.map((profile) => {
      const summary = summarizeSubagentProfile(profile);
      const availability = agentProviders.find((provider) => provider.name === summary.provider);
      return {
        ...summary,
        providerAvailable: availability?.available,
        providerUnavailableReason: availability?.reason,
      };
    });
    const bootstrapComponents = new Set<WorkspaceBootstrapComponent>(opened.bootstrapContextComponents);
    return {
      member: memberName,
      workspaceId: compositeWorkspaceId,
      root: workspace.root,
      mode: workspace.mode,
      contextFingerprint: opened.contextFingerprint,
      capabilityFingerprint,
      capabilityCatalog,
      includeBootstrapContext: opened.includeBootstrapContext,
      ...(bootstrapComponents.has("capabilityGuides") ? { capabilityGuides } : {}),
      ...(bootstrapComponents.has("agentsFiles") ? { agentsFiles } : {}),
      ...(bootstrapComponents.has("availableAgentsFiles") ? { availableAgentsFiles } : {}),
      ...(bootstrapComponents.has("skills") ? { skills } : {}),
      ...(bootstrapComponents.has("agentProfiles") ? { agentProviders, agents } : {}),
      ...(bootstrapComponents.has("skillDiagnostics")
        ? { skillDiagnostics: redactSkillDiagnosticPaths(workspace.skillDiagnostics) }
        : {}),
      instruction: opened.includeBootstrapContext
        ? `Bootstrap context for Composite member ${memberName}. Keep using Composite workspaceId ${compositeWorkspaceId} and pass member=${memberName} for work operations.`
        : contextPolicy === "none"
          ? `Bootstrap context for Composite member ${memberName} was intentionally suppressed by context=none. Keep using Composite workspaceId ${compositeWorkspaceId} with member=${memberName}; request context=auto or context=full when member bootstrap is needed.`
          : `Composite member ${memberName} context was already delivered for this Host context; keep using Composite workspaceId ${compositeWorkspaceId} with member=${memberName}.`,
    };
  };
  const coreOperations = createCoreOperationExecutor({
    read: async (input: ReadOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...readInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.read,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: readInput.path, offset: readInput.offset, limit: readInput.limit },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const readPath = workspaces.resolveReadPath(workspace, readInput.path);
            const discoveredInstructions = (await workspaces.discoverPathInstructions(
              workspace,
              readPath.absolutePath,
            )).filter((file) => file.path !== readPath.absolutePath);
            const response = await readFileTool(
              { ...readInput, path: readPath.absolutePath },
              {
                cwd: workspace.root,
                root: workspace.root,
                readRoots: readPath.readRoots,
              },
            );

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.read,
                ...workspaceLogContext(workspace, context.sessionId),
                path: readInput.path,
              }, response.content, startedAt);
              return response;
            }
            workspaces.markReadPathLoaded(workspace, readPath);

            const discoveredInstructionContent = discoveredInstructions.length > 0
              ? textBlock(formatDiscoveredWorkspaceInstructions(discoveredInstructions, workspace.root))
              : undefined;
            const content = discoveredInstructionContent
              ? [discoveredInstructionContent, ...response.content]
              : response.content;
            const summary = {
              ...textSummary(response.content),
              offset: readInput.offset ?? 1,
              limited: readInput.limit !== undefined,
            };
            logToolCall(config, {
              tool: toolNames.read,
              ...workspaceLogContext(workspace, context.sessionId),
              path: readInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              content,
              _meta: {
                tool: toolNames.read,
                card: {
                  workspaceId,
                  path: readInput.path,
                  summary,
                  payload: { content: response.content },
                },
              },
              structuredContent: {
                result: contentText(content),
                ...(discoveredInstructions.length > 0
                  ? {
                      agentsFiles: discoveredInstructions.map((file) => ({
                        path: formatAgentsPath(file.path, workspace.root),
                        content: file.content,
                      })),
                    }
                  : {}),
              },
            };
          },
        },
        activityRelationFor(context),
      );
    },
    write: async (input: WriteOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...writeInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.write,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: writeInput.path },
          isFailure: toolResultIsError,
          changedPaths: (result) => toolResultIsError(result) ? [] : [writeInput.path],
          operation: async () => {
            const startedAt = performance.now();
            await assertWorkspaceInstructionsLoadedBeforeSideEffect(
              workspaces,
              workspace,
              [writeInput.path],
            );
            const response = await writeFileTool(writeInput, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.write,
                ...workspaceLogContext(workspace, context.sessionId),
                path: writeInput.path,
              }, response.content, startedAt);
              return response;
            }

            const patch = newFilePatch(writeInput.path, writeInput.content);
            const stats = countDiffStats(patch);
            const summary = {
              ...stats,
              lines: contentLineCount(writeInput.content),
              characters: writeInput.content.length,
            };
            logToolCall(config, {
              tool: toolNames.write,
              ...workspaceLogContext(workspace, context.sessionId),
              path: writeInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              _meta: {
                tool: toolNames.write,
                card: {
                  workspaceId,
                  path: writeInput.path,
                  summary,
                  payload: {
                    content: response.content,
                    patch,
                  },
                },
              },
              structuredContent: {
                result: contentText(response.content),
              },
            };
          },
        },
        activityRelationFor(context),
      );
    },
    edit: async (input: EditOperationInput, context: CoreOperationContext) => {
      const { workspaceId, ...editInput } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.edit,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: editInput.path, editCount: editInput.edits.length },
          isFailure: toolResultIsError,
          changedPaths: (result) => toolResultIsError(result) ? [] : [editInput.path],
          operation: async () => {
            const startedAt = performance.now();
            await assertWorkspaceInstructionsLoadedBeforeSideEffect(
              workspaces,
              workspace,
              [editInput.path],
            );
            const response = await editFileTool(editInput, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.edit,
                ...workspaceLogContext(workspace, context.sessionId),
                path: editInput.path,
              }, response.content, startedAt);
              return response;
            }

            const stats = countDiffStats(
              response.details?.patch ?? response.details?.diff,
            );
            const summary = {
              ...stats,
              editCount: editInput.edits.length,
            };
            const editResultText = `Edited ${editInput.path} (+${stats.additions} -${stats.removals}).`;
            const editContent = [textBlock(editResultText)];
            logToolCall(config, {
              tool: toolNames.edit,
              ...workspaceLogContext(workspace, context.sessionId),
              path: editInput.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              content: editContent,
              _meta: {
                tool: toolNames.edit,
                card: {
                  workspaceId,
                  path: editInput.path,
                  summary,
                  payload: {
                    diff: response.details?.diff,
                    patch: response.details?.patch,
                  },
                },
              },
              structuredContent: {
                status: "applied" as const,
                result: contentText(editContent),
              },
            };
          },
        },
        activityRelationFor(context),
      );
    },
    rename: async (input: RenameOperationInput, context: CoreOperationContext) => {
      const { workspaceId, path, newPath } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.rename,
          invocation: workspaceHookInvocation(workspace),
          payload: { path, newPath, paths: [path, newPath] },
          changedPaths: () => [path, newPath],
          operation: async () => {
            const startedAt = performance.now();
            try {
              await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                workspaces,
                workspace,
                [path, newPath],
              );
              await renamePath({ path, newPath }, {
                cwd: workspace.root,
                allowedRoots: workspaces.fileToolRoots(workspace),
              });
              const result = `Renamed ${path} to ${newPath}.`;
              const content = [textBlock(result)];
              logToolCall(config, {
                tool: toolNames.rename,
                ...workspaceLogContext(workspace, context.sessionId),
                path: `${path} -> ${newPath}`,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return {
                content,
                _meta: {
                  tool: toolNames.rename,
                  card: {
                    workspaceId,
                    path: newPath,
                    summary: { previousPath: path },
                    payload: { content },
                  },
                },
                structuredContent: {
                  result,
                  status: "renamed" as const,
                  path,
                  newPath,
                },
              };
            } catch (error) {
              logToolCall(config, {
                tool: toolNames.rename,
                ...workspaceLogContext(workspace, context.sessionId),
                path: `${path} -> ${newPath}`,
                success: false,
                durationMs: Math.round(performance.now() - startedAt),
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        },
        activityRelationFor(context),
      );
    },
    delete: async (input: DeleteOperationInput, context: CoreOperationContext) => {
      const { workspaceId, path, recursive } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        activityRequestFor(input, context),
        {
          signal: context.signal,
          tool: toolNames.delete,
          invocation: workspaceHookInvocation(workspace),
          payload: { path, recursive: recursive ?? false },
          changedPaths: () => [path],
          operation: async () => {
            const startedAt = performance.now();
            try {
              await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                workspaces,
                workspace,
                [path],
              );
              const deleted = await deletePath({ path, recursive }, {
                cwd: workspace.root,
                allowedRoots: workspaces.fileToolRoots(workspace),
              });
              const result = `Deleted ${path}${deleted.recursive ? " recursively" : ""}.`;
              const content = [textBlock(result)];
              logToolCall(config, {
                tool: toolNames.delete,
                ...workspaceLogContext(workspace, context.sessionId),
                path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return {
                content,
                _meta: {
                  tool: toolNames.delete,
                  card: {
                    workspaceId,
                    path,
                    summary: { recursive: deleted.recursive },
                    payload: { content },
                  },
                },
                structuredContent: {
                  result,
                  status: "deleted" as const,
                  path,
                  recursive: deleted.recursive,
                },
              };
            } catch (error) {
              logToolCall(config, {
                tool: toolNames.delete,
                ...workspaceLogContext(workspace, context.sessionId),
                path,
                success: false,
                durationMs: Math.round(performance.now() - startedAt),
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          },
        },
        activityRelationFor(context),
      );
    },
    shellRun: async (input: ShellRunOperationInput, context: CoreOperationContext) => {
      const {
        workspaceId,
        command,
        surface,
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        timeoutMs,
        maxOutputTokens,
      } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      const activityRequest = surface === "exec_command"
        ? {
            workspaceId,
            cmd: command,
            tty,
            columns,
            rows,
            workingDirectory,
            yieldTimeMs,
            timeoutMs,
            maxOutputTokens,
          }
        : {
            workspaceId,
            action: "run" as const,
            command,
            tty,
            columns,
            rows,
            workingDirectory,
            yieldTimeMs,
            timeoutMs,
            maxOutputTokens,
          };
      let undeliveredProcessId: number | undefined;
      const activityResult = await runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        surface,
        activityRequestFor(activityRequest, context),
        async (activityContext) => {
          try {
            const result = await runToolWithHooks(hooks, {
              signal: context.signal,
              tool: surface,
              invocation: workspaceHookInvocation(workspace),
              payload: surface === "exec_command"
                ? { command, workingDirectory: workingDirectory ?? "." }
                : { action: "run", command, workingDirectory: workingDirectory ?? "." },
              ...(surface === "bash" ? { isFailure: toolResultIsError } : {}),
              operation: async () => {
                const startedAt = performance.now();
                const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
                await assertWorkspaceInstructionsLoadedBeforeSideEffect(
                  workspaces,
                  workspace,
                  [cwd],
                );
                const snapshot = await processSessions.start({
                  workspaceId,
                  command,
                  cwd,
                  workspaceRoot: workspace.root,
                  tty,
                  columns,
                  rows,
                  yieldTimeMs,
                  timeoutMs,
                  maxOutputTokens,
                  ...(surface === "exec_command" ? { codexCi: true } : {}),
                  signal: context.signal,
                  audit: activityContext,
                });
                undeliveredProcessId = snapshot.running ? snapshot.processId : undefined;

                logToolCall(config, {
                  tool: surface,
                  ...workspaceLogContext(workspace, context.sessionId),
                  workingDirectory: workingDirectory ?? ".",
                  command,
                  commandLength: command.length,
                  exitCode: snapshot.exitCode,
                  running: snapshot.running,
                  processId: snapshot.processId,
                  success: surface === "exec_command"
                    ? snapshot.running || snapshot.exitCode === 0
                    : snapshot.running || (snapshot.exitCode === 0 && !snapshot.signal),
                  durationMs: Math.round(performance.now() - startedAt),
                });

                const response = processToolResponse(surface, workspaceId, snapshot, {
                  ...(surface === "bash" ? { action: "run" } : {}),
                  command,
                  workingDirectory: workingDirectory ?? ".",
                  running: snapshot.running,
                  exitCode: snapshot.exitCode,
                  wallTimeMs: snapshot.wallTimeMs,
                });
                return surface === "bash" && !snapshot.running && (snapshot.signal || snapshot.exitCode !== 0)
                  ? { ...response, isError: true as const }
                  : response;
              },
            });
            context.signal?.throwIfAborted();
            return result;
          } catch (error) {
            if (undeliveredProcessId !== undefined) {
              processSessions.discardUndelivered(workspaceId, undeliveredProcessId);
            }
            throw error;
          }
        },
        processActivityOutcome,
        activityRelationFor(context),
      );
      markReturnedOutput(bashOutputStore, activityResult);
      return activityResult;
    },
    capabilityRun: async (input: CapabilityRunOperationInput, context: CoreOperationContext) => {
      const { workspaceId, name, arguments: capabilityArguments, file } = input;
      const workspace = workspaces.getWorkspace(workspaceId);
      let changedPaths: string[] = [];
      return runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(context.requestMeta, context.sessionId),
        toolNames.capability,
        activityRequestFor(capabilityActivityAuditRequest(input), context),
        (activityContext) => runToolWithHooks(hooks, {
          signal: context.signal,
          tool: toolNames.capability,
          invocation: workspaceHookInvocation(workspace),
          payload: { name, action: "run" },
          isFailure: toolResultIsError,
          changedPaths: () => changedPaths,
          operation: async () => {
            const startedAt = performance.now();
            try {
              const execution = await capabilityRegistry.run(
                name,
                capabilityArguments ?? {},
                capabilityContextFor(workspace),
                {
                  nativeFile: file,
                  signal: context.signal,
                  requestMeta: context.requestMeta,
                  sessionId: context.sessionId,
                  batch: context.batch,
                  activityId: activityContext.activityId,
                },
              );
              changedPaths = execution.changedPaths ?? [];
              const result = {
                content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
                ...(execution.card
                  ? {
                      _meta: {
                        tool: toolNames.capability,
                        card: {
                          workspaceId,
                          capabilityName: name,
                          summary: execution.card.summary ?? {},
                          files: execution.card.files,
                          payload: execution.card.payload ?? {},
                        },
                      },
                    }
                  : {}),
                structuredContent: { name, action: "run" as const, result: execution.value },
              };
              logToolCall(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace, context.sessionId),
                capability: name,
                action: "run",
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return result;
            } catch (error) {
              const capabilityError = error instanceof CapabilityError
                ? error
                : new CapabilityError(
                    "execution_failed",
                    error instanceof Error ? error.message : String(error),
                  );
              const result = {
                content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
                structuredContent: {
                  name,
                  action: "run" as const,
                  error: { code: capabilityError.code, message: capabilityError.message },
                },
                isError: true as const,
              };
              logFailedToolResponse(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace, context.sessionId),
                capability: name,
                action: "run",
              }, result.content, startedAt);
              return result;
            }
          },
        }),
        standardActivityOutcome,
        activityRelationFor(context),
        (result) => capabilityActivityAuditResult(name, result),
      );
    },
  });

  batchExecutor = new BatchExecutor({
    lifecycle: activityLifecycle,
    workspaces,
    coreOperations,
    resultIsError: toolResultIsError,
    capabilityBatchPolicy: (name) => capabilityRegistry.batchPolicy(name),
    shellSurface: "bash",
  });

  const nativeBulkMutations = new NativeBulkMutationExecutor({
    lifecycle: activityLifecycle,
    workspaces,
    coreOperations,
    preflightInstructions: (workspace, paths) =>
      assertWorkspaceInstructionsLoadedBeforeSideEffect(workspaces, workspace, paths),
    resultIsError: toolResultIsError,
    resultText: toolResultText,
    resultContent: toolResultContent,
  });

  const server = new McpServer(
    {
      name: "forgerelay",
      title: "ForgeRelay",
      version: FORGERELAY_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: buildServerInstructions(config),
    },
  );

  const workspacePanelStates = new Map<string, Record<string, unknown>>();
  const workspacePanelState = (workspaceId: string): Record<string, unknown> | undefined => {
    const remembered = workspacePanelStates.get(workspaceId);
    if (remoteWorkspaces.has(workspaceId) || compositeWorkspaces.has(workspaceId)) {
      return remembered;
    }
    try {
      const workspace = workspaces.getWorkspace(workspaceId);
      if (remembered) return remembered;
      return compactWorkspacePresentation({
        workspaceId: workspace.id,
        root: workspace.root,
        path: workspace.root,
        mode: workspace.mode,
        sourceRoot: workspace.sourceRoot,
        summary: { mode: workspace.mode },
      });
    } catch {
      return undefined;
    }
  };
  const rememberWorkspacePanelState = (
    workspaceId: string,
    response: { _meta?: unknown },
  ): void => {
    if (typeof response._meta !== "object" || response._meta === null) return;
    const meta = response._meta as Record<string, unknown>;
    const card = meta.card;
    if (meta.tool !== toolNames.openWorkspace || typeof card !== "object" || card === null) return;
    const compact = compactWorkspacePresentation(card as Record<string, unknown>);
    workspacePanelStates.set(
      workspaceId,
      {
        ...(workspacePanelStates.get(workspaceId) ?? {}),
        ...compact,
      },
    );
  };

  const workspaceAppResourceMetadata = {
    description: "Historical ForgeRelay tool card UI.",
    _meta: {
      ui: {
        domain: appDomain(config),
        csp: appCsp(config),
      },
    },
  };
  const workspaceLifecycleResourceMetadata = {
    description: "Historical ForgeRelay Workspace lifecycle UI compatibility resource.",
    _meta: workspaceAppResourceMetadata._meta,
  };
  const activityPanelResourceMetadata = {
    description: "ForgeRelay unified Workspace and Activity UI for one Host Turn.",
    _meta: workspaceAppResourceMetadata._meta,
  };

  const currentWorkspaceAppUri = currentWorkspaceAppIdentity(config).uri;
  registerAppResource(
    server,
    "ForgeRelay historical tool card",
    currentWorkspaceAppUri,
    workspaceAppResourceMetadata,
    async (uri, extra) => readWorkspaceAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );
  registerAppResource(
    server,
    "ForgeRelay historical tool card legacy",
    WORKSPACE_APP_LEGACY_URI,
    workspaceAppResourceMetadata,
    async (uri, extra) => readWorkspaceAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );
  server.registerResource(
    "ForgeRelay historical tool card compatibility",
    new ResourceTemplate(WORKSPACE_APP_URI_TEMPLATE, { list: undefined }),
    { ...workspaceAppResourceMetadata, mimeType: RESOURCE_MIME_TYPE },
    async (uri, _variables, extra) => readWorkspaceAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );

  server.registerResource(
    "ForgeRelay historical Workspace Lifecycle compatibility",
    new ResourceTemplate(WORKSPACE_LIFECYCLE_APP_URI_TEMPLATE, { list: undefined }),
    { ...workspaceLifecycleResourceMetadata, mimeType: RESOURCE_MIME_TYPE },
    async (uri, _variables, extra) => readWorkspaceLifecycleAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );

  const currentActivityPanelAppUri = currentActivityPanelAppIdentity(config).uri;
  registerAppResource(
    server,
    "ForgeRelay Activity Panel",
    currentActivityPanelAppUri,
    activityPanelResourceMetadata,
    async (uri, extra) => readActivityPanelAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );
  registerAppResource(
    server,
    "ForgeRelay Activity Panel legacy",
    ACTIVITY_PANEL_APP_LEGACY_URI,
    activityPanelResourceMetadata,
    async (uri, extra) => readActivityPanelAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );
  server.registerResource(
    "ForgeRelay Activity Panel compatibility",
    new ResourceTemplate(ACTIVITY_PANEL_APP_URI_TEMPLATE, { list: undefined }),
    { ...activityPanelResourceMetadata, mimeType: RESOURCE_MIME_TYPE },
    async (uri, _variables, extra) => readActivityPanelAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );

  registerAppTool(
    server,
    "open_workspace",
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
    },
    async ({
      action = "open",
      memberAction,
      member,
      kind,
      name,
      memberName,
      path,
      relay,
      workspaceId,
      mode,
      baseRef,
      newWorktree,
      newWorkspace,
      context,
      root,
      status,
      state,
      staleOnly,
      offset,
      limit,
    }, { _meta, sessionId }) => {
      const startedAt = performance.now();
      const conversationScopeId = openAiConversationScopeId(_meta);
      const protectedWorkspaceIds = processSessions.activeWorkspaceIds();

      const inspectTaskSummary = (targetWorkspaceId: string) => {
        try {
          const summary = workspaceTasks.inspectSummary(targetWorkspaceId);
          if (!summary) return undefined;
          const { fingerprint: _fingerprint, ...inspectionSummary } = summary;
          return inspectionSummary;
        } catch {
          return undefined;
        }
      };
      const inspectCompositeMember = async (entry: { name: string; purpose: string; workspaceId: string }) => {
        if (remoteWorkspaces.has(entry.workspaceId)) {
          try {
            const inspected = await remoteWorkspaces.inspectWorkspace(entry.workspaceId);
            return {
              name: entry.name,
              purpose: entry.purpose,
              workspaceId: entry.workspaceId,
              known: true,
              location: inspected.location,
              routeState: inspected.routeState,
              state: inspected.state,
              status: inspected.status,
              mode: inspected.mode,
              rootValid: inspected.rootValid,
            };
          } catch {
            return {
              name: entry.name,
              purpose: entry.purpose,
              workspaceId: entry.workspaceId,
              known: false,
            };
          }
        }
        try {
          const inspected = await workspaces.inspectWorkspace(entry.workspaceId);
          return {
            name: entry.name,
            purpose: entry.purpose,
            workspaceId: entry.workspaceId,
            known: true,
            location: inspected.location,
            state: inspected.state,
            status: inspected.status,
            mode: inspected.mode,
            rootValid: inspected.rootValid,
          };
        } catch {
          return {
            name: entry.name,
            purpose: entry.purpose,
            workspaceId: entry.workspaceId,
            known: false,
          };
        }
      };

      if (action === "inspect") {
        if (!workspaceId) {
          throw new Error("open_workspace action=inspect requires workspaceId.");
        }
        if (
          memberAction !== undefined || member !== undefined || kind !== undefined || name !== undefined ||
          memberName !== undefined || path !== undefined || relay !== undefined || mode !== undefined ||
          baseRef !== undefined || newWorktree !== undefined || newWorkspace !== undefined || context !== undefined ||
          root !== undefined || status !== undefined || state !== undefined || staleOnly !== undefined ||
          offset !== undefined || limit !== undefined
        ) {
          throw new Error("open_workspace action=inspect accepts only workspaceId. It never opens, resumes, binds, or mutates the inspected Workspace.");
        }

        let inspection: z.infer<typeof workspaceInspectionOutputSchema>;
        if (compositeWorkspaces.has(workspaceId)) {
          const composite = compositeWorkspaces.get(workspaceId);
          const members = await Promise.all(composite.members.map(inspectCompositeMember));
          const taskSummary = inspectTaskSummary(composite.id);
          inspection = {
            workspaceId: composite.id,
            kind: "composite",
            name: composite.name,
            status: composite.status,
            state: composite.status,
            createdAt: composite.createdAt,
            lastUsedAt: composite.lastUsedAt,
            members,
            ...(taskSummary ? { taskSummary } : {}),
          };
        } else if (remoteWorkspaces.has(workspaceId)) {
          inspection = await remoteWorkspaces.inspectWorkspace(workspaceId);
        } else {
          const inspected = await workspaces.inspectWorkspace(workspaceId);
          const taskSummary = inspectTaskSummary(inspected.workspaceId);
          inspection = {
            ...inspected,
            ...(taskSummary ? { taskSummary } : {}),
          };
        }

        const instruction =
          "This is a bounded read-only Workspace inspection. It does not open/resume the target, deliver bootstrap context, bind this conversation, or grant file/process/Git/Capability authority. Explicitly open the Workspace before modifying or executing against it.";
        const result = [
          `Inspected Workspace ${inspection.workspaceId} (${inspection.kind}).`,
          inspection.kind === "composite"
            ? `State: ${inspection.state}; members=${inspection.members.length}.`
            : inspection.location === "relay"
              ? inspection.state
                ? `State: ${inspection.state}; route=${inspection.routeState}; mode=${inspection.mode}; location=${inspection.location}. Lifecycle and Task facts come from the Execution ForgeRelay.`
                : `Route: ${inspection.routeState}; mode=${inspection.mode}; location=${inspection.location}.`
              : `State: ${inspection.state}; mode=${inspection.mode}; location=${inspection.location}.`,
          "Task summary is included only when durable Task state already exists on the owning Workspace; Task bodies are never returned.",
          instruction,
        ].join("\n");
        logToolCall(config, {
          tool: "open_workspace",
          action: "inspect",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: {
            action: "inspect" as const,
            workspaceId: inspection.workspaceId,
            kind: inspection.kind,
            inspection,
            instruction,
          },
        };
      }

      if (action === "member") {
        if (!workspaceId || !compositeWorkspaces.has(workspaceId)) {
          throw new Error("open_workspace action=member requires an existing Composite Workspace workspaceId.");
        }
        if (!compositeWorkspaces.isActive(workspaceId)) {
          throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before changing members.`);
        }
        if (!memberAction || !member) {
          throw new Error("open_workspace action=member requires memberAction and member.");
        }
        if (
          kind !== undefined || name !== undefined || memberName !== undefined || path !== undefined || relay !== undefined || mode !== undefined ||
          baseRef !== undefined || newWorktree !== undefined || newWorkspace !== undefined || context !== undefined ||
          root !== undefined || status !== undefined || state !== undefined || staleOnly !== undefined ||
          offset !== undefined || limit !== undefined
        ) {
          throw new Error(
            "open_workspace action=member accepts workspaceId, memberAction, and member only. Put any Workspace open definition inside member.",
          );
        }

        const resolveMemberTargetWorkspaceId = async (): Promise<string> => {
          const byWorkspaceId = typeof member.workspaceId === "string" && member.workspaceId.length > 0;
          const byPath = typeof member.path === "string" && member.path.length > 0;
          if (byWorkspaceId === byPath) {
            throw new Error("A Composite Workspace member target requires exactly one of member.workspaceId or member.path.");
          }
          if (byWorkspaceId) {
            const targetWorkspaceId = member.workspaceId!;
            if (compositeWorkspaces.has(targetWorkspaceId)) {
              throw new Error("A Composite Workspace cannot be mounted as a Composite Workspace member.");
            }
            if (
              member.relay !== undefined || member.mode !== undefined || member.baseRef !== undefined ||
              member.newWorktree !== undefined || member.newWorkspace !== undefined
            ) {
              throw new Error("member.workspaceId cannot be combined with relay/mode/baseRef/newWorktree/newWorkspace.");
            }
            if (!remoteWorkspaces.has(targetWorkspaceId)) workspaces.getWorkspace(targetWorkspaceId);
            return targetWorkspaceId;
          }
          if (member.relay !== undefined) {
            const opened = await remoteWorkspaces.openWorkspace(member.relay, {
              path: member.path!,
              ...(member.mode ? { mode: member.mode } : {}),
              ...(member.baseRef ? { baseRef: member.baseRef } : {}),
              ...(member.newWorktree !== undefined ? { newWorktree: member.newWorktree } : {}),
              ...(member.newWorkspace !== undefined ? { newWorkspace: member.newWorkspace } : {}),
              context: "none",
            });
            return opened.workspaceId;
          }
          const opened = await workspaces.openWorkspace(
            {
              path: member.path,
              ...(member.mode ? { mode: member.mode } : {}),
              ...(member.baseRef ? { baseRef: member.baseRef } : {}),
              ...(member.newWorktree !== undefined ? { newWorktree: member.newWorktree } : {}),
              ...(member.newWorkspace !== undefined ? { newWorkspace: member.newWorkspace } : {}),
              context: "none",
            },
            { protectedWorkspaceIds },
          );
          return opened.workspace.id;
        };

        let composite;
        if (memberAction === "add") {
          if (member.newName !== undefined) {
            throw new Error("Adding a Composite Workspace member does not accept member.newName.");
          }
          const purpose = member.purpose?.trim();
          if (!purpose) throw new Error("Adding a Composite Workspace member requires member.purpose.");
          const targetWorkspaceId = await resolveMemberTargetWorkspaceId();
          composite = compositeWorkspaces.addMember(workspaceId, {
            name: member.name,
            purpose,
            workspaceId: targetWorkspaceId,
          });
        } else if (memberAction === "update") {
          const targetFieldsPresent =
            member.workspaceId !== undefined || member.path !== undefined || member.relay !== undefined ||
            member.mode !== undefined || member.baseRef !== undefined || member.newWorktree !== undefined ||
            member.newWorkspace !== undefined;
          if (member.newName === undefined && member.purpose === undefined && !targetFieldsPresent) {
            throw new Error("Updating a Composite Workspace member requires newName, purpose, or a replacement Workspace target.");
          }
          const targetWorkspaceId = targetFieldsPresent
            ? await resolveMemberTargetWorkspaceId()
            : undefined;
          composite = compositeWorkspaces.updateMember(workspaceId, member.name, {
            ...(member.newName !== undefined ? { name: member.newName } : {}),
            ...(member.purpose !== undefined ? { purpose: member.purpose } : {}),
            ...(targetWorkspaceId !== undefined ? { workspaceId: targetWorkspaceId } : {}),
          });
        } else {
          if (
            member.newName !== undefined || member.purpose !== undefined || member.workspaceId !== undefined || member.path !== undefined ||
            member.relay !== undefined || member.mode !== undefined || member.baseRef !== undefined ||
            member.newWorktree !== undefined || member.newWorkspace !== undefined
          ) {
            throw new Error("Removing a Composite Workspace member accepts only member.name.");
          }
          composite = compositeWorkspaces.removeMember(workspaceId, member.name);
        }

        const memberActionVerb = memberAction === "add"
          ? "Added"
          : memberAction === "update"
            ? "Updated"
            : "Removed";
        const memberActionPreposition = memberAction === "remove" ? "from" : "in";
        const instruction = [
          `${memberActionVerb} member ${member.name} ${memberActionPreposition} Composite Workspace ${composite.name} (${composite.id}).`,
          composite.members.length > 0
            ? `Members: ${composite.members.map((entry) => `${entry.name} — ${entry.purpose}`).join("; ")}.`
            : "This Composite Workspace currently has no members.",
          "Use the Composite workspaceId as the top-level handle. Work operations on it require an explicit member name; ForgeRelay never infers a member from tool type or purpose.",
        ].join("\n");
        const response = {
          content: [textBlock(instruction)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: composite.id,
              kind: "composite" as const,
              name: composite.name,
              path: composite.name,
              members: composite.members,
              instruction,
              summary: { members: composite.members.length },
            },
          },
          structuredContent: {
            action: "member" as const,
            workspaceId: composite.id,
            memberAction,
            kind: "composite" as const,
            name: composite.name,
            members: composite.members,
            instruction,
          },
        };
        rememberWorkspacePanelState(composite.id, response);
        return response;
      }

      if (action === "list") {
        if (
          path !== undefined || relay !== undefined || name !== undefined || memberName !== undefined || baseRef !== undefined || newWorktree !== undefined ||
          newWorkspace !== undefined || context !== undefined
        ) {
          throw new Error(
            "open_workspace action=list does not accept path, relay, name, memberName, baseRef, newWorktree, newWorkspace, or context. Use kind/root/workspaceId/mode/status/state/staleOnly for inventory filters.",
          );
        }
        const compositeInventory = () => compositeWorkspaces.list()
          .filter((entry) => workspaceId === undefined || entry.id === workspaceId)
          .filter((entry) => status === undefined || entry.status === status)
          .filter((entry) => state === undefined || entry.status === state)
          .map((entry) => ({
            workspaceId: entry.id,
            kind: entry.kind,
            name: entry.name,
            status: entry.status,
            state: entry.status,
            members: entry.members,
            createdAt: entry.createdAt,
            lastUsedAt: entry.lastUsedAt,
          }));
        if (kind === "composite") {
          if (
            root !== undefined || mode !== undefined || staleOnly !== undefined ||
            offset !== undefined || limit !== undefined
          ) {
            throw new Error(
              "Composite Workspace inventory does not accept root/mode/staleOnly/offset/limit filters; use workspaceId/status/state when selecting Composite Workspaces.",
            );
          }
          const composites = compositeInventory();
          const instruction =
            "Open a Composite Workspace by workspaceId to resume or reopen it. close_workspace preserves its identity; action=delete permanently dissolves only Composite-owned state.";
          const result = [
            `Composite Workspace inventory: ${composites.length} matching record${composites.length === 1 ? "" : "s"}.`,
            ...composites.map((entry) => `${entry.name} [${entry.workspaceId}] state=${entry.state} members=${entry.members.length} last-used=${entry.lastUsedAt}`),
            instruction,
          ].join("\n");
          return {
            content: [textBlock(result)],
            structuredContent: {
              action: "list" as const,
              compositeWorkspaces: composites,
              instruction,
            },
          };
        }
        const inventory = await workspaces.listWorkspaces(
          { workspaceId, mode, root, status, state, staleOnly, offset, limit },
          { conversationScopeId, protectedWorkspaceIds },
        );
        const composites = kind === "workspace" || root !== undefined || mode !== undefined || staleOnly
          ? []
          : compositeInventory();
        const nextOffset = inventory.page.offset + inventory.page.limit;
        const instruction = [
          "Resume a selected workspaceId with open_workspace(action=\"open\", workspaceId=...).",
          "Use close_workspace only after the user chooses cleanup; Composite close preserves identity, while action=delete dissolves only Composite-owned state. Never close inventory entries automatically.",
          inventory.page.hasMore
            ? `More matching workspaces are available; continue with offset=${nextOffset}.`
            : undefined,
        ].filter(Boolean).join(" ");
        const result = [
          `Logical workspace inventory: ${inventory.summary.matching} matching ordinary records; ${composites.length} Composite Workspace record${composites.length === 1 ? "" : "s"}.`,
          `States: active=${inventory.summary.active}, stale=${inventory.summary.stale}, invalid=${inventory.summary.invalid}, closed=${inventory.summary.closed}.`,
          ...inventory.workspaces.map((entry) => [
            entry.label,
            `state=${entry.state}`,
            `status=${entry.status}`,
            `mode=${entry.mode}`,
            entry.managed ? "managed" : undefined,
            entry.current ? "current" : undefined,
            `root=${entry.root}`,
            `last-used=${entry.lastUsedAt}`,
          ].filter(Boolean).join(" ")),
          ...composites.map((entry) => `${entry.name} [${entry.workspaceId}] kind=composite state=${entry.state} members=${entry.members.length}`),
          instruction,
        ].join("\n");
        logToolCall(config, {
          tool: "open_workspace",
          action: "list",
          path: root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: {
            action: "list" as const,
            ...inventory,
            ...(composites.length > 0 ? { compositeWorkspaces: composites } : {}),
            instruction,
          },
        };
      }

      if (
        root !== undefined || status !== undefined || state !== undefined ||
        staleOnly !== undefined || offset !== undefined || limit !== undefined
      ) {
        throw new Error(
          "open_workspace inventory filters root, status, state, staleOnly, offset, and limit are only valid with action=list.",
        );
      }

      const openingComposite = kind === "composite" ||
        (workspaceId !== undefined && compositeWorkspaces.has(workspaceId));
      if (openingComposite) {
        if (relay !== undefined || path !== undefined || mode !== undefined || baseRef !== undefined ||
          newWorktree !== undefined || newWorkspace !== undefined) {
          throw new Error(
            "Composite Workspace open accepts name/workspaceId/context only; members are attached separately and keep their own Workspace definitions.",
          );
        }
        if (workspaceId !== undefined && kind === "workspace") {
          throw new Error(`${workspaceId} is a Composite Workspace, not an ordinary Workspace.`);
        }
        const composite = workspaceId !== undefined
          ? compositeWorkspaces.open(workspaceId)
          : compositeWorkspaces.create(name ?? "");
        workspaceTasks.initializeWorkspace(composite.id);
        const compositeTaskContext = compositeCapabilityContext(composite.id, compositeTaskGuides);
        const compositeCapabilityCatalog = capabilityRegistry.catalog(compositeTaskContext);
        const compositeCapabilityGuides = compositeTaskGuides.map((guide) => ({
          name: guide.name,
          description: guide.description,
          whenToRead: guide.whenToRead,
          path: formatPathForPrompt(guide.filePath),
        }));
        const memberContext = memberName
          ? await loadCompositeMemberContext(
              composite.id,
              memberName,
              context ?? "auto",
              conversationScopeId,
              protectedWorkspaceIds,
            )
          : undefined;
        const instruction = [
          `This is Composite Workspace ${composite.name} (${composite.id}).`,
          "It has no mounted working directory of its own. Use the Composite workspaceId as the top-level Workspace handle and explicitly select one named member for member-scoped work operations.",
          composite.members.length > 0
            ? `Members: ${composite.members.map((member) => `${member.name} — ${member.purpose}`).join("; ")}.`
            : "This Composite Workspace currently has no members.",
          "Member names and purposes are structural context and are always returned when this Composite Workspace is opened. context=auto/full/none controls only heavy member bootstrap context, not this Composite identity.",
          compositeCapabilityCatalog.length > 0
            ? `Composite-owned capabilities: ${compositeCapabilityCatalog.map((entry) => entry.name).join(", ")}. Use these without member because their state belongs to the Composite Workspace itself.`
            : undefined,
          composite.members.length > 0
            ? "Before first work on a member, reopen this Composite Workspace with memberName=<member> and context=auto to receive that member's project bootstrap without creating an implicit current member."
            : undefined,
          "close_workspace preserves this Composite identity for later reopen. Use action=delete only when the user explicitly wants to dissolve the Composite relationship; neither operation closes or cleans up member Workspaces.",
        ].join("\n\n");
        const response = {
          content: [textBlock(instruction)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: composite.id,
              kind: "composite" as const,
              name: composite.name,
              path: composite.name,
              members: composite.members,
              instruction,
              summary: { members: composite.members.length, status: composite.status },
            },
          },
          structuredContent: {
            action: "open" as const,
            workspaceId: composite.id,
            kind: "composite" as const,
            name: composite.name,
            status: composite.status,
            state: composite.status,
            members: composite.members,
            capabilityCatalog: compositeCapabilityCatalog,
            capabilityGuides: compositeCapabilityGuides,
            ...(memberContext ? { memberContext } : {}),
            instruction,
          },
        };
        logToolCall(config, {
          tool: "open_workspace",
          action: "composite",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        rememberWorkspacePanelState(composite.id, response);
        return response;
      }
      if (name !== undefined || memberName !== undefined) {
        throw new Error("open_workspace name/memberName are only valid for a Composite Workspace.");
      }
      if (workspaceId !== undefined && remoteWorkspaces.has(workspaceId)) {
        if (
          path !== undefined || relay !== undefined || mode !== undefined || baseRef !== undefined ||
          newWorktree !== undefined || newWorkspace !== undefined
        ) {
          throw new Error("Resuming a relayed Workspace by workspaceId accepts context only.");
        }
        const resumed = await remoteWorkspaces.resumeWorkspace(
          workspaceId,
          context ?? "auto",
          hostScopeIdFor(_meta, sessionId),
        );
        rememberWorkspacePanelState(workspaceId, resumed);
        return resumed;
      }
      if (relay !== undefined) {
        if (!path) throw new Error("Relayed open_workspace requires path.");
        const opened = await remoteWorkspaces.openWorkspace(relay, {
          path,
          mode,
          baseRef,
          newWorktree,
          newWorkspace,
          context,
        }, hostScopeIdFor(_meta, sessionId));
        const relayedSkills = Array.isArray(opened.skills)
          ? opened.skills as Array<{ name?: unknown }>
          : [];
        const relayedCapabilities = Array.isArray(opened.capabilityCatalog)
          ? opened.capabilityCatalog as Array<{ name?: unknown }>
          : [];
        const result = [
          `Opened relayed workspace ${opened.workspaceId}.`,
          `Execution remote: ${relay}`,
          `Root: ${opened.root}`,
          `Mode: ${opened.mode}`,
          relayedSkills.length > 0
            ? `Available skills: ${relayedSkills.map((skill) => String(skill.name ?? "")).filter(Boolean).join(", ")}`
            : undefined,
          relayedCapabilities.length > 0
            ? `Optional capabilities: ${relayedCapabilities.map((entry) => String(entry.name ?? "")).filter(Boolean).join(", ")}`
            : undefined,
          opened.instruction,
        ].filter(Boolean).join("\n");
        const response = {
          content: [textBlock(result)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: opened.workspaceId,
              kind: "workspace" as const,
              root: opened.root,
              path: opened.root,
              mode: opened.mode,
              relay,
              instruction: opened.instruction,
              summary: { mode: opened.mode, relay },
            },
          },
          structuredContent: {
            action: "open" as const,
            workspaceId: opened.workspaceId,
            kind: "workspace" as const,
            root: opened.root,
            mode: opened.mode,
            ...(opened.sourceRoot ? { sourceRoot: opened.sourceRoot } : {}),
            ...(opened.contextFingerprint !== undefined
              ? { contextFingerprint: opened.contextFingerprint }
              : {}),
            ...(opened.capabilityFingerprint !== undefined
              ? { capabilityFingerprint: opened.capabilityFingerprint }
              : {}),
            ...(opened.capabilityCatalog !== undefined
              ? { capabilityCatalog: opened.capabilityCatalog }
              : {}),
            ...(opened.capabilityGuides !== undefined
              ? { capabilityGuides: opened.capabilityGuides }
              : {}),
            ...(opened.agentsFiles !== undefined ? { agentsFiles: opened.agentsFiles } : {}),
            ...(opened.availableAgentsFiles !== undefined
              ? { availableAgentsFiles: opened.availableAgentsFiles }
              : {}),
            ...(opened.skills !== undefined ? { skills: opened.skills } : {}),
            ...(opened.agentProviders !== undefined
              ? { agentProviders: opened.agentProviders }
              : {}),
            ...(opened.agents !== undefined ? { agents: opened.agents } : {}),
            ...(opened.skillDiagnostics !== undefined
              ? { skillDiagnostics: opened.skillDiagnostics }
              : {}),
            instruction: opened.instruction,
          },
        };
        logToolCall(config, {
          tool: "open_workspace",
          action: "relay",
          path: opened.root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        rememberWorkspacePanelState(opened.workspaceId, response);
        return response;
      }

      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        hookReports,
        workspaceReused,
        includeBootstrapContext,
        bootstrapContextComponents,
        contextFingerprint,
      } = await workspaces.openWorkspace(
        { path, workspaceId, mode, baseRef, newWorktree, newWorkspace, context },
        {
          conversationScopeId,
          protectedWorkspaceIds,
        },
      );
      workspaceTasks.initializeWorkspace(workspace.id);
      const knownWorktrees = await workspaces.listKnownWorktrees(workspace);
      const staleWorkspaces = await workspaces.listStaleWorkspaces(workspace);
      const capabilityFingerprint = buildCapabilityFingerprint(config, FORGERELAY_VERSION, {
        artifactDownloadSupported: isArtifactDownloadSupportedPlatform(),
      });
      if (config.widgets === "changes") {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
        }));
      const capabilityGuides = workspace.capabilityGuides.map((guide) => ({
        name: guide.name,
        description: guide.description,
        whenToRead: guide.whenToRead,
        path: formatPathForPrompt(guide.filePath),
      }));
      const capabilityCatalog = capabilityRegistry.catalog(capabilityContextFor(workspace));
      const cardAgentProviders = config.subagents ? subagentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeSubagentProfile(profile);
        const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const bootstrapComponents = new Set<WorkspaceBootstrapComponent>(bootstrapContextComponents);
      const visibleSkills = bootstrapComponents.has("skills") ? cardSkills : [];
      const visibleSkillDiagnostics = bootstrapComponents.has("skillDiagnostics")
        ? redactSkillDiagnosticPaths(workspace.skillDiagnostics)
        : [];
      const visibleCapabilityGuides = bootstrapComponents.has("capabilityGuides") ? capabilityGuides : [];
      const visibleAgentProviders = bootstrapComponents.has("agentProfiles") ? cardAgentProviders : [];
      const visibleAgents = bootstrapComponents.has("agentProfiles") ? cardAgents : [];
      const loadedAgentsFiles = bootstrapComponents.has("agentsFiles") ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = bootstrapComponents.has("availableAgentsFiles")
        ? cardAvailableAgentsFiles
        : [];
      const workspaceContextInstruction =
        "For later open_workspace calls, context=\"auto\" avoids repeating unchanged bootstrap context; use context=\"none\" when only the workspace handle/metadata is needed, or context=\"full\" to force a refresh.";
      const workspaceManagementInstruction =
        "Use open_workspace(action=\"list\") for lightweight Workspace inventory. Use action=\"inspect\" with one known workspaceId for bounded read-only metadata without opening/resuming it. Explicitly open a Workspace before executing or mutating against it, and ask the user before close_workspace cleanup.";
      const cardInstruction = config.skillsEnabled
        ? `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches an available skill, load it with read(path=\"skills://<name>\") before proceeding. When a task matches a capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`
        : `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches a capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`;
      const instruction = workspaceReused
        ? includeBootstrapContext
          ? [
              `Workspace already exists as ${workspace.id} for this directory.`,
              "Reuse this workspaceId for subsequent tool calls.",
              `Project bootstrap context components included in this response: ${bootstrapContextComponents.join(", ")}. Components not listed are unchanged and are not repeated.`,
              workspaceContextInstruction,
              workspaceManagementInstruction,
            ].join("\n\n")
          : [
              `Workspace already open as ${workspace.id}.`,
              "Reuse this workspaceId for subsequent tool calls. This is the same directory previously opened in this conversation.",
              "Continue following the project instructions, nested instruction files, skills, capability guides, agent profiles, and diagnostics previously provided for this workspace. They remain active and are not repeated here.",
              workspaceContextInstruction,
              workspaceManagementInstruction,
            ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent tool calls. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for this isolated worktree."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            capabilityCatalog.length > 0
              ? `Optional capabilities: ${capabilityCatalog.map((entry) => entry.name).join(", ")}`
              : undefined,
            visibleCapabilityGuides.length > 0
              ? `Capability guides: ${visibleCapabilityGuides.map((guide) => guide.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableSubagentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatAvailableSubagentProfile).join(", ")}`
              : undefined,
            knownWorktrees.length > 0
              ? `Known worktrees: ${knownWorktrees.map((worktree) => `${worktree.path} [${worktree.workspaceId}]${worktree.branch ? ` branch=${worktree.branch}` : ""}${worktree.targetBranch ? ` target=${worktree.targetBranch}` : ""}${worktree.current ? " (current)" : ""}`).join(", ")}`
              : undefined,
            staleWorkspaces.length > 0
              ? `This Workspace has been idle for more than 2 days: ${staleWorkspaces.map((stale) => `${stale.workspaceId} last-used=${stale.lastUsedAt}`).join(", ")}. It remains available to resume or explicitly close; do not clean it up automatically.`
              : undefined,
            `ForgeRelay ${capabilityFingerprint.version} capabilities: ${capabilityFingerprint.capabilities.join(", ")}`,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        ...workspaceLogContext(workspace, sessionId),
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const workspaceCard = {
        workspaceId: workspace.id,
        kind: "workspace" as const,
        root: workspace.root,
        path: workspace.root,
        mode: workspace.mode,
        workspaceReused,
        includeBootstrapContext,
        sourceRoot: workspace.sourceRoot,
        worktree: workspace.worktree,
        worktrees: knownWorktrees,
        staleWorkspaces,
        capabilityFingerprint,
        contextFingerprint,
        capabilityCatalog,
        agentsFiles: cardAgentsFiles,
        availableAgentsFiles: cardAvailableAgentsFiles,
        skills: cardSkills,
        agentProviders: cardAgentProviders,
        agents: cardAgents,
        instruction: cardInstruction,
        summary: {
          mode: workspace.mode,
          agentsFiles: cardAgentsFiles.length,
          availableAgentsFiles: cardAvailableAgentsFiles.length,
          skills: cardSkills.length,
          capabilities: capabilityCatalog.length,
          agentProviders: cardAgentProviders.length,
          agents: cardAgents.length,
        },
      };
      const response = hooks.decorateResult(workspace.id, attachHookReports({
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: includeBootstrapContext
            ? workspaceCard
            : compactWorkspacePresentation(workspaceCard),
        },
        structuredContent: {
          action: "open" as const,
          workspaceId: workspace.id,
          kind: "workspace" as const,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          worktrees: knownWorktrees,
          staleWorkspaces,
          capabilityFingerprint,
          contextFingerprint,
          capabilityCatalog,
          ...(bootstrapComponents.has("capabilityGuides")
            ? { capabilityGuides: visibleCapabilityGuides }
            : {}),
          ...(bootstrapComponents.has("agentsFiles") ? { agentsFiles: loadedAgentsFiles } : {}),
          ...(bootstrapComponents.has("availableAgentsFiles")
            ? { availableAgentsFiles: availableAgentsFileOutputs }
            : {}),
          ...(bootstrapComponents.has("skills") ? { skills: visibleSkills } : {}),
          ...(bootstrapComponents.has("agentProfiles")
            ? { agentProviders: visibleAgentProviders, agents: visibleAgents }
            : {}),
          ...(bootstrapComponents.has("skillDiagnostics")
            ? { skillDiagnostics: visibleSkillDiagnostics }
            : {}),
          instruction,
        },
      }, hookReports));
      rememberWorkspacePanelState(workspace.id, response);
      return response;
    },
  );

  registerActivityQueryTools(
    server,
    activityQueries,
    connectionScopeId,
    toolWidgetDescriptorMeta(config, "activity")._meta,
    config.activityPanelExpanded,
    config.logging,
    workspacePanelState,
    {
      panel: async (workspaceId, conversationScopeId) => {
        if (compositeWorkspaces.has(workspaceId)) {
          return compositeActivity.beginPanel(workspaceId, conversationScopeId);
        }
        return remoteWorkspaces.has(workspaceId)
          ? remoteWorkspaces.activityPanel(workspaceId, conversationScopeId)
          : undefined;
      },
      snapshot: async (input, conversationScopeId) => {
        const compositeTurnId = input.turnId ?? (
          input.workspaceId && compositeWorkspaces.has(input.workspaceId)
            ? compositeActivity.currentTurnId(conversationScopeId, input.workspaceId)
            : undefined
        );
        if (compositeTurnId) {
          const composite = await compositeActivity.snapshot(compositeTurnId, input.knownRevision);
          if (composite) return composite;
        }
        return remoteWorkspaces.activitySnapshot(input, conversationScopeId);
      },
      index: async (turnId, knownRevision, conversationScopeId) => {
        const composite = await compositeActivity.index(turnId, knownRevision);
        return composite ?? remoteWorkspaces.activityIndex(turnId, knownRevision, conversationScopeId);
      },
      detail: async (turnId, activityId, conversationScopeId) => {
        const composite = await compositeActivity.detail(turnId, activityId);
        return composite ?? remoteWorkspaces.activityDetail(turnId, activityId, conversationScopeId);
      },
      output: async (turnId, outputId, conversationScopeId, cursor) => {
        const composite = await compositeActivity.output(turnId, outputId, cursor);
        return composite ?? remoteWorkspaces.activityOutput(turnId, outputId, conversationScopeId, cursor);
      },
    },
  );
  registerAppTool(
    server,
    toolNames.capability,
    {
      title: "Use optional capability",
      description:
        "Describe or run one optional ForgeRelay capability advertised by open_workspace. Use describe when the capability contract is unfamiliar, then read its advertised guide if needed. Run dispatches only explicitly registered capabilities; it cannot invoke arbitrary shell commands, URLs, or methods.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name whose capability surface is used."),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
          .describe("Stable dotted capability name advertised by open_workspace."),
        action: z.enum(["describe", "run"]),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Capability-specific JSON arguments. Omit for describe and for capabilities with no arguments."),
        file: z
          .unknown()
          .optional()
          .describe("Host-native file value. Only capabilities whose describe result advertises native-file transport may consume it."),
      },
      outputSchema: {
        name: z.string(),
        action: z.enum(["describe", "run"]),
        member: z.string().optional(),
        capability: z.unknown().optional(),
        result: z.unknown().optional(),
        error: capabilityErrorOutputSchema.optional(),
      },
      _meta: {
        ...toolWidgetDescriptorMeta(config, "capability")._meta,
        "openai/fileParams": ["file"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, member, name, action, arguments: capabilityArguments, file }, extra) => {
      if (name === "workspace.tasks" && compositeWorkspaces.has(workspaceId)) {
        if (member !== undefined) {
          throw new Error(
            `workspace.tasks belongs to Composite Workspace ${workspaceId} itself and does not accept member.`,
          );
        }
        if (!compositeWorkspaces.isActive(workspaceId)) {
          throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before use.`);
        }
        const startedAt = performance.now();
        const context = compositeCapabilityContext(workspaceId, compositeTaskGuides);
        try {
          if (action === "run") {
            const execution = await capabilityRegistry.run(
              name,
              capabilityArguments ?? {},
              context,
              {
                nativeFile: file,
                signal: extra.signal,
                requestMeta: extra._meta,
                sessionId: extra.sessionId,
              },
            );
            const result = {
              content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
              structuredContent: { name, action, result: execution.value },
            };
            logToolCall(config, {
              tool: toolNames.capability,
              capability: name,
              action,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return result;
          }

          const capability = capabilityRegistry.describe(name, context);
          const result = {
            content: [textBlock([
              `${capability.name}: ${capability.description}`,
              `Available: ${capability.available}`,
              `Guide: ${capability.guide.path}`,
              capability.guide.readBeforeFirstUse
                ? "Read the guide before first use when this contract is unfamiliar."
                : undefined,
            ].filter(Boolean).join("\n"))],
            structuredContent: { name, action, capability },
          };
          logToolCall(config, {
            tool: toolNames.capability,
            capability: name,
            action,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return result;
        } catch (error) {
          if (extra.signal.aborted) throw error;
          const capabilityError = error instanceof CapabilityError
            ? error
            : new CapabilityError(
                "execution_failed",
                error instanceof Error ? error.message : String(error),
              );
          return {
            content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
            structuredContent: {
              name,
              action,
              error: { code: capabilityError.code, message: capabilityError.message },
            },
            isError: true as const,
          };
        }
      }

      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(
        target,
        extra._meta,
        extra.signal,
        extra.sessionId,
      );
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        const response = await remoteWorkspaces.capability(executionWorkspaceId, {
          name,
          action,
          ...(capabilityArguments !== undefined ? { arguments: capabilityArguments } : {}),
          ...(file !== undefined ? { file } : {}),
        }, hostScopeIdFor(extra._meta, extra.sessionId));
        return action === "run" && name !== "workspace.tasks"
          ? presentSemanticWorkResult(response, target)
          : presentExecutionResult(response, target);
      }
      if (action === "run" && name === "batch.execute") {
        const workspace = workspaces.getWorkspace(executionWorkspaceId);
        const startedAt = performance.now();
        try {
          const execution = await capabilityRegistry.run(
            name,
            capabilityArguments ?? {},
            capabilityContextFor(workspace),
            {
              nativeFile: file,
              signal: extra.signal,
              requestMeta: extra._meta,
              sessionId: extra.sessionId,
            },
          );
          const result = {
            content: [textBlock(`Capability ${name} completed.\n${JSON.stringify(execution.value, null, 2)}`)],
            structuredContent: { name, action, result: execution.value },
          };
          logToolCall(config, {
            tool: toolNames.capability,
            ...workspaceLogContext(workspace, extra.sessionId),
            capability: name,
            action,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return presentSemanticWorkResult(result, target);
        } catch (error) {
          if (extra.signal.aborted) throw error;
          const capabilityError = error instanceof CapabilityError
            ? error
            : new CapabilityError(
                "execution_failed",
                error instanceof Error ? error.message : String(error),
              );
          const result = {
            content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
            structuredContent: {
              name,
              action,
              error: { code: capabilityError.code, message: capabilityError.message },
            },
            isError: true as const,
          };
          logFailedToolResponse(config, {
            tool: toolNames.capability,
            ...workspaceLogContext(workspace, extra.sessionId),
            capability: name,
            action,
          }, result.content, startedAt);
          return presentExecutionResult(result, target);
        }
      }

      if (action === "run") {
        const response = await coreOperations.capabilityRun(
          { workspaceId: executionWorkspaceId, name, arguments: capabilityArguments, file },
          executionContext,
        );
        return name === "workspace.tasks"
          ? presentExecutionResult(response, target)
          : presentSemanticWorkResult(response, target);
      }

      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      return runActivityToolWithHooks(
        activityLifecycle,
        hooks,
        workspace,
        hostScopeIdFor(extra._meta, extra.sessionId),
        activityRequestFor(
          { workspaceId: executionWorkspaceId, name, action, arguments: capabilityArguments, file },
          executionContext,
        ),
        {
          signal: extra.signal,
          tool: toolNames.capability,
          invocation: workspaceHookInvocation(workspace),
          payload: { name, action },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            try {
              const capability = capabilityRegistry.describe(name, capabilityContextFor(workspace));
              const result = {
                content: [textBlock([
                  `${capability.name}: ${capability.description}`,
                  `Available: ${capability.available}`,
                  `Guide: ${capability.guide.path}`,
                  capability.guide.readBeforeFirstUse
                    ? "Read the guide before first use when this contract is unfamiliar."
                    : undefined,
                ].filter(Boolean).join("\n"))],
                structuredContent: { name, action, capability },
              };
              logToolCall(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace),
                capability: name,
                action,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });
              return result;
            } catch (error) {
              const capabilityError = error instanceof CapabilityError
                ? error
                : new CapabilityError(
                    "execution_failed",
                    error instanceof Error ? error.message : String(error),
                  );
              const result = {
                content: [textBlock(`${capabilityError.code}: ${capabilityError.message}`)],
                structuredContent: {
                  name,
                  action,
                  error: { code: capabilityError.code, message: capabilityError.message },
                },
                isError: true as const,
              };
              logFailedToolResponse(config, {
                tool: toolNames.capability,
                ...workspaceLogContext(workspace),
                capability: name,
                action,
              }, result.content, startedAt);
              return result;
            }
          },
        },
        activityRelationFor(executionContext),
      ).then((result) => presentExecutionResult(result, target));
    },
  );

  registerAppTool(
    server,
    toolNames.closeWorkspace,
    {
      title: "Close workspace",
      description:
        "Close or explicitly delete one Workspace after the user chooses cleanup. action=close (default) preserves checkout, managed-worktree, Composite, and relayed identity for later reopen. action=delete permanently removes ForgeRelay-owned state. Managed-worktree-backed Workspaces still finalize safely when active and require commitMessage. Composite delete dissolves only Composite-owned state and never closes member Workspaces. Checkout project files are never deleted.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier to close or delete."),
        action: z
          .enum(["close", "delete"])
          .optional()
          .describe("Defaults to close. close preserves checkout identity, managed-worktree identity, and Composite identity for later reopen; delete removes ForgeRelay-owned state. Composite delete dissolves only the Composite relationship. Active managed worktrees still require safe finalization and commitMessage; checkout project files are never deleted."),
        commitMessage: z
          .string()
          .min(1)
          .optional()
          .describe("Required only for a managed-worktree-backed workspace; concise Git commit message for remaining worktree changes."),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        action: z.enum(["close", "delete"]).optional(),
        kind: z.enum(["workspace", "composite"]).optional(),
        mode: z.enum(["checkout", "worktree"]).optional(),
        name: z.string().optional(),
        members: z.array(z.object({
          name: z.string(),
          purpose: z.string(),
          workspaceId: z.string(),
        })).optional(),
        status: z.enum(["active", "closed"]).optional(),
        dissolved: z.boolean().optional(),
        sourceRoot: z.string().optional(),
        branch: z.string().optional(),
        targetBranch: z.string().optional(),
        commitSha: z.string().optional(),
        mergedSha: z.string().optional(),
        committed: z.boolean().optional(),
        cleanupWarning: z.string().optional(),
      }),
      _meta: {},
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, action = "close", commitMessage }, extra) => {
      if (compositeWorkspaces.has(workspaceId)) {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not valid for a Composite Workspace.");
        }
        const composite = action === "delete"
          ? compositeWorkspaces.dissolve(workspaceId)
          : compositeWorkspaces.close(workspaceId);
        if (action === "delete") {
          workspaceTasks.deleteWorkspace(workspaceId);
          taskReminders.forget(workspaceId);
        }
        compositeActivity.forgetComposite(workspaceId);
        workspacePanelStates.delete(workspaceId);
        const result = [
          action === "delete"
            ? `Deleted Composite Workspace ${composite.name} (${workspaceId}); its Composite relationship and ForgeRelay-owned Composite state were dissolved.`
            : `Closed Composite Workspace ${composite.name} (${workspaceId}); its identity and member topology were preserved for later reopen.`,
          composite.members.length > 0
            ? `Preserved member Workspaces: ${composite.members.map((member) => `${member.name} [${member.workspaceId}]`).join(", ")}.`
            : "The Composite Workspace had no members.",
          "Member Workspace handles, managed worktrees, processes, files, and Workspace Relay routes were not closed, finalized, deleted, or otherwise mutated.",
        ].join("\n");
        return {
          content: [textBlock(result)],
          _meta: {
            tool: toolNames.closeWorkspace,
            card: {
              workspaceId,
              action,
              kind: "composite" as const,
              name: composite.name,
              members: composite.members,
              ...(action === "close" ? { status: "closed" as const } : {}),
              dissolved: action === "delete",
              payload: { content: [textBlock(result)] },
            },
          },
          structuredContent: {
            result,
            workspaceId,
            action,
            kind: "composite" as const,
            name: composite.name,
            members: composite.members,
            ...(action === "close" ? { status: "closed" as const } : {}),
            dissolved: action === "delete",
          },
        };
      }
      if (remoteWorkspaces.has(workspaceId)) {
        const response = await remoteWorkspaces.closeWorkspace(
          workspaceId,
          { action, ...(commitMessage !== undefined ? { commitMessage } : {}) },
          hostScopeIdFor(extra._meta, extra.sessionId),
        );
        workspacePanelStates.delete(workspaceId);
        return response;
      }
      const session = workspaces.getWorkspaceSession(workspaceId);
      if (action === "delete" && session.mode === "checkout") {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not valid with action=delete for a checkout Workspace.");
        }
        if (processSessions.activeWorkspaceIds().has(session.id)) {
          throw new Error(
            `Workspace ${session.id} still owns a running process. Poll, interrupt, or wait for it before deleting this Workspace.`,
          );
        }
        const response = await runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.closeWorkspace,
          invocation: {
            workspaceId: session.id,
            workspaceRoot: session.root,
            workspaceMode: session.mode,
            sourceRoot: session.sourceRoot,
          },
          payload: { workspaceId: session.id, action: "delete", mode: session.mode },
          operation: async () => {
            workspaces.deleteWorkspace(session.id);
            workspaceTasks.deleteWorkspace(session.id);
            taskReminders.forget(session.id);
            await reviewCheckpoints.releaseWorkspace(session.id);
            const result = `Deleted ForgeRelay Workspace ${session.id}. Physical project files were not removed.`;
            return {
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: session.id,
                  action: "delete" as const,
                  mode: "checkout",
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: session.id,
                action: "delete" as const,
                mode: "checkout" as const,
              },
            };
          },
        });
        workspacePanelStates.delete(session.id);
        return response;
      }
      if (action === "delete" && session.mode === "worktree" && session.status === "closed") {
        if (commitMessage !== undefined) {
          throw new Error("close_workspace commitMessage is not needed when deleting an already-closed managed-worktree Workspace.");
        }
        const hookRoot = session.sourceRoot ?? session.root;
        const response = await runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.closeWorkspace,
          invocation: {
            workspaceId: session.id,
            workspaceRoot: hookRoot,
            workspaceMode: session.mode,
            sourceRoot: session.sourceRoot,
          },
          payload: { workspaceId: session.id, action: "delete", mode: session.mode },
          operation: async () => {
            workspaces.deleteWorkspace(session.id);
            workspaceTasks.deleteWorkspace(session.id);
            taskReminders.forget(session.id);
            await reviewCheckpoints.releaseWorkspace(session.id);
            const result = `Deleted closed managed-worktree Workspace ${session.id}. Its already-removed worktree backing was not recreated.`;
            return {
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: session.id,
                  action: "delete" as const,
                  mode: "worktree",
                  sourceRoot: session.sourceRoot,
                  targetBranch: session.targetBranch,
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: session.id,
                action: "delete" as const,
                mode: "worktree" as const,
                sourceRoot: session.sourceRoot,
                targetBranch: session.targetBranch,
              },
            };
          },
        });
        workspacePanelStates.delete(session.id);
        return response;
      }
      const workspace = workspaces.getWorkspace(session.id);
      const response = await runToolWithHooks(hooks, {
        signal: extra.signal,
        tool: toolNames.closeWorkspace,
        invocation: workspaceHookInvocation(workspace),
        payload: { workspaceId: workspace.id, action, commitMessage, mode: workspace.mode },
        afterCwd: (response) =>
          "sourceRoot" in response.structuredContent &&
          typeof response.structuredContent.sourceRoot === "string"
            ? response.structuredContent.sourceRoot
            : undefined,
        operation: async () => {
          if (workspace.mode === "worktree") {
            if (!commitMessage) {
              throw new Error(
                `Managed-worktree-backed Workspace ${workspace.id} requires commitMessage when ${action === "delete" ? "deleting active work" : "closing"}.`,
              );
            }
            const physicalWorkspaceIds = workspaces.workspaceIdsForPhysicalWorkspace(workspace);
            const busyWorkspaceIds = physicalWorkspaceIds
              .filter((id) => processSessions.activeWorkspaceIds().has(id));
            if (busyWorkspaceIds.length > 0) {
              throw new Error(
                `Cannot close this worktree-backed Workspace while Workspace processes are still running: ${busyWorkspaceIds.join(", ")}.`,
              );
            }
            const startedAt = performance.now();
            const retirement = await codeIntelligence.retireWorkspaceRoot(workspace.root);
            let closed: Awaited<ReturnType<WorkspaceRegistry["closeWorktree"]>>;
            try {
              closed = await workspaces.closeWorktree(workspace.id, commitMessage);
            } finally {
              codeIntelligence.restoreWorkspaceRoot(retirement.root);
            }
            await Promise.all(
              physicalWorkspaceIds.map((id) => reviewCheckpoints.releaseWorkspace(id)),
            );
            if (action === "delete") {
              workspaces.deleteWorkspace(workspace.id);
              workspaceTasks.deleteWorkspace(workspace.id);
              taskReminders.forget(workspace.id);
            }
            const result = [
              action === "delete"
                ? `Safely finalized and deleted managed-worktree Workspace ${workspace.id}.`
                : `Closed managed-worktree-backed Workspace ${workspace.id}; its identity was preserved for later reopen.`,
              `Merged ${closed.branch} into ${closed.targetBranch} by fast-forward.`,
              `Source checkout: ${closed.sourceRoot}`,
              `Commit: ${closed.commitSha}`,
              closed.cleanupWarning
                ? `Cleanup warning: ${closed.cleanupWarning}`
                : "The managed worktree directory and branch were removed.",
            ].join("\n");
            logToolCall(config, {
              tool: toolNames.closeWorkspace,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: closed.sourceRoot,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });
            return attachHookReports({
              content: [textBlock(result)],
              _meta: {
                tool: toolNames.closeWorkspace,
                card: {
                  workspaceId: workspace.id,
                  action,
                  mode: "worktree",
                  sourceRoot: closed.sourceRoot,
                  branch: closed.branch,
                  targetBranch: closed.targetBranch,
                  commitSha: closed.commitSha,
                  mergedSha: closed.mergedSha,
                  committed: closed.committed,
                  cleanupWarning: closed.cleanupWarning,
                  payload: { content: [textBlock(result)] },
                },
              },
              structuredContent: {
                result,
                workspaceId: workspace.id,
                action,
                mode: "worktree" as const,
                sourceRoot: closed.sourceRoot,
                branch: closed.branch,
                targetBranch: closed.targetBranch,
                commitSha: closed.commitSha,
                mergedSha: closed.mergedSha,
                committed: closed.committed,
                cleanupWarning: closed.cleanupWarning,
              },
            }, closed.hookReports);
          }

          if (commitMessage !== undefined) {
            throw new Error("close_workspace commitMessage is only valid for managed-worktree-backed workspaces.");
          }
          const checkoutWorkspaceId = workspace.id;
          if (processSessions.activeWorkspaceIds().has(checkoutWorkspaceId)) {
            throw new Error(
              `Workspace ${checkoutWorkspaceId} still owns a running process. Poll, interrupt, or wait for it before closing this workspace.`,
            );
          }
          workspaces.closeWorkspace(checkoutWorkspaceId);
          await reviewCheckpoints.releaseWorkspace(checkoutWorkspaceId);
          const result = `Closed checkout-backed Workspace ${checkoutWorkspaceId}; its ForgeRelay identity was preserved for later reopen. Physical project files were not removed.`;
          return {
            content: [textBlock(result)],
            _meta: {
              tool: toolNames.closeWorkspace,
              card: {
                workspaceId: checkoutWorkspaceId,
                action: "close" as const,
                mode: "checkout",
                payload: { content: [textBlock(result)] },
              },
            },
            structuredContent: {
              result,
              workspaceId: checkoutWorkspaceId,
              action: "close" as const,
              mode: "checkout" as const,
            },
          };
        },
      });
      workspacePanelStates.delete(workspace.id);
      return response;
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: toolDescriptions.read,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z
          .string()
          .optional()
          .describe("Required for Composite member-scoped file reads. Omit only when reading an advertised Composite-owned capability guide."),
        path: z
          .string()
          .optional()
          .describe(
            config.skillsEnabled
              ? "One file path to read, relative to the workspace root or absolute inside the OS temp directory. Load an available skill with skills://<name>; after loading it, read files in that skill with skills://<name>/<relative-path>. Advertised capability-guide paths from open_workspace are also readable. Use exactly one of path or paths."
              : "One file path to read, relative to the workspace root or absolute inside the OS temp directory. May also be an advertised capability-guide path from open_workspace. Use exactly one of path or paths.",
          ),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple file paths to read in one call. Uses the same offset/limit for every file. Use exactly one of path or paths."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema({
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error"]),
          result: z.string(),
        })).optional(),
        files: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, member, path, paths, offset, limit }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("read requires exactly one of path or paths.");
      }
      if (compositeWorkspaces.has(workspaceId) && member === undefined && path !== undefined) {
        const guide = compositeTaskGuides.find(
          (candidate) => formatPathForPrompt(candidate.filePath) === path || candidate.filePath === path,
        );
        if (guide) {
          if (!compositeWorkspaces.isActive(workspaceId)) {
            throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before use.`);
          }
          const startedAt = performance.now();
          const raw = readFileSync(guide.filePath, "utf8");
          const start = (offset ?? 1) - 1;
          const end = limit === undefined ? undefined : start + limit;
          const result = raw.split("\n").slice(start, end).join("\n");
          logToolCall(config, {
            tool: toolNames.read,
            path: formatPathForPrompt(guide.filePath),
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            structuredContent: { result },
          };
        }
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.read(
          executionWorkspaceId,
          { path, paths, offset, limit },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.read(
          { workspaceId: executionWorkspaceId, path, offset, limit },
          executionContext,
        ), target);
      }

      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      let response: {
        content: ToolContent[];
        structuredContent: {
          result: string;
          results: Array<{ path: string; status: "done" | "error"; result: string }>;
          files: number;
          failed: number;
          agentsFiles?: Array<{ path: string; content: string }>;
        };
      } | undefined;
      await runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(extra._meta, extra.sessionId),
        toolNames.read,
        activityRequestFor({ workspaceId: executionWorkspaceId, paths, offset, limit }, executionContext),
        async (parentContext) => {
          const execution = await executeBulkRead({
            paths: paths!,
            signal: extra.signal,
            run: (childPath) => coreOperations.read(
              { workspaceId: executionWorkspaceId, path: childPath, offset, limit },
              {
                ...executionContext,
                parentActivityId: parentContext.activityId,
                turnId: parentContext.turnId,
              },
            ),
            isError: toolResultIsError,
            resultText: toolResultText,
          });
          const content = execution.children.flatMap((child): ToolContent[] => [
            textBlock(`--- ${child.path} · ${child.status} ---`),
            ...(child.response
              ? toolResultContent(child.response)
              : [textBlock(child.result)]),
          ]);
          const seenAgentPaths = new Set<string>();
          const agentsFiles = execution.children.flatMap((child) =>
            child.response ? toolResultAgentsFiles(child.response) : []
          ).filter((file) => {
            if (seenAgentPaths.has(file.path)) return false;
            seenAgentPaths.add(file.path);
            return true;
          });
          response = {
            content,
            structuredContent: {
              result: contentText(content),
              results: execution.children.map(({ path: childPath, status, result }) => ({
                path: childPath,
                status,
                result,
              })),
              files: execution.children.length,
              failed: execution.failed,
              ...(agentsFiles.length > 0 ? { agentsFiles } : {}),
            },
          };
          return {
            childCount: execution.children.length,
            succeeded: execution.succeeded,
            failed: execution.failed,
          };
        },
        (summary) => summary.failed > 0
          ? { type: "failed", error: `${summary.failed} of ${summary.childCount} child Reads failed.` }
          : { type: "succeeded" },
        activityRelationFor(executionContext),
      );
      if (!response) throw new Error("Bulk Read completed without a response.");
      return presentSemanticWorkResult(response, target);
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description: toolDescriptions.write,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root or absolute inside the OS temp directory."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, ...input }, extra) => {
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.write(
          executionWorkspaceId,
          input,
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      return presentSemanticWorkResult(await coreOperations.write(
        { workspaceId: executionWorkspaceId, ...input },
        executionContext,
      ), target);
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description: toolDescriptions.edit,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z
          .string()
          .optional()
          .describe("One file path to edit. Use exactly one of path or paths."),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple file paths to edit with the same edits. Use exactly one of path or paths."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["applied", "partial"]),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error", "unexecuted"]),
          result: z.string().optional(),
        })).optional(),
        files: z.number().int().nonnegative().optional(),
        completed: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        unexecuted: z.number().int().nonnegative().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, paths, edits }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("edit requires exactly one of path or paths.");
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.edit(
          executionWorkspaceId,
          { path, paths, edits },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.edit(
          { workspaceId: executionWorkspaceId, path, edits },
          executionContext,
        ), target);
      }

      return presentSemanticWorkResult(await nativeBulkMutations.edit(
        { workspaceId: executionWorkspaceId, paths: paths!, edits },
        executionContext,
      ), target);
    },
  );
  }

  registerAppTool(
    server,
    toolNames.rename,
    {
      title: "Rename path",
      description: toolDescriptions.rename,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z.string().describe("Source file or directory path relative to the workspace root, or absolute inside the OS temp directory."),
        newPath: z.string().describe("Destination path relative to the workspace root, or absolute inside the OS temp directory. The destination must not already exist."),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("renamed"),
        path: z.string(),
        newPath: z.string(),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, newPath }, extra) => {
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.rename(
          executionWorkspaceId,
          { path, newPath },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      return presentSemanticWorkResult(await coreOperations.rename(
        { workspaceId: executionWorkspaceId, path, newPath },
        executionContext,
      ), target);
    },
  );

  registerAppTool(
    server,
    toolNames.delete,
    {
      title: "Delete path",
      description: toolDescriptions.delete,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z.string().optional().describe("One file or directory path to delete. Use exactly one of path or paths."),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple paths to delete in one call. Use exactly one of path or paths."),
        recursive: z.boolean().optional().describe("Delete non-empty directory trees. Defaults to false and applies to every bulk target."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["deleted", "partial"]),
        path: z.string().optional(),
        recursive: z.boolean().optional(),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error", "unexecuted"]),
          result: z.string().optional(),
        })).optional(),
        paths: z.number().int().nonnegative().optional(),
        completed: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        unexecuted: z.number().int().nonnegative().optional(),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, paths, recursive }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("delete requires exactly one of path or paths.");
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.delete(
          executionWorkspaceId,
          { path, paths, recursive },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.delete(
          { workspaceId: executionWorkspaceId, path, recursive },
          executionContext,
        ), target);
      }

      return presentSemanticWorkResult(await nativeBulkMutations.delete(
        { workspaceId: executionWorkspaceId, paths: paths!, recursive },
        executionContext,
      ), target);
    },
  );

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description: toolDescriptions.applyPatch,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this patch."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, member, patch }, extra) => {
        const target = resolveExecutionTarget(workspaceId, member);
        const executionWorkspaceId = target.executionWorkspaceId;
        const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
        if (remoteWorkspaces.has(executionWorkspaceId)) {
          return presentSemanticWorkResult(await remoteWorkspaces.applyPatch(
            executionWorkspaceId,
            { patch },
            hostScopeIdFor(extra._meta, extra.sessionId),
          ), target);
        }
        const workspace = workspaces.getWorkspace(executionWorkspaceId);
        return runActivityToolWithHooks(
          activityLifecycle,
          hooks,
          workspace,
          hostScopeIdFor(extra._meta, extra.sessionId),
          activityRequestFor({ workspaceId: executionWorkspaceId, patch }, executionContext),
          {
            signal: extra.signal,
          tool: "apply_patch",
          invocation: workspaceHookInvocation(workspace),
          payload: { patchBytes: Buffer.byteLength(patch) },
          changedPaths: (response) => Array.from(new Set(
            response.structuredContent.files.flatMap((file) => [file.previousPath, file.path])
              .filter((path): path is string => Boolean(path)),
          )),
          operation: async () => {
            const startedAt = performance.now();
            const applied = await applyPatch(workspace.root, patch, [tmpdir()]);
            const paths = applied.files.map((file) => file.path).join(", ");
            const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
            const content = [textBlock(result)];
            const displayPath = applied.files.length === 1
              ? applied.files[0]?.path
              : `${applied.files.length} files`;

            logToolCall(config, {
              tool: "apply_patch",
              ...workspaceLogContext(workspace, extra.sessionId),
              path: displayPath,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              content,
              _meta: {
                tool: "apply_patch",
                card: {
                  workspaceId: executionWorkspaceId,
                  path: displayPath,
                  summary: {
                    files: applied.files.length,
                    additions: applied.additions,
                    removals: applied.removals,
                  },
                  files: applied.files,
                  payload: { patch: applied.patch },
                },
              },
              structuredContent: {
                result,
                additions: applied.additions,
                removals: applied.removals,
                files: applied.files,
              },
            };
          },
        },
        activityRelationFor(executionContext),
        ).then((result) => presentSemanticWorkResult(result, target));
      },
    );
  }

  if (config.toolMode !== "codex") {
    registerAppTool(
      server,
      toolNames.shell,
      {
        title: "Bash",
        description: toolDescriptions.shell,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this process operation."),
          action: z
            .enum(["run", "process", "output"])
            .optional()
            .describe("Defaults to run. Use process with a returned processId to poll/interact, or output with outputId to retrieve complete durable output."),
          command: z
            .string()
            .optional()
            .describe(`${toolDescriptions.shellCommand} Required for action=run.`),
          processId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Process identifier returned by a previous bash action=run call. Required for action=process."),
          outputId: z
            .string()
            .optional()
            .describe("Stable output identifier returned by a Bash run. Required for action=output."),
          input: z
            .string()
            .optional()
            .describe("Characters to write for action=process. Omit to poll/wait without input."),
          interrupt: z
            .boolean()
            .optional()
            .describe("For action=process, send SIGINT to the process. Cannot be combined with input."),
          tty: z
            .boolean()
            .optional()
            .describe("For action=run, allocate a pseudo-terminal for interactive commands. Defaults to false."),
          columns: z
            .number()
            .int()
            .min(1)
            .max(1_000)
            .optional()
            .describe("Initial PTY width for action=run, or resize width for action=process."),
          rows: z
            .number()
            .int()
            .min(1)
            .max(1_000)
            .optional()
            .describe("Initial PTY height for action=run, or resize height for action=process."),
          workingDirectory: z
            .string()
            .optional()
            .describe("For action=run, working directory relative to the workspace root. Defaults to the workspace root."),
          yieldTimeMs: z
            .number()
            .int()
            .min(0)
            .max(300_000)
            .optional()
            .describe("Feedback window before returning. For action=run, use 0 for immediate background handoff; otherwise defaults to 10000ms. For action=process, polling defaults to 5000ms and interaction to 250ms."),
          timeoutMs: z
            .number()
            .int()
            .min(1)
            .max(86_400_000)
            .optional()
            .describe("For action=run, total execution timeout from process start. On expiry ForgeRelay terminates the process. Omit for no ForgeRelay execution deadline."),
          maxOutputTokens: z
            .number()
            .int()
            .positive()
            .max(100_000)
            .optional()
            .describe("Approximate output token budget. Defaults to 10000."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
      },
      async ({
        workspaceId,
        member,
        action = "run",
        command,
        processId,
        outputId,
        input,
        interrupt,
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        timeoutMs,
        maxOutputTokens,
      }, extra) => {
        const target = resolveExecutionTarget(workspaceId, member);
        const executionWorkspaceId = target.executionWorkspaceId;
        const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
        if (remoteWorkspaces.has(executionWorkspaceId)) {
          const response = await remoteWorkspaces.bash(executionWorkspaceId, {
            action,
            ...(command !== undefined ? { command } : {}),
            ...(processId !== undefined ? { processId } : {}),
            ...(outputId !== undefined ? { outputId } : {}),
            ...(input !== undefined ? { input } : {}),
            ...(interrupt !== undefined ? { interrupt } : {}),
            ...(tty !== undefined ? { tty } : {}),
            ...(columns !== undefined ? { columns } : {}),
            ...(rows !== undefined ? { rows } : {}),
            ...(workingDirectory !== undefined ? { workingDirectory } : {}),
            ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          }, hostScopeIdFor(extra._meta, extra.sessionId));
          return action === "run"
            ? presentSemanticWorkResult(response, target)
            : presentExecutionResult(response, target);
        }
        const workspace = workspaces.getWorkspace(executionWorkspaceId);
        if (action === "run") {
          if (!command) throw new Error("bash action=run requires command.");
          if (processId !== undefined || outputId !== undefined || input !== undefined || interrupt !== undefined) {
            throw new Error("bash action=run does not accept processId, outputId, input, or interrupt.");
          }
          return presentSemanticWorkResult(await coreOperations.shellRun(
            {
              workspaceId: executionWorkspaceId,
              command,
              surface: "bash",
              tty,
              columns,
              rows,
              workingDirectory,
              yieldTimeMs,
              timeoutMs,
              maxOutputTokens,
            },
            executionContext,
          ), target);
        }

        if (action === "output") {
          if (!outputId) throw new Error("bash action=output requires outputId.");
          if (
            command !== undefined || processId !== undefined || input !== undefined || interrupt !== undefined ||
            tty !== undefined || columns !== undefined || rows !== undefined || workingDirectory !== undefined ||
            yieldTimeMs !== undefined || timeoutMs !== undefined || maxOutputTokens !== undefined
          ) {
            throw new Error("bash action=output accepts only workspaceId and outputId.");
          }
          return runToolWithHooks(hooks, {
            signal: extra.signal,
            tool: toolNames.shell,
            invocation: workspaceHookInvocation(workspace),
            payload: { action, outputId },
            operation: async () => durableOutputResponse(
              toolNames.shell,
              executionWorkspaceId,
              readWorkspaceBashOutput(bashOutputStore, executionWorkspaceId, outputId),
            ),
          }).then((result) => presentExecutionResult(result, target));
        }

        if (outputId !== undefined) throw new Error("bash action=process does not accept outputId.");
        if (command !== undefined || workingDirectory !== undefined || tty !== undefined || timeoutMs !== undefined) {
          throw new Error("bash action=process does not accept command, workingDirectory, tty, or timeoutMs.");
        }
        if (processId === undefined) throw new Error("bash action=process requires processId.");
        if (interrupt && input !== undefined) {
          throw new Error("bash action=process cannot combine interrupt with input.");
        }
        return runToolWithHooks(hooks, {
          signal: extra.signal,
          tool: toolNames.shell,
          invocation: workspaceHookInvocation(workspace),
          payload: {
            action,
            processId,
            inputLength: input?.length ?? 0,
            interrupt: interrupt ?? false,
            columns,
            rows,
          },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const snapshot = await processSessions.write({
              workspaceId: executionWorkspaceId,
              processId,
              chars: interrupt ? "\u0003" : input,
              columns,
              rows,
              yieldTimeMs,
              maxOutputTokens,
              signal: extra.signal,
            });
            logToolCall(config, {
              tool: toolNames.shell,
              ...workspaceLogContext(workspace, extra.sessionId),
              exitCode: snapshot.exitCode,
              running: snapshot.running,
              processId: snapshot.processId,
              success: snapshot.running || snapshot.exitCode === 0,
              durationMs: Math.round(performance.now() - startedAt),
            });
            const response = processToolResponse(toolNames.shell, executionWorkspaceId, snapshot, {
              action,
              processId,
              inputLength: input?.length ?? 0,
              interrupt: interrupt ?? false,
              running: snapshot.running,
              exitCode: snapshot.exitCode,
              wallTimeMs: snapshot.wallTimeMs,
            });
            if (!snapshot.running) {
              recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId);
            }
            return presentExecutionResult(response, target);
          },
        });
      },
    );
  }

  registerProcessTools(
    server,
    config,
    workspaces,
    processSessions,
    hooks,
    activityLifecycle,
    bashOutputStore,
    (input, context) => coreOperations.shellRun(input, context),
    {
      resolve: resolveExecutionTarget,
      prepare: prepareExecutionContext,
      present: presentExecutionResult,
      presentSemantic: presentSemanticWorkResult,
      isRemote: (workspaceId) => remoteWorkspaces.has(workspaceId),
      execCommandRemote: (workspaceId, input, conversationScopeId) =>
        remoteWorkspaces.execCommand(workspaceId, input, conversationScopeId),
      writeStdinRemote: (workspaceId, input, conversationScopeId) =>
        remoteWorkspaces.writeStdin(workspaceId, input, conversationScopeId),
      hostScopeIdFor,
    },
  );

  if (ownsRemoteWorkspaces) {
    const closeServer = server.close.bind(server);
    let closePromise: Promise<void> | undefined;
    server.close = () => {
      closePromise ??= (async () => {
        try {
          await closeServer();
        } finally {
          await remoteWorkspaces.shutdown();
        }
      })();
      return closePromise;
    };
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpTransportRegistry<Transport>({
    maxTransports: MAX_MCP_TRANSPORT_SESSIONS,
  });
  const mcpUrl = publicEndpointUrl(config.publicBaseUrl, "mcp");
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const sharedRemoteWorkspaces = new RemoteWorkspaceRelay(config.configDir, config.stateDir);
  const sharedCompositeWorkspaces = new CompositeWorkspaceRegistry(config.stateDir);
  const sharedWorkspaceTasks = new WorkspaceTaskStore(config.stateDir);
  const sharedTaskReminders = new WorkspaceTaskReminderTracker(
    config.taskReminderInterval,
    sharedWorkspaceTasks,
  );
  const activityAuditStore = new ActivityAuditStore(config.stateDir);
  const bashOutputStore = new BashOutputStore(config.stateDir);
  const hostTurnStore = new HostTurnStore(config.stateDir);
  const activityQueries = new ActivityQueryService(hostTurnStore, activityAuditStore, bashOutputStore);
  const activityLifecycle = new ActivityLifecycle(activityAuditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      activityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessManager({ outputAudit: bashOutputStore });
  const codeIntelligence = new CodeIntelligenceManager(config);
  const subagentProviders = config.subagents
    ? getSubagentProviderAvailabilitySnapshot()
    : [];

  const logTransportCloseResults = (
    reason: "idle_timeout" | "capacity_limit" | "server_shutdown",
    results: McpTransportCloseResult[],
  ) => {
    let closedCount = 0;

    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_transport_session_close_failed", {
          reason,
          transportSessionIdPrefix: transportSessionIdPrefix(result.transportSessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      closedCount += 1;
      if (reason !== "server_shutdown") {
        logEvent(config.logging, "debug", "mcp_transport_session_closed", {
          reason,
          transportSessionIdPrefix: transportSessionIdPrefix(result.transportSessionId),
        });
      }
    }

    if (reason === "server_shutdown" && closedCount > 0) {
      logEvent(config.logging, "debug", "mcp_transport_sessions_closed", {
        reason,
        count: closedCount,
      });
    }
  };

  const logRuntimeResources = (): void => {
    const memory = process.memoryUsage();
    const processStats = processSessions.stats();
    const codeStats = codeIntelligence.stats();
    logEvent(config.logging, "debug", "runtime_resources", {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      mcpTransports: transports.size,
      processesTotal: processStats.total,
      processesRunning: processStats.running,
      processesCompleted: processStats.completed,
      cachedWorkspaces: workspaces.cachedWorkspaceCount,
      reviewStates: reviewCheckpoints.stateCount,
      languageServices: codeStats.servicesTotal,
      languageServicesActive: codeStats.servicesActive,
      languageProcessesRunning: codeStats.processesRunning,
      languageOperationsInFlight: codeStats.operationsInFlight,
      languageRequestsActive: codeStats.semanticRequestsActive,
      languageRequestsQueued: codeStats.semanticRequestsQueued,
      languageOpenDocuments: codeStats.openDocuments,
      languageDiagnosticSnapshots: codeStats.diagnosticSnapshots,
      languageDiagnosticsRetained: codeStats.diagnosticsRetained,
      languageStderrBytes: codeStats.stderrBytes,
      languagePendingCreations: codeStats.pendingCreations,
      languageCrashCooldowns: codeStats.crashCooldowns,
      languageInvalidatedServices: codeStats.invalidatedServices,
      languageRetiredWorkspaceRoots: codeStats.retiredWorkspaceRoots,
    });
  };
  const transportCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_TRANSPORT_IDLE_TIMEOUT_MS)
      .then((results) => logTransportCloseResults("idle_timeout", results))
      .finally(logRuntimeResources);
  }, MCP_TRANSPORT_CLEANUP_INTERVAL_MS);
  transportCleanupTimer.unref();
  logRuntimeResources();

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(
    createForgeRelayAuthRouter({
      provider: oauthProvider,
      cliAuthenticationProvider: oauthProvider,
      instanceId: config.instanceId,
      issuerUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "ForgeRelay",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "forgerelay" });
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const transportSessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      httpMethod: req.method,
      transportSessionIdPresent: Boolean(transportSessionId),
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
      isInitialize: initializeRequest,
      ...mcpRequestDebugFields(req.body),
    });

    try {
      let transport: Transport | undefined;

      if (transportSessionId) {
        transport = transports.get(transportSessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP transport session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newTransportSessionId) => {
            if (transport) {
              void transports
                .register(newTransportSessionId, transport)
                .then((results) => logTransportCloseResults("capacity_limit", results));
            }
            logEvent(config.logging, "debug", "mcp_transport_session_created", {
              requestId,
              transportSessionIdPrefix: transportSessionIdPrefix(newTransportSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedTransportSessionId = transport?.sessionId;
          if (closedTransportSessionId && transports.remove(closedTransportSessionId)) {
            logEvent(config.logging, "debug", "mcp_transport_session_closed", {
              reason: "transport_close",
              transportSessionIdPrefix: transportSessionIdPrefix(closedTransportSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          subagentProviders,
          incomingArtifactAdapters,
          codeIntelligence,
          activityLifecycle,
          bashOutputStore,
          activityQueries,
          {
            taskReminders: sharedTaskReminders,
            remoteWorkspaces: sharedRemoteWorkspaces,
            compositeWorkspaces: sharedCompositeWorkspaces,
          },
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP transport session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    subagentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(transportCleanupTimer);
        const results = await transports.closeAll();
        logTransportCloseResults("server_shutdown", results);
        await sharedRemoteWorkspaces.shutdown();
        processSessions.shutdown();
        await codeIntelligence.shutdown();
        oauthProvider.close();
        hostTurnStore.close();
        bashOutputStore.close();
        activityAuditStore.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, subagentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `forgerelay listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatSubagentProviderAvailabilitySummary(subagentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("forgerelay shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
