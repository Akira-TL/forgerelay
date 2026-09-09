import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ExternalMcpServerConfig,
  ExternalMcpServersConfig,
} from "../../runtime/config/external-mcp-config.js";

const MAX_DISCOVERED_TOOLS = 100;
const MAX_TOOL_DESCRIPTION_CHARS = 2_000;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_DISCOVERY_PAGES = 16;

export type ExternalMcpCapabilityInput =
  | { operation: "servers" }
  | { operation: "tools"; server: string }
  | { operation: "call"; server: string; tool: string; arguments?: Record<string, unknown> };

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
  content?: CallToolResult["content"];
  structuredContent?: Record<string, unknown>;
}

export class ExternalMcpError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExternalMcpError";
  }
}

export class ExternalMcpGateway {
  constructor(private readonly servers: ExternalMcpServersConfig) {}

  get available(): boolean {
    return Object.keys(this.servers).length > 0;
  }

  async run(input: ExternalMcpCapabilityInput, signal?: AbortSignal): Promise<ExternalMcpCapabilityResult> {
    signal?.throwIfAborted();
    switch (input.operation) {
      case "servers":
        return {
          operation: "servers",
          servers: Object.entries(this.servers)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, server]) => ({ name, transport: server.transport })),
        };
      case "tools":
        return this.withClient(input.server, signal, async (client) => {
          const discovery = await discoverTools(client, signal);
          return {
            operation: "tools",
            server: input.server,
            tools: discovery.tools.map(summarizeTool),
            ...(discovery.truncated ? { truncated: true } : {}),
          };
        });
      case "call":
        return this.withClient(input.server, signal, async (client) => {
          await assertRegisteredTool(client, input.server, input.tool, signal);
          const result = await client.callTool(
            { name: input.tool, arguments: input.arguments ?? {} },
            undefined,
            { signal },
          );
          assertCallToolResult(input.server, input.tool, result);
          if (result.isError) {
            throw new ExternalMcpError(
              "tool_failed",
              `External MCP ${input.server} tool ${input.tool} returned an upstream tool error.`,
            );
          }
          assertNonMediaResult(input.server, input.tool, result);
          return {
            operation: "call",
            server: input.server,
            tool: input.tool,
            content: result.content,
            ...(isRecord(result.structuredContent)
              ? { structuredContent: result.structuredContent }
              : {}),
          };
        });
    }
  }

  private async withClient<T>(
    name: string,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const config = this.servers[name];
    if (!config) throw new ExternalMcpError("unknown_server", `Unknown configured external MCP server: ${name}.`);
    const client = new Client({ name: "forgerelay-external-mcp", version: "1.0.0" });
    const transport = createTransport(config);
    try {
      signal?.throwIfAborted();
      await client.connect(transport);
      signal?.throwIfAborted();
      return await operation(client);
    } catch (error) {
      if (error instanceof ExternalMcpError) throw error;
      if (signal?.aborted) signal.throwIfAborted();
      throw new ExternalMcpError(
        "transport_failed",
        `External MCP ${name} request failed.`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function createTransport(config: ExternalMcpServerConfig) {
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
  });
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

function assertNonMediaResult(server: string, tool: string, result: CallToolResult): void {
  for (const entry of result.content ?? []) {
    if (entry.type === "image" || entry.type === "audio") {
      throw new ExternalMcpError(
        "media_not_enabled",
        `External MCP ${server} tool ${tool} returned media content before external media forwarding is enabled.`,
      );
    }
    if (entry.type === "resource" && "blob" in entry.resource && typeof entry.resource.blob === "string") {
      throw new ExternalMcpError(
        "media_not_enabled",
        `External MCP ${server} tool ${tool} returned binary resource content before external media forwarding is enabled.`,
      );
    }
  }
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
