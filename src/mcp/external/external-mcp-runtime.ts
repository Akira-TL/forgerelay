import type { ServerConfig } from "../../runtime/config/config.js";
import { CapabilityError, type CapabilityRegistryDependencies } from "../server/core/capability-registry.js";
import { requireCapabilityWorkspaceRoot } from "../server/core/capability-support.js";
import {
  ExternalMcpTransformError,
  ExternalMcpTransformRunner,
} from "../hooks/external-mcp-transform.js";
import { ExternalMcpError, ExternalMcpGateway } from "./external-mcp.js";

export function createExternalMcpCapabilityRuntime(
  config: ServerConfig,
): NonNullable<CapabilityRegistryDependencies["externalMcp"]> {
  const externalMcp = new ExternalMcpGateway(config.mcpServers, config.mediaMaxBytes);
  const transforms = new ExternalMcpTransformRunner(
    config.hooks,
    config.logging,
    process.env,
    config.commandShellRuntime,
    config.mediaMaxBytes,
  );

  return {
    available: externalMcp.available,
    unavailableReason: externalMcp.available ? undefined : "No external MCP servers are configured.",
    run: async (input, context, runOptions) => {
      try {
        const transformContext = (server: string, tool: string) => ({
          workspaceId: context.workspaceId,
          workspaceRoot: requireCapabilityWorkspaceRoot(context),
          workspaceMode: context.workspaceMode,
          server,
          tool,
        });
        const result = await externalMcp.run(
          input,
          runOptions.signal,
          input.operation === "call"
            ? {
                request: (server, tool, arguments_) => transforms.transformRequest(
                  transformContext(server, tool),
                  arguments_,
                  runOptions.signal,
                ),
                result: (server, tool, externalResult) => transforms.transformResult(
                  transformContext(server, tool),
                  externalResult,
                  runOptions.signal,
                ),
              }
            : undefined,
        );
        return {
          value: result.value,
          ...(result.content ? { content: result.content } : {}),
        };
      } catch (error) {
        if (error instanceof ExternalMcpTransformError) {
          throw new CapabilityError("mcp.transform_failed", error.message);
        }
        if (error instanceof ExternalMcpError) {
          throw new CapabilityError(`mcp.${error.code}`, error.message);
        }
        throw error;
      }
    },
  };
}
