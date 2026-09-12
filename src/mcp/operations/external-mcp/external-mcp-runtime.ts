import type { ServerConfig } from "../../../runtime/config/config.js";
import { ExternalMcpConfigRegistry } from "../../../runtime/config/external-mcp-registry.js";
import { ExternalMcpCredentialStore } from "../../../runtime/config/external-mcp-auth-store.js";
import { logEvent } from "../../../runtime/logging/logger.js";
import { CapabilityError, type CapabilityRegistryDependencies } from "../../server/core/capability-registry.js";
import {
  requireCapabilityProject,
  requireCapabilityWorkspaceRoot,
} from "../../server/core/capability-support.js";
import {
  ExternalMcpTransformError,
  ExternalMcpTransformRunner,
} from "../../hooks/external-mcp-transform.js";
import { ExternalMcpError, ExternalMcpGateway } from "./external-mcp.js";

export function createExternalMcpCapabilityRuntime(
  config: ServerConfig,
): NonNullable<CapabilityRegistryDependencies["externalMcp"]> {
  const credentialStore = new ExternalMcpCredentialStore({ configDir: config.configDir });
  const externalMcp = new ExternalMcpGateway(config.mediaMaxBytes, credentialStore);
  const registry = new ExternalMcpConfigRegistry({
    configDir: config.configDir,
    legacyServers: config.mcpServers,
    onDiagnostic: (diagnostic) => logEvent(config.logging, "warn", "external_mcp_config_invalid", {
      source: diagnostic.source,
      path: diagnostic.path,
      reason: diagnostic.message,
    }),
  });
  const transforms = new ExternalMcpTransformRunner(
    config.hooks,
    config.logging,
    process.env,
    config.commandShellRuntime,
    config.mediaMaxBytes,
  );

  return {
    available: true,
    run: async (input, context, runOptions) => {
      try {
        const workspaceRoot = requireCapabilityWorkspaceRoot(context);
        const project = requireCapabilityProject(context);
        const snapshot = registry.resolve(project);
        const transformContext = (server: string, tool: string) => ({
          workspaceId: context.workspaceId,
          workspaceRoot,
          workspaceMode: context.workspaceMode,
          server,
          tool,
        });
        const result = await externalMcp.run(
          snapshot.servers,
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
          {
            project: { id: project.id, projectRoot: project.projectRoot },
            origins: snapshot.origins,
          },
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
