import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
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
import { buildCapabilityFingerprint } from "./capabilities.js";
import {
  CapabilityError,
  createCapabilityRegistry,
  type CapabilityContext,
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
import { attachHookReports, HookRunner, runToolWithHooks } from "./hooks.js";
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
import { openAiConversationScopeId } from "./request-meta.js";
import {
  readWorkspaceAppManifestEntry,
  resolveWorkspaceAppIdentity,
  WORKSPACE_APP_LEGACY_URI,
  WORKSPACE_APP_URI_TEMPLATE,
  type WorkspaceAppManifestEntry,
} from "./mcp-app-template.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry, type Workspace } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

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
  localAgentProviders: LocalAgentProviderAvailability[];
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
  "openai/outputTemplate": string;
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "capability";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  const resourceUri = currentWorkspaceAppIdentity().uri;
  return {
    _meta: {
      ui: {
        resourceUri,
        visibility: ["model", "app"],
      },
      "openai/outputTemplate": resourceUri,
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

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
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
  path: z.string(),
});

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

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
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
  let rpcTarget: string | undefined;
  if (rpcMethod === "resources/read" && typeof params?.uri === "string") {
    rpcTarget = params.uri;
  } else if (rpcMethod === "tools/call" && typeof params?.name === "string") {
    rpcTarget = params.name;
  }

  return { rpcMethod, rpcTarget };
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

let cachedWorkspaceAppIdentity: ReturnType<typeof resolveWorkspaceAppIdentity> | undefined;

function currentWorkspaceAppIdentity(): ReturnType<typeof resolveWorkspaceAppIdentity> {
  cachedWorkspaceAppIdentity ??= resolveWorkspaceAppIdentity({
    manifestUrl: uiManifestUrl(),
    buildDirectoryUrl: uiBuildDirectoryUrl(),
    fallbackRevision: FORGERELAY_VERSION,
  });
  return cachedWorkspaceAppIdentity;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  return readWorkspaceAppManifestEntry(uiManifestUrl());
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
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
    <title>ForgeRelay Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appDomain(config: ServerConfig): string {
  return new URL(config.publicBaseUrl).origin;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
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

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

function workspaceAppCompatibilityKind(
  requestedUri: string,
  currentUri: string,
): "current" | "legacy" | "historical" {
  if (requestedUri === currentUri) return "current";
  if (requestedUri === WORKSPACE_APP_LEGACY_URI) return "legacy";
  return "historical";
}

async function readWorkspaceAppResource(
  config: ServerConfig,
  requestedUri: string,
  transportSessionId?: string,
) {
  const currentUri = currentWorkspaceAppIdentity().uri;
  const compatibility = workspaceAppCompatibilityKind(requestedUri, currentUri);

  try {
    await assertWorkspaceAppAssets();
    const result = {
      contents: [
        {
          uri: requestedUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: workspaceAppHtml(config),
          _meta: {
            ui: {
              domain: appDomain(config),
              csp: appCsp(config),
            },
          },
        },
      ],
    };
    logEvent(config.logging, "debug", "mcp_app_template_read", {
      requestedUri,
      currentUri,
      compatibility,
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
    });
    return result;
  } catch (error) {
    logEvent(config.logging, "warn", "mcp_app_template_read_failed", {
      requestedUri,
      currentUri,
      compatibility,
      error: error instanceof Error ? error.message : String(error),
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
    });
    throw error;
  }
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with process ID ${snapshot.processId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function completedProcessResult(snapshot: CompletedProcessSnapshot): string {
  const status = snapshot.signal
    ? `Background process ${snapshot.processId} exited after signal ${snapshot.signal}.`
    : `Background process ${snapshot.processId} exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const command = `Command: ${snapshot.command}`;
  const output = snapshot.output ? `\n${snapshot.output.replace(/\n$/, "")}` : "";
  return `${status}\n${command}${output}`;
}

function attachCompletedProcessNotices<T>(
  processSessions: ProcessManager,
  workspaceId: string,
  result: T,
): T {
  if (result instanceof Error) {
    const completed = processSessions.takeCompleted(workspaceId);
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
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
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
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
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
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
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
    workspaceRoot: workspace.root,
    guides: workspace.capabilityGuides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    })),
  };
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

function registerProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessManager,
  hooks: HookRunner,
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
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running process. Defaults to 10000."),
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
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: "exec_command",
        invocation: workspaceHookInvocation(workspace),
        payload: { command: cmd, workingDirectory: workingDirectory ?? "." },
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
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
            codexCi: true,
          });

          logToolCall(config, {
            tool: "exec_command",
            ...workspaceLogContext(workspace, extra.sessionId),
            workingDirectory: workingDirectory ?? ".",
            command: cmd,
            commandLength: cmd.length,
            exitCode: snapshot.exitCode,
            running: snapshot.running,
            processId: snapshot.processId,
            success: snapshot.running || snapshot.exitCode === 0,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return processToolResponse("exec_command", workspaceId, snapshot, {
            command: cmd,
            workingDirectory: workingDirectory ?? ".",
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          });
        },
      });
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
        "Poll or write characters to a running process returned by bash or exec_command. Omit chars or pass an empty string to poll. Waiting never kills the process; pass \\u0003 to explicitly send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        processId: z.number().int().positive().optional().describe("Canonical process identifier returned by bash or exec_command."),
        sessionId: z.number().int().positive().optional().describe("Deprecated alias for processId. Retained for compatibility."),
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
    async ({ workspaceId, processId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const resolvedProcessId = resolveProcessId(processId, sessionId);
      return runToolWithHooks(hooks, {
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
            workspaceId,
            processId: resolvedProcessId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
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

          return processToolResponse("write_stdin", workspaceId, snapshot, {
            processId: resolvedProcessId,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
          });
        },
      });
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  codeIntelligence: CodeIntelligenceManager,
): McpServer {
  const toolDescriptions = buildToolDescriptions(config);
  const hooks = new HookRunner(
    config.hooks,
    config.logging,
    process.env,
    (workspaceId, result) => attachCompletedProcessNotices(processSessions, workspaceId, result),
  );
  const incomingArtifactRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);
  const artifactDownloadAvailable = config.artifactsEnabled && isArtifactDownloadSupportedPlatform();
  const reviewChangesAvailable = config.widgets === "changes";
  const capabilityRegistry = createCapabilityRegistry({
    inspectHooks: (workspaceRoot) => checkHookConfiguration(workspaceRoot, config.hooks),
    codeIntelligence: {
      available: true,
      run: async (input, context, options) => {
        try {
          return {
            value: await codeIntelligence.run(context.workspaceRoot, input, { signal: options.signal }),
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
          root: context.workspaceRoot,
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
            workspaceRoot: context.workspaceRoot,
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

  const currentWorkspaceAppUri = currentWorkspaceAppIdentity().uri;
  const workspaceAppResourceMetadata = {
    description: "Interactive card for viewing ForgeRelay file diffs.",
    _meta: {
      ui: {
        domain: appDomain(config),
        csp: appCsp(config),
      },
    },
  };

  registerAppResource(
    server,
    "ForgeRelay Diff Card",
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
    "ForgeRelay Diff Card legacy",
    WORKSPACE_APP_LEGACY_URI,
    workspaceAppResourceMetadata,
    async (uri, extra) => readWorkspaceAppResource(
      config,
      uri.toString(),
      extra.sessionId,
    ),
  );

  server.registerResource(
    "ForgeRelay Diff Card compatibility",
    new ResourceTemplate(WORKSPACE_APP_URI_TEMPLATE, { list: undefined }),
    {
      ...workspaceAppResourceMetadata,
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri, _variables, extra) => readWorkspaceAppResource(
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
        "Open or resume a local coding workspace. Reuse the returned workspaceId for later calls. Default to checkout; use mode=\"worktree\" only when the user explicitly requests isolated or parallel Git work. Every call returns lightweight workspace metadata; bootstrap context is delivered automatically only when needed and can be explicitly suppressed or refreshed.",
      inputSchema: {
        action: z
          .enum(["open", "list"])
          .optional()
          .describe("Defaults to open. Use list only when you need to inspect or choose logical workspaces before resuming or cleaning them up."),
        path: z
          .string()
          .optional()
          .describe(
            "Project path to open. Required for action=open unless workspaceId is supplied. With mode=\"worktree\", this may also be a managed worktree path previously returned by ForgeRelay.",
          ),
        workspaceId: z
          .string()
          .optional()
          .describe(
            "For action=open, an existing logical workspace ID to resume in this conversation. For action=list, filters inventory to one workspace ID.",
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
            "When true, allocate a fresh logical workspaceId for the same physical checkout or worktree and bind this conversation to it. Use only after the user explicitly requests a new logical workspace.",
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
          .describe("For action=list, return only active logical workspaces idle for more than two days."),
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
        action: z.enum(["open", "list"]),
        workspaceId: z.string().optional(),
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
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        workspaces: z.array(workspaceInventoryEntryOutputSchema).optional(),
        summary: workspaceInventorySummaryOutputSchema.optional(),
        page: workspaceInventoryPageOutputSchema.optional(),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      action = "open",
      path,
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

      if (action === "list") {
        if (
          path !== undefined || baseRef !== undefined || newWorktree !== undefined ||
          newWorkspace !== undefined || context !== undefined
        ) {
          throw new Error(
            "open_workspace action=list does not accept path, baseRef, newWorktree, newWorkspace, or context. Use root/workspaceId/mode/status/state/staleOnly for inventory filters.",
          );
        }
        const inventory = await workspaces.listWorkspaces(
          { workspaceId, mode, root, status, state, staleOnly, offset, limit },
          { conversationScopeId, protectedWorkspaceIds },
        );
        const nextOffset = inventory.page.offset + inventory.page.limit;
        const instruction = [
          "Resume a selected workspaceId with open_workspace(action=\"open\", workspaceId=...).",
          "Use close_workspace only after the user chooses cleanup; never close inventory entries automatically.",
          inventory.page.hasMore
            ? `More matching workspaces are available; continue with offset=${nextOffset}.`
            : undefined,
        ].filter(Boolean).join(" ");
        const result = [
          `Logical workspace inventory: ${inventory.summary.matching} matching of ${inventory.summary.total} stored records.`,
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

      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        hookReports,
        workspaceReused,
        includeBootstrapContext,
        contextFingerprint,
      } = await workspaces.openWorkspace(
        { path, workspaceId, mode, baseRef, newWorktree, newWorkspace, context },
        {
          conversationScopeId,
          protectedWorkspaceIds,
        },
      );
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
          path: formatPathForPrompt(skill.filePath),
        }));
      const capabilityGuides = workspace.capabilityGuides.map((guide) => ({
        name: guide.name,
        description: guide.description,
        whenToRead: guide.whenToRead,
        path: formatPathForPrompt(guide.filePath),
      }));
      const capabilityCatalog = capabilityRegistry.catalog(capabilityContextFor(workspace));
      const cardAgentProviders = config.subagents ? localAgentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
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
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleCapabilityGuides = includeBootstrapContext ? capabilityGuides : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const workspaceContextInstruction =
        "For later open_workspace calls, context=\"auto\" avoids repeating unchanged bootstrap context; use context=\"none\" when only the workspace handle/metadata is needed, or context=\"full\" to force a refresh.";
      const workspaceManagementInstruction =
        "When you need to continue an earlier logical workspace or organize workspace state, use open_workspace(action=\"list\") to inspect candidates, then resume a selected workspaceId or ask the user before close_workspace cleanup.";
      const cardInstruction = config.skillsEnabled
        ? `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches an available skill or capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`
        : `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches a capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`;
      const instruction = workspaceReused
        ? includeBootstrapContext
          ? [
              `Workspace already exists as ${workspace.id} for this directory.`,
              "Reuse this workspaceId for subsequent tool calls.",
              "The complete project context is included because it has not yet been provided in this conversation or host context.",
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
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            knownWorktrees.length > 0
              ? `Known worktrees: ${knownWorktrees.map((worktree) => `${worktree.path} [${worktree.workspaceId}]${worktree.branch ? ` branch=${worktree.branch}` : ""}${worktree.targetBranch ? ` target=${worktree.targetBranch}` : ""}${worktree.current ? " (current)" : ""}`).join(", ")}`
              : undefined,
            staleWorkspaces.length > 0
              ? `Idle logical workspaces for this same physical workspace (>2 days): ${staleWorkspaces.map((stale) => `${stale.workspaceId} last-used=${stale.lastUsedAt}`).join(", ")}. Tell the user these are available to resume or explicitly close; do not clean them up automatically.`
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

      return hooks.decorateResult(workspace.id, attachHookReports({
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
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
          },
        },
        structuredContent: {
          action: "open" as const,
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          worktrees: knownWorktrees,
          staleWorkspaces,
          capabilityFingerprint,
          contextFingerprint,
          capabilityCatalog,
          ...(includeBootstrapContext
            ? {
                capabilityGuides: visibleCapabilityGuides,
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      }, hookReports));
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
    async ({ workspaceId, name, action, arguments: capabilityArguments, file }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      let changedPaths: string[] = [];
      return runToolWithHooks(hooks, {
        tool: toolNames.capability,
        invocation: workspaceHookInvocation(workspace),
        payload: { name, action },
        isFailure: toolResultIsError,
        changedPaths: () => changedPaths,
        operation: async () => {
          const startedAt = performance.now();
          try {
            if (action === "describe") {
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
            }

            const execution = await capabilityRegistry.run(
              name,
              capabilityArguments ?? {},
              capabilityContextFor(workspace),
              { nativeFile: file, signal: extra.signal },
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
              structuredContent: { name, action, result: execution.value },
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
      });
    },
  );

  registerAppTool(
    server,
    toolNames.closeWorkspace,
    {
      title: "Close workspace",
      description:
        "Close one workspace after the user chooses cleanup. Checkout-backed workspaces release only the logical handle. Managed-worktree-backed workspaces finalize the existing safe worktree lifecycle, including hooks, commit/integration, and cleanup; provide commitMessage for that mode. Running or unconsumed processes prevent closure.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier to close."),
        commitMessage: z
          .string()
          .min(1)
          .optional()
          .describe("Required only for a managed-worktree-backed workspace; concise Git commit message for remaining worktree changes."),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        mode: z.enum(["checkout", "worktree"]),
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
    async ({ workspaceId, commitMessage }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.closeWorkspace,
        invocation: workspaceHookInvocation(workspace),
        payload: { workspaceId, commitMessage, mode: workspace.mode },
        afterCwd: (response) =>
          "sourceRoot" in response.structuredContent &&
          typeof response.structuredContent.sourceRoot === "string"
            ? response.structuredContent.sourceRoot
            : undefined,
        operation: async () => {
          if (workspace.mode === "worktree") {
            if (!commitMessage) {
              throw new Error(
                `Managed-worktree-backed workspace ${workspaceId} requires commitMessage when closing.`,
              );
            }
            const physicalWorkspaceIds = workspaces.workspaceIdsForPhysicalWorkspace(workspace);
            const busyWorkspaceIds = physicalWorkspaceIds
              .filter((id) => processSessions.activeWorkspaceIds().has(id));
            if (busyWorkspaceIds.length > 0) {
              throw new Error(
                `Cannot close this worktree-backed workspace while logical workspace processes are still running or awaiting completion delivery: ${busyWorkspaceIds.join(", ")}.`,
              );
            }
            const startedAt = performance.now();
            const closed = await workspaces.closeWorktree(workspaceId, commitMessage);
            await Promise.all(
              physicalWorkspaceIds.map((id) => reviewCheckpoints.releaseWorkspace(id)),
            );
            const result = [
              `Closed managed-worktree-backed workspace ${workspaceId}.`,
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
              structuredContent: {
                result,
                workspaceId,
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
          if (processSessions.activeWorkspaceIds().has(workspaceId)) {
            throw new Error(
              `Workspace ${workspaceId} still owns a running process or an unconsumed process completion. Poll or consume it before closing this workspace.`,
            );
          }
          workspaces.closeWorkspace(workspaceId);
          await reviewCheckpoints.releaseWorkspace(workspaceId);
          const result = `Closed checkout-backed workspace ${workspaceId}. Physical project files were not removed.`;
          return {
            content: [textBlock(result)],
            structuredContent: { result, workspaceId, mode: "checkout" as const },
          };
        },
      });
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
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root or absolute inside the OS temp directory. May also be an advertised skill or capability-guide path from open_workspace, including a ~/... home-relative path."
              : "File path to read, relative to the workspace root or absolute inside the OS temp directory. May also be an advertised capability-guide path from open_workspace.",
          ),
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
      }),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.read,
        invocation: workspaceHookInvocation(workspace),
        payload: { path: input.path, offset: input.offset, limit: input.limit },
        isFailure: toolResultIsError,
        operation: async () => {
          const startedAt = performance.now();
          const readPath = workspaces.resolveReadPath(workspace, input.path);
          const discoveredInstructions = (await workspaces.discoverPathInstructions(
            workspace,
            readPath.absolutePath,
          )).filter((file) => file.path !== readPath.absolutePath);
          const response = await readFileTool(
            { ...input, path: readPath.absolutePath },
            {
              cwd: workspace.root,
              root: workspace.root,
              readRoots: readPath.readRoots,
            },
          );

          if (response.isError) {
            logFailedToolResponse(config, {
              tool: toolNames.read,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
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
            offset: input.offset ?? 1,
            limited: input.limit !== undefined,
          };
          logToolCall(config, {
            tool: toolNames.read,
            ...workspaceLogContext(workspace, extra.sessionId),
            path: input.path,
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
                path: input.path,
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
      });
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
        path: z
          .string()
          .describe("File path to write, relative to the workspace root or absolute inside the OS temp directory."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.write,
        invocation: workspaceHookInvocation(workspace),
        payload: { path: input.path },
        isFailure: toolResultIsError,
        changedPaths: (result) => toolResultIsError(result) ? [] : [input.path],
        operation: async () => {
          const startedAt = performance.now();
          await assertWorkspaceInstructionsLoadedBeforeSideEffect(
            workspaces,
            workspace,
            [input.path],
          );
          const response = await writeFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
            fileRoots: workspaces.fileToolRoots(workspace),
          });

          if (response.isError) {
            logFailedToolResponse(config, {
              tool: toolNames.write,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
            }, response.content, startedAt);
            return response;
          }

          const patch = newFilePatch(input.path, input.content);
          const stats = countDiffStats(patch);
          const summary = {
            ...stats,
            lines: contentLineCount(input.content),
            characters: input.content.length,
          };
          logToolCall(config, {
            tool: toolNames.write,
            ...workspaceLogContext(workspace, extra.sessionId),
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            ...response,
            _meta: {
              tool: toolNames.write,
              card: {
                workspaceId,
                path: input.path,
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
      });
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
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root or absolute inside the OS temp directory."),
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
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.edit,
        invocation: workspaceHookInvocation(workspace),
        payload: { path: input.path, editCount: input.edits.length },
        isFailure: toolResultIsError,
        changedPaths: (result) => toolResultIsError(result) ? [] : [input.path],
        operation: async () => {
          const startedAt = performance.now();
          await assertWorkspaceInstructionsLoadedBeforeSideEffect(
            workspaces,
            workspace,
            [input.path],
          );
          const response = await editFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
            fileRoots: workspaces.fileToolRoots(workspace),
          });

          if (response.isError) {
            logFailedToolResponse(config, {
              tool: toolNames.edit,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
            }, response.content, startedAt);
            return response;
          }

          const stats = countDiffStats(
            response.details?.patch ?? response.details?.diff,
          );
          const summary = {
            ...stats,
            editCount: input.edits.length,
          };
          const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
          const editContent = [textBlock(editResultText)];
          logToolCall(config, {
            tool: toolNames.edit,
            ...workspaceLogContext(workspace, extra.sessionId),
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            content: editContent,
            _meta: {
              tool: toolNames.edit,
              card: {
                workspaceId,
                path: input.path,
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
      });
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
    async ({ workspaceId, path, newPath }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
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
              ...workspaceLogContext(workspace, extra.sessionId),
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
              ...workspaceLogContext(workspace, extra.sessionId),
              path: `${path} -> ${newPath}`,
              success: false,
              durationMs: Math.round(performance.now() - startedAt),
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
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
        path: z.string().describe("File or directory path relative to the workspace root, or absolute inside the OS temp directory."),
        recursive: z.boolean().optional().describe("Delete a non-empty directory tree. Defaults to false."),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("deleted"),
        path: z.string(),
        recursive: z.boolean(),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, path, recursive }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
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
              ...workspaceLogContext(workspace, extra.sessionId),
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
              ...workspaceLogContext(workspace, extra.sessionId),
              path,
              success: false,
              durationMs: Math.round(performance.now() - startedAt),
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      });
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
      async ({ workspaceId, patch }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
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
                  workspaceId,
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
        });
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
          action: z
            .enum(["run", "process"])
            .optional()
            .describe("Defaults to run. Use process with a returned processId to poll, interact, resize, or interrupt a running command."),
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
            .describe("Milliseconds to wait before returning. Run preserves the existing 300000ms default; process polling defaults to 5000ms and interaction to 250ms."),
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
        action = "run",
        command,
        processId,
        input,
        interrupt,
        tty,
        columns,
        rows,
        workingDirectory,
        yieldTimeMs,
        maxOutputTokens,
      }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        if (action === "run") {
          if (!command) throw new Error("bash action=run requires command.");
          if (processId !== undefined || input !== undefined || interrupt !== undefined) {
            throw new Error("bash action=run does not accept processId, input, or interrupt.");
          }
          return runToolWithHooks(hooks, {
            tool: toolNames.shell,
            invocation: workspaceHookInvocation(workspace),
            payload: {
              action,
              command,
              workingDirectory: workingDirectory ?? ".",
            },
            isFailure: toolResultIsError,
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
                yieldTimeMs: yieldTimeMs ?? 300_000,
                maxOutputTokens,
              });

              logToolCall(config, {
                tool: toolNames.shell,
                ...workspaceLogContext(workspace, extra.sessionId),
                workingDirectory: workingDirectory ?? ".",
                command,
                commandLength: command.length,
                exitCode: snapshot.exitCode,
                running: snapshot.running,
                processId: snapshot.processId,
                success: snapshot.running || (snapshot.exitCode === 0 && !snapshot.signal),
                durationMs: Math.round(performance.now() - startedAt),
              });

              const response = processToolResponse(toolNames.shell, workspaceId, snapshot, {
                action,
                command,
                workingDirectory: workingDirectory ?? ".",
                running: snapshot.running,
                exitCode: snapshot.exitCode,
                wallTimeMs: snapshot.wallTimeMs,
              });
              return !snapshot.running && (snapshot.signal || snapshot.exitCode !== 0)
                ? { ...response, isError: true }
                : response;
            },
          });
        }

        if (command !== undefined || workingDirectory !== undefined || tty !== undefined) {
          throw new Error("bash action=process does not accept command, workingDirectory, or tty.");
        }
        if (processId === undefined) throw new Error("bash action=process requires processId.");
        if (interrupt && input !== undefined) {
          throw new Error("bash action=process cannot combine interrupt with input.");
        }
        return runToolWithHooks(hooks, {
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
              workspaceId,
              processId,
              chars: interrupt ? "\u0003" : input,
              columns,
              rows,
              yieldTimeMs,
              maxOutputTokens,
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
            return processToolResponse(toolNames.shell, workspaceId, snapshot, {
              action,
              processId,
              inputLength: input?.length ?? 0,
              interrupt: interrupt ?? false,
              running: snapshot.running,
              exitCode: snapshot.exitCode,
              wallTimeMs: snapshot.wallTimeMs,
            });
          },
        });
      },
    );
  }

  registerProcessTools(server, config, workspaces, processSessions, hooks);

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
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessManager();
  const codeIntelligence = new CodeIntelligenceManager(config);
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
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
      languageServices: codeIntelligence.size,
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
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
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
          localAgentProviders,
          incomingArtifactAdapters,
          codeIntelligence,
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
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(transportCleanupTimer);
        const results = await transports.closeAll();
        logTransportCloseResults("server_shutdown", results);
        processSessions.shutdown();
        await codeIntelligence.shutdown();
        oauthProvider.close();
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
  const { app, config, close, localAgentProviders } = createServer();
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
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
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
