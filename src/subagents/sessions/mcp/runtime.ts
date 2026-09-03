import type { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import type { CapabilityRegistryDependencies } from "../../../mcp/server/core/capability-registry.js";
import type { ServerConfig } from "../../../runtime/config/config.js";
import { SubagentSessionCapability } from "../capability.js";
import type { SubagentProviderRunner } from "../execution.js";
import type { SubagentRunSummary } from "../store.js";

export interface SubagentMcpRuntimeOptions {
  subagentProviderRunner?: SubagentProviderRunner;
  subagentOwnerAlive?: (run: SubagentRunSummary) => boolean;
}

export interface SubagentMcpRuntime {
  registryDependencies: Pick<CapabilityRegistryDependencies, "subagentSession"> | Record<never, never>;
  decorateResult<T>(workspaceId: string, result: T): T;
}

export function createSubagentMcpRuntime(
  config: ServerConfig,
  activityLifecycle: ActivityLifecycle,
  options: SubagentMcpRuntimeOptions = {},
): SubagentMcpRuntime {
  const capability = config.subagents
    ? new SubagentSessionCapability(config, activityLifecycle, {
        providerRunner: options.subagentProviderRunner,
        ownerAlive: options.subagentOwnerAlive,
      })
    : undefined;
  return {
    registryDependencies: capability
      ? {
          subagentSession: {
            available: true,
            run: (input, context, runOptions) => capability.run(input, context, runOptions),
          },
        }
      : {},
    decorateResult: (workspaceId, result) => capability?.decorateResult(workspaceId, result) ?? result,
  };
}
