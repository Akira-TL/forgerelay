import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.FORGERELAY_FIXTURE_START_COUNT_FILE) {
  appendFileSync(process.env.FORGERELAY_FIXTURE_START_COUNT_FILE, `${process.pid}\n`);
}

const server = new McpServer({ name: "forgerelay-external-mcp-fixture", version: "1.0.0" });
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcXcAAAAASUVORK5CYII=";
const MALFORMED_IMAGE_DATA = "RVhURVJOQUxfTUNQX01BTEZPUk1FRF9TRU5USU5FTCE";

server.registerTool(
  "echo_text",
  {
    description: "Echo one text value.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo:${message}` }],
  }),
);

server.registerTool(
  "path_only",
  {
    description: "Return a file path as plain text.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "renders/output.png" }],
  }),
);

server.registerTool(
  "url_only",
  {
    description: "Return a URL as plain text.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "https://renderer.invalid/renders/output.png" }],
  }),
);

server.registerTool(
  "resource_only",
  {
    description: "Return one MCP resource link without dereferencing it.",
    inputSchema: {},
  },
  async () => ({
    content: [{
      type: "resource_link",
      name: "render-output",
      uri: "file:///renders/output.png",
      mimeType: "image/png",
    }],
  }),
);

server.registerTool(
  "direct_image",
  {
    description: "Return ordered text plus one supported direct image.",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "text", text: "before-image" },
      { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
      { type: "text", text: "after-image" },
    ],
    structuredContent: { duplicateImageData: IMAGE_BASE64 },
  }),
);

server.registerTool(
  "double_image",
  {
    description: "Return two supported images to exercise aggregate media limits.",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
      { type: "image", data: IMAGE_BASE64, mimeType: "image/png" },
    ],
  }),
);

server.registerTool(
  "malformed_image",
  {
    description: "Return malformed direct image base64.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "image", data: MALFORMED_IMAGE_DATA, mimeType: "image/png" }],
  }),
);

server.registerTool(
  "unsupported_image",
  {
    description: "Return a direct image using an unsupported MIME type.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "image", data: IMAGE_BASE64, mimeType: "image/svg+xml" }],
  }),
);

server.registerTool(
  "fail",
  {
    description: "Return one upstream tool error that echoes its input.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `fixture upstream failure:${message}` }],
    isError: true,
  }),
);

await server.connect(new StdioServerTransport());
