import { createHash } from "node:crypto";
import {
  AuthorizationServerMismatchError,
  Client,
  InsufficientScopeError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type CallToolResult,
  type PriorDiscovery,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type {
  ExternalMcpServerConfig,
  ExternalMcpServersConfig,
} from "../../../runtime/config/external-mcp-config.js";
import {
  ExternalMcpCredentialStore,
  externalMcpCredentialIdentity,
} from "../../../runtime/config/external-mcp-auth-store.js";
import type { ExternalMcpConfigSource } from "../../../runtime/config/external-mcp-registry.js";
import {
  claimMediaBytes,
  createMediaBudget,
  isSupportedImageMimeType,
  strictBase64ByteLength,
  type MediaContentMetadata,
} from "../media-content.js";
import {
  ExternalMcpTransformError,
  type ExternalMcpTransformResult,
  type ExternalMcpTransformSummary,
} from "../../hooks/external-mcp-transform.js";
import {
  ExternalMcpOAuthError,
  createExternalMcpRuntimeAuth,
  externalMcpAuthError,
  markExternalMcpAuthorizationRequired,
  markExternalMcpReauthorization,
  type ExternalMcpRuntimeAuth,
} from "./external-mcp-oauth.js";

const MAX_DISCOVERED_TOOLS = 100;
const MAX_TOOL_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_DISCOVERY_PAGES = 16;
const LEGACY_NEGOTIATION_TTL_MS = 5 * 60 * 1_000;

interface ExternalMcpNegotiationCacheEntry {
  fingerprint: string;
  prior: PriorDiscovery;
  cachedAt: number;
}

export type ExternalMcpCapabilityInput =
  | { operation: "servers" }
  | { operation: "tools"; server: string }
  | { operation: "call"; server: string; tool: string; arguments?: Record<string, unknown> };

type ExternalMcpProjectedContent = Array<
  | Exclude<CallToolResult["content"][number], { type: "image" }>
  | MediaContentMetadata
>;

export interface ExternalMcpCapabilityResult {
  operation: ExternalMcpCapabilityInput["operation"];
  server?: string;
  tool?: string;
  servers?: Array<{ name: string; transport: ExternalMcpServerConfig["transport"] }>;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
    schemaTruncated?: boolean;
  }>;
  truncated?: boolean;
  content?: ExternalMcpProjectedContent;
  structuredContent?: Record<string, unknown>;
  transforms?: ExternalMcpTransformSummary[];
}

export interface ExternalMcpCallTransforms {
  request?: (
    server: string,
    tool: string,
    arguments_: Record<string, unknown>,
  ) => Promise<ExternalMcpTransformResult<Record<string, unknown>>>;
  result?: (
    server: string,
    tool: string,
    result: CallToolResult,
  ) => Promise<ExternalMcpTransformResult<CallToolResult>>;
}

export interface ExternalMcpRunResult {
  value: ExternalMcpCapabilityResult;
  content?: CallToolResult["content"];
}

export interface ExternalMcpAuthContext {
  workspaceRoot: string;
  origins: Record<string, ExternalMcpConfigSource>;
}

export interface ExternalMcpProbeResult {
  protocolEra: "legacy" | "modern" | "unknown";
  protocolVersion?: string;
  toolCount: number;
  truncated: boolean;
}

export class ExternalMcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ExternalMcpError";
  }
}

export class ExternalMcpGateway {
  private readonly negotiationCache = new Map<string, ExternalMcpNegotiationCacheEntry>();

  constructor(
    private readonly mediaMaxBytes: number,
    private readonly credentialStore?: ExternalMcpCredentialStore,
  ) {}

  async run(
    servers: ExternalMcpServersConfig,
    input: ExternalMcpCapabilityInput,
    signal?: AbortSignal,
    transforms?: ExternalMcpCallTransforms,
    authContext?: ExternalMcpAuthContext,
  ): Promise<ExternalMcpRunResult> {
    signal?.throwIfAborted();
    switch (input.operation) {
      case "servers":
        return {
          value: {
            operation: "servers",
            servers: Object.entries(servers)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, server]) => ({ name, transport: server.transport })),
          },
        };
      case "tools":
        return this.withClient(servers, input.server, signal, authContext, async (client) => {
          const discovery = await discoverTools(client, signal);
          return {
            value: {
              operation: "tools",
              server: input.server,
              tools: discovery.tools.map(summarizeTool),
              ...(discovery.truncated ? { truncated: true } : {}),
            },
          };
        });
      case "call":
        return this.withClient(servers, input.server, signal, authContext, async (client) => {
          await assertRegisteredTool(client, input.server, input.tool, signal);
          const appliedTransforms: ExternalMcpTransformSummary[] = [];
          let callArguments = input.arguments ?? {};
          if (transforms?.request) {
            const transformed = await transforms.request(input.server, input.tool, callArguments);
            callArguments = transformed.value;
            appliedTransforms.push(...transformed.transforms);
          }
          let result = await client.callTool(
            { name: input.tool, arguments: callArguments },
            { signal },
          );
          assertCallToolResult(input.server, input.tool, result);
          if (result.isError) {
            throw new ExternalMcpError(
              "tool_failed",
              `External MCP ${input.server} tool ${input.tool} returned an upstream tool error.`,
            );
          }
          if (transforms?.result) {
            const transformed = await transforms.result(input.server, input.tool, result);
            result = transformed.value;
            appliedTransforms.push(...transformed.transforms);
            assertCallToolResult(input.server, input.tool, result);
            if (result.isError) {
              throw new ExternalMcpError(
                "tool_failed",
                `External MCP ${input.server} tool ${input.tool} returned an error after result transformation.`,
              );
            }
          }
          const projection = projectExternalMcpContent(
            input.server,
            input.tool,
            result,
            this.mediaMaxBytes,
          );
          return {
            content: result.content,
            value: {
              operation: "call",
              server: input.server,
              tool: input.tool,
              content: projection.content,
              ...(!projection.hasMedia && isRecord(result.structuredContent)
                ? { structuredContent: result.structuredContent }
                : {}),
              ...(appliedTransforms.length > 0 ? { transforms: appliedTransforms } : {}),
            },
          };
        });
    }
  }

  async probe(
    servers: ExternalMcpServersConfig,
    name: string,
    signal?: AbortSignal,
    authContext?: ExternalMcpAuthContext,
  ): Promise<ExternalMcpProbeResult> {
    return this.withClient(servers, name, signal, authContext, async (client) => {
      let discovery: Awaited<ReturnType<typeof discoverTools>>;
      try {
        discovery = await discoverTools(client, signal);
      } catch (error) {
        if (isExternalMcpAuthTransportError(error)) throw error;
        throw new ExternalMcpError(
          "tool_discovery_failed",
          `External MCP ${name} tool discovery failed.`,
          externalMcpFailureDetail(error),
        );
      }
      return {
        protocolEra: client.getProtocolEra() ?? "unknown",
        ...(client.getNegotiatedProtocolVersion()
          ? { protocolVersion: client.getNegotiatedProtocolVersion() }
          : {}),
        toolCount: discovery.tools.length,
        truncated: discovery.truncated,
      };
    });
  }

  private async withClient<T>(
    servers: ExternalMcpServersConfig,
    name: string,
    signal: AbortSignal | undefined,
    authContext: ExternalMcpAuthContext | undefined,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const config = servers[name];
    if (!config) throw new ExternalMcpError("unknown_server", `Unknown configured external MCP server: ${name}.`);
    const fingerprint = externalMcpServerFingerprint(config);
    const runtimeAuth = this.resolveRuntimeAuth(name, config, authContext);
    const client = new Client(
      { name: "forgerelay-external-mcp", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = createTransport(config, runtimeAuth?.authProvider);
    const prior = this.cachedPrior(name, fingerprint);
    try {
      signal?.throwIfAborted();
      await client.connect(transport, prior ? { prior } : undefined);
      this.rememberNegotiation(name, fingerprint, client);
      signal?.throwIfAborted();
      return await operation(client);
    } catch (error) {
      if (error instanceof ExternalMcpError || error instanceof ExternalMcpTransformError) throw error;
      this.invalidateNegotiation(name, fingerprint);
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof ExternalMcpOAuthError) {
        throw new ExternalMcpError(error.code, error.message);
      }
      const authError = externalMcpAuthError(name, error, runtimeAuth);
      if (authError) {
        if (this.credentialStore) {
          if (authError.code === "auth_required") {
            await markExternalMcpAuthorizationRequired(this.credentialStore, runtimeAuth).catch(() => undefined);
          } else if (error instanceof InsufficientScopeError) {
            await markExternalMcpReauthorization(
              this.credentialStore,
              runtimeAuth,
              "insufficient_scope",
              { ...(error.requiredScope ? { scope: error.requiredScope } : {}) },
            ).catch(() => undefined);
          } else if (runtimeAuth?.bindingMismatch || error instanceof AuthorizationServerMismatchError) {
            await markExternalMcpReauthorization(this.credentialStore, runtimeAuth, "binding_changed").catch(() => undefined);
          }
        }
        throw new ExternalMcpError(authError.code, authError.message);
      }
      throw new ExternalMcpError(
        "transport_failed",
        `External MCP ${name} request failed.`,
        externalMcpFailureDetail(error),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private resolveRuntimeAuth(
    name: string,
    config: ExternalMcpServerConfig,
    context: ExternalMcpAuthContext | undefined,
  ): ExternalMcpRuntimeAuth | undefined {
    if (!this.credentialStore || !context || config.transport !== "streamable-http") return undefined;
    if (hasStaticAuthorizationHeader(config.headers)) return undefined;
    const source = context.origins[name];
    if (!source) return undefined;
    const identity = externalMcpCredentialIdentity(source, name, context.workspaceRoot);
    return createExternalMcpRuntimeAuth(this.credentialStore, identity, config.url);
  }

  private cachedPrior(name: string, fingerprint: string): PriorDiscovery | undefined {
    const cached = this.negotiationCache.get(name);
    if (!cached || cached.fingerprint !== fingerprint) {
      if (cached) this.negotiationCache.delete(name);
      return undefined;
    }
    if (
      cached.prior.kind === "legacy" &&
      Date.now() - cached.cachedAt >= LEGACY_NEGOTIATION_TTL_MS
    ) {
      this.negotiationCache.delete(name);
      return undefined;
    }
    return cached.prior;
  }

  private rememberNegotiation(name: string, fingerprint: string, client: Client): void {
    const era = client.getProtocolEra();
    if (era === "legacy") {
      this.negotiationCache.set(name, {
        fingerprint,
        prior: { kind: "legacy" },
        cachedAt: Date.now(),
      });
      return;
    }
    if (era !== "modern") return;
    const discover = client.getDiscoverResult();
    if (!discover) return;
    this.negotiationCache.set(name, {
      fingerprint,
      prior: { kind: "modern", discover },
      cachedAt: Date.now(),
    });
  }

  private invalidateNegotiation(name: string, fingerprint: string): void {
    const cached = this.negotiationCache.get(name);
    if (cached?.fingerprint === fingerprint) this.negotiationCache.delete(name);
  }
}

function externalMcpServerFingerprint(config: ExternalMcpServerConfig): string {
  const normalized = config.transport === "stdio"
    ? {
      transport: config.transport,
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd ?? null,
      env: sortedStringRecord(config.env),
    }
    : {
      transport: config.transport,
      url: config.url,
      headers: sortedStringRecord(config.headers),
      oauth: config.oauth ?? null,
    };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function sortedStringRecord(value: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function createTransport(config: ExternalMcpServerConfig, authProvider?: AuthProvider) {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env
        ? { env: { ...getDefaultEnvironment(), ...config.env } }
        : {}),
      stderr: "ignore",
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    ...(authProvider ? { authProvider } : {}),
    onInsufficientScope: "throw",
  });
}

function hasStaticAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function isExternalMcpAuthTransportError(error: unknown): boolean {
  return error instanceof ExternalMcpOAuthError
    || error instanceof InsufficientScopeError
    || error instanceof AuthorizationServerMismatchError
    || error instanceof UnauthorizedError
    || (error instanceof SdkHttpError && error.status === 401);
}

function externalMcpFailureDetail(error: unknown): string | undefined {
  if (error instanceof SdkHttpError) return `HTTP ${error.status}`;
  const code = nestedErrorCode(error);
  if (code && code !== "ERA_NEGOTIATION_FAILED") return code;
  if (error instanceof Error && /tim(?:e|ed)\s*out|timeout/i.test(error.message)) return "timeout";
  return undefined;
}

function nestedErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof error !== "object" || error === null) return undefined;
  if ("cause" in error) {
    const nested = nestedErrorCode((error as { cause?: unknown }).cause, depth + 1);
    if (nested) return nested;
  }
  if ("code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  }
  return undefined;
}

async function discoverTools(
  client: Client,
  signal?: AbortSignal,
): Promise<{ tools: Awaited<ReturnType<Client["listTools"]>>["tools"]; truncated: boolean }> {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_TOOL_DISCOVERY_PAGES; pageIndex += 1) {
    signal?.throwIfAborted();
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    const remaining = MAX_DISCOVERED_TOOLS - tools.length;
    tools.push(...page.tools.slice(0, remaining));
    if (page.tools.length > remaining) return { tools, truncated: true };
    cursor = page.nextCursor;
    if (!cursor) return { tools, truncated: false };
    if (tools.length >= MAX_DISCOVERED_TOOLS) return { tools, truncated: true };
  }
  return { tools, truncated: cursor !== undefined };
}

async function assertRegisteredTool(
  client: Client,
  server: string,
  tool: string,
  signal?: AbortSignal,
): Promise<void> {
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_TOOL_DISCOVERY_PAGES; pageIndex += 1) {
    signal?.throwIfAborted();
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    if (page.tools.some((candidate) => candidate.name === tool)) return;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  throw new ExternalMcpError("unknown_tool", `External MCP ${server} does not advertise tool ${tool}.`);
}

function summarizeTool(tool: {
  name: string;
  description?: string;
  inputSchema: unknown;
}): {
  name: string;
  description?: string;
  inputSchema: unknown;
  schemaTruncated?: boolean;
} {
  const serialized = safeJson(tool.inputSchema);
  const schemaTruncated = Buffer.byteLength(serialized, "utf8") > MAX_TOOL_SCHEMA_BYTES;
  return {
    name: tool.name,
    ...(tool.description
      ? { description: tool.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS) }
      : {}),
    inputSchema: schemaTruncated ? { type: "object" } : tool.inputSchema,
    ...(schemaTruncated ? { schemaTruncated: true } : {}),
  };
}

function projectExternalMcpContent(
  server: string,
  tool: string,
  result: CallToolResult,
  mediaMaxBytes: number,
): { content: ExternalMcpProjectedContent; hasMedia: boolean } {
  const budget = createMediaBudget(mediaMaxBytes);
  const content: ExternalMcpProjectedContent = [];
  let hasMedia = false;
  for (const entry of result.content ?? []) {
    if (entry.type === "image") {
      hasMedia = true;
      if (!isSupportedImageMimeType(entry.mimeType)) {
        throw new ExternalMcpError(
          "media_unsupported",
          `External MCP ${server} tool ${tool} returned unsupported image MIME type ${entry.mimeType}.`,
        );
      }
      const bytes = strictBase64ByteLength(entry.data);
      if (bytes === undefined) {
        throw new ExternalMcpError(
          "media_malformed",
          `External MCP ${server} tool ${tool} returned malformed base64 image content.`,
        );
      }
      try {
        claimMediaBytes(budget, bytes);
      } catch {
        throw new ExternalMcpError(
          "media_too_large",
          `External MCP ${server} tool ${tool} returned media exceeding the configured ${mediaMaxBytes}-byte aggregate limit.`,
        );
      }
      content.push({ type: "image", mimeType: entry.mimeType, bytes });
      continue;
    }
    if (entry.type === "audio") {
      throw new ExternalMcpError(
        "media_unsupported",
        `External MCP ${server} tool ${tool} returned unsupported audio media content.`,
      );
    }
    if (entry.type === "resource" && "blob" in entry.resource && typeof entry.resource.blob === "string") {
      throw new ExternalMcpError(
        "media_unsupported",
        `External MCP ${server} tool ${tool} returned unsupported binary resource content.`,
      );
    }
    content.push(entry);
  }
  return { content, hasMedia };
}

function assertCallToolResult(server: string, tool: string, value: unknown): asserts value is CallToolResult {
  if (
    !isRecord(value)
    || !Array.isArray(value.content)
    || !CallToolResultSchema.safeParse(value).success
  ) {
    throw new ExternalMcpError(
      "unsupported_result",
      `External MCP ${server} tool ${tool} returned an unsupported result shape.`,
    );
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
