import type { ActivityLifecycle } from "../../../activity/lifecycle.js";
import type { CapabilityRegistryDependencies } from "../../../capability-registry.js";
import type { ServerConfig } from "../../../config.js";
import { SubagentSessionCapability } from "../capability.js";
import type { SubagentProviderRunner } from "../execution.js";

export interface SubagentMcpRuntimeOptions {
  subagentProviderRunner?: SubagentProviderRunner;
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
