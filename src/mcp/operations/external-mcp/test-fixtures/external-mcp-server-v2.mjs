import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(
  () => {
    const server = new McpServer({
      name: "forgerelay-external-mcp-v2-fixture",
      version: "1.0.0",
    });
    server.registerTool(
      "modern_echo",
      {
        description: "Echo one value over the modern MCP protocol era.",
        inputSchema: z.object({ message: z.string() }),
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `modern:${message}` }],
      }),
    );
    return server;
  },
  { legacy: "reject" },
);
