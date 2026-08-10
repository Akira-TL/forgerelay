import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { deletePath, renamePath } from "./file-mutations.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { attachHookReports, HookRunner, runToolWithHooks } from "./hooks.js";
import {
  buildServerInstructions,
  buildShellMutationPolicy,
  buildToolDescriptions,
  toolNames,
} from "./mcp/server-instructions.js";
import {
  createOpenAIIncomingArtifactAdapter,
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
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
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
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

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
      return kind === "workspace" || kind === "show_changes";
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
    ip: requestIp(req, config.logging.trustProxy),
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
    processId: z.number().int().positive().optional().describe("Canonical process handle for write_stdin."),
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
): McpServer {
  const toolDescriptions = buildToolDescriptions(config);
  const hooks = new HookRunner(
    config.hooks,
    config.logging,
    process.env,
    (workspaceId, result) => attachCompletedProcessNotices(processSessions, workspaceId, result),
  );
  const server = new McpServer(
    {
      name: "forgerelay",
      title: "ForgeRelay",
      version: FORGERELAY_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: buildServerInstructions(config, {
        artifactDownloadSupported: isArtifactDownloadSupportedPlatform(),
      }),
    },
  );

  const currentWorkspaceAppUri = currentWorkspaceAppIdentity().uri;
  const workspaceAppResourceMetadata = {
    description: "Interactive card for viewing ForgeRelay file diffs.",
    _meta: {
      ui: {
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
        "Open or resume a local coding workspace. Reuse the returned workspaceId for later calls. Default to checkout; use mode=\"worktree\" only when the user explicitly requests isolated or parallel Git work. Every call returns a capability fingerprint; bootstrap calls also expose project context, skills, and capability guides when needed.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Project path to open. Required unless workspaceId is supplied. With mode=\"worktree\", this may also be a managed worktree path previously returned by ForgeRelay.",
          ),
        workspaceId: z
          .string()
          .optional()
          .describe(
            "Existing logical workspace ID to resume in this conversation. When supplied, ForgeRelay resumes that workspace rather than allocating another ID.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree only when the user explicitly requests isolated or parallel Git work.",
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
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
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
        ),
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
        ),
        capabilityFingerprint: capabilityFingerprintOutputSchema,
        capabilityGuides: z.array(capabilityGuideOutputSchema).optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
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
    async ({ path, workspaceId, mode, baseRef, newWorktree, newWorkspace }, { _meta, sessionId }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        hookReports,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, workspaceId, mode, baseRef, newWorktree, newWorkspace },
        {
          conversationScopeId: openAiConversationScopeId(_meta),
          protectedWorkspaceIds: processSessions.activeWorkspaceIds(),
        },
      );
      const knownWorktrees = await workspaces.listKnownWorktrees(workspace);
      const staleWorkspaces = await workspaces.listStaleWorkspaces(workspace);
      const capabilityFingerprint = buildCapabilityFingerprint(config, FORGERELAY_VERSION);
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
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches an available skill or capability guide, read its advertised path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches a capability guide, read its advertised path before proceeding.";
      const instruction = workspaceReused
        ? includeBootstrapContext
          ? [
              `Workspace already exists as ${workspace.id} for this directory.`,
              "Reuse this workspaceId for subsequent tool calls.",
              "The complete project context is included because it has not yet been provided in this conversation or host context.",
            ].join("\n\n")
          : [
              `Workspace already open as ${workspace.id}.`,
              "Reuse this workspaceId for subsequent tool calls. This is the same directory previously opened in this conversation.",
              "Continue following the project instructions, nested instruction files, skills, agent profiles, and diagnostics previously provided for this workspace. They remain active and are not repeated here.",
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
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          worktrees: knownWorktrees,
          staleWorkspaces,
          capabilityFingerprint,
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
    toolNames.closeWorkspace,
    {
      title: "Close logical workspace",
      description:
        "Release one logical workspaceId after the user chooses cleanup. This does not delete checkout files. Use close_worktree to finalize and remove a managed worktree. Running or unconsumed processes prevent closure.",
      inputSchema: {
        workspaceId: z.string().describe("Logical workspace ID to release."),
      },
      outputSchema: resultOutputSchema({ workspaceId: z.string() }),
      _meta: {},
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.closeWorkspace,
        invocation: workspaceHookInvocation(workspace),
        payload: { workspaceId },
        operation: async () => {
          if (processSessions.activeWorkspaceIds().has(workspaceId)) {
            throw new Error(
              `Workspace ${workspaceId} still owns a running process or an unconsumed process completion. Poll or consume it before closing this workspace.`,
            );
          }
          workspaces.closeWorkspace(workspaceId);
          const result = `Closed logical workspace ${workspaceId}. Physical project files were not removed.`;
          return {
            content: [textBlock(result)],
            structuredContent: { result, workspaceId },
          };
        },
      });
    },
  );

  registerAppTool(
    server,
    toolNames.closeWorktree,
    {
      title: "Close worktree",
      description:
        "Finalize a managed worktree after its task is complete and verified. ForgeRelay may commit remaining changes, integrate the target branch when safe, and clean up the managed worktree. Read the managed-worktrees capability guide for advanced close, safety, and failure semantics.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Managed worktree workspace identifier returned by open_workspace."),
        commitMessage: z
          .string()
          .min(1)
          .describe("Concise Git commit message describing the completed worktree changes."),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        sourceRoot: z.string(),
        branch: z.string(),
        targetBranch: z.string(),
        commitSha: z.string(),
        mergedSha: z.string(),
        committed: z.boolean(),
        cleanupWarning: z.string().optional(),
      }),
      _meta: {},
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, commitMessage }, extra) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return runToolWithHooks(hooks, {
        tool: toolNames.closeWorktree,
        invocation: workspaceHookInvocation(workspace),
        payload: { commitMessage },
        afterCwd: (response) => response.structuredContent.sourceRoot,
        operation: async () => {
          const busyWorkspaceIds = workspaces
            .workspaceIdsForPhysicalWorkspace(workspace)
            .filter((id) => processSessions.activeWorkspaceIds().has(id));
          if (busyWorkspaceIds.length > 0) {
            throw new Error(
              `Cannot close this worktree while logical workspace processes are still running or awaiting completion delivery: ${busyWorkspaceIds.join(", ")}.`,
            );
          }
          const startedAt = performance.now();
          const closed = await workspaces.closeWorktree(workspaceId, commitMessage);
          const result = [
            `Closed managed worktree ${workspaceId}.`,
            `Merged ${closed.branch} into ${closed.targetBranch} by fast-forward.`,
            `Source checkout: ${closed.sourceRoot}`,
            `Commit: ${closed.commitSha}`,
            closed.cleanupWarning
              ? `Cleanup warning: ${closed.cleanupWarning}`
              : "The worktree directory and managed branch were removed.",
          ].join("\n");

          logToolCall(config, {
            tool: toolNames.closeWorktree,
            ...workspaceLogContext(workspace, extra.sessionId),
            path: closed.sourceRoot,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return attachHookReports({
            content: [{ type: "text" as const, text: result }],
            structuredContent: {
              result,
              workspaceId,
              sourceRoot: closed.sourceRoot,
              branch: closed.branch,
              targetBranch: closed.targetBranch,
              commitSha: closed.commitSha,
              mergedSha: closed.mergedSha,
              committed: closed.committed,
              cleanupWarning: closed.cleanupWarning,
            },
          }, closed.hookReports);
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
      outputSchema: resultOutputSchema(),
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
              result: contentText(response.content),
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

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
          tool: "show_changes",
          invocation: workspaceHookInvocation(workspace),
          operation: async () => {
            const startedAt = performance.now();
            const review = await reviewCheckpoints.reviewChanges({
              workspaceId,
              root: workspace.root,
              markReviewed: true,
            });

            const content = [textBlock(review.result)];
            logToolCall(config, {
              tool: "show_changes",
              ...workspaceLogContext(workspace, extra.sessionId),
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              content,
              _meta: {
                tool: "show_changes",
                card: {
                  workspaceId,
                  summary: review.summary,
                  files: review.files,
                  payload: {
                    patch: review.patch,
                  },
                },
              },
              structuredContent: {
                result: contentText(content),
              },
            };
          },
        });
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents inside an open workspace or the OS temp directory. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root, or an absolute path inside the OS temp directory.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
          tool: toolNames.grep,
          invocation: workspaceHookInvocation(workspace),
          payload: { pattern: input.pattern, path: input.path, include: input.include },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const response = await grepFilesTool(input, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.grep,
                ...workspaceLogContext(workspace, extra.sessionId),
                path: input.path,
              }, response.content, startedAt);
              return response;
            }

            const summary = {
              pattern: input.pattern,
              scope: input.path ?? ".",
              ...textSummary(response.content),
            };
            logToolCall(config, {
              tool: toolNames.grep,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              _meta: {
                tool: toolNames.grep,
                card: {
                  workspaceId,
                  path: input.path,
                  summary,
                  payload: { content: response.content },
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
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern inside an open workspace or the OS temp directory. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root, or an absolute path inside the OS temp directory."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
          tool: toolNames.glob,
          invocation: workspaceHookInvocation(workspace),
          payload: { pattern: input.pattern, path: input.path },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const response = await findFilesTool(input, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.glob,
                ...workspaceLogContext(workspace, extra.sessionId),
                path: input.path,
              }, response.content, startedAt);
              return response;
            }

            const summary = {
              pattern: input.pattern,
              scope: input.path ?? ".",
              ...textSummary(response.content),
            };
            logToolCall(config, {
              tool: toolNames.glob,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              _meta: {
                tool: toolNames.glob,
                card: {
                  workspaceId,
                  path: input.path,
                  summary,
                  payload: { content: response.content },
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
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory inside an open workspace or the OS temp directory. Use this for directory inspection before reading files. Call open_workspace first and pass workspaceId.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root or absolute inside the OS temp directory.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
          tool: toolNames.ls,
          invocation: workspaceHookInvocation(workspace),
          payload: { path: input.path },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const response = await listDirectoryTool(input, {
              cwd: workspace.root,
              root: workspace.root,
              fileRoots: workspaces.fileToolRoots(workspace),
            });

            if (response.isError) {
              logFailedToolResponse(config, {
                tool: toolNames.ls,
                ...workspaceLogContext(workspace, extra.sessionId),
                path: input.path,
              }, response.content, startedAt);
              return response;
            }

            const summary = textSummary(response.content);
            logToolCall(config, {
              tool: toolNames.ls,
              ...workspaceLogContext(workspace, extra.sessionId),
              path: input.path,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              ...response,
              _meta: {
                tool: toolNames.ls,
                card: {
                  workspaceId,
                  path: input.path,
                  summary,
                  payload: { content: response.content },
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
          command: z
            .string()
            .describe(toolDescriptions.shellCommand),
          workingDirectory: z
            .string()
            .optional()
            .describe(
              "Optional working directory relative to the workspace root. Defaults to the workspace root.",
            ),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, command, workingDirectory }, extra) => {
        const workspace = workspaces.getWorkspace(workspaceId);
        return runToolWithHooks(hooks, {
          tool: toolNames.shell,
          invocation: workspaceHookInvocation(workspace),
          payload: {
            command,
            workingDirectory: workingDirectory ?? ".",
          },
          isFailure: toolResultIsError,
          operation: async () => {
            const startedAt = performance.now();
            const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
            const snapshot = await processSessions.start({
              workspaceId,
              command,
              cwd,
              workspaceRoot: workspace.root,
              yieldTimeMs: 300_000,
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
      },
    );
  }

  registerProcessTools(server, config, workspaces, processSessions, hooks);

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      hooks,
      incomingArtifactAdapters,
    });
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
  const transports = new McpTransportRegistry<Transport>();
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
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  const logTransportCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
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
      if (reason === "idle_timeout") {
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

  const transportCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_TRANSPORT_IDLE_TIMEOUT_MS)
      .then((results) => logTransportCloseResults("idle_timeout", results));
  }, MCP_TRANSPORT_CLEANUP_INTERVAL_MS);
  transportCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
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
            if (transport) transports.register(newTransportSessionId, transport);
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
