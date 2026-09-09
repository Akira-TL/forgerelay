import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "forgerelay-external-mcp-fixture", version: "1.0.0" });

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
