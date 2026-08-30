import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { removeDevspaceNodeModulesBinFromPath } from "./path.js";
import {
  SUBAGENT_PROVIDERS,
  type SubagentProvider,
} from "../profiles.js";

export interface SubagentProviderAvailability {
  name: SubagentProvider;
  available: boolean;
  reason?: string;
}

export function getSubagentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
): SubagentProviderAvailability[] {
  return SUBAGENT_PROVIDERS.map((provider) => checkSubagentProviderAvailability(provider, env));
}

export function checkSubagentProviderAvailability(
  provider: SubagentProvider,
  env: NodeJS.ProcessEnv = process.env,
): SubagentProviderAvailability {
  switch (provider) {
    case "codex":
      return packageAvailability(provider, "@openai/codex-sdk");
    case "claude":
      return packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
    case "opencode":
      return packageAvailability(provider, "@opencode-ai/sdk/v2");
    case "pi":
      return commandAvailability(provider, env.PI_COMMAND ?? "pi", {
        env: piAvailabilityEnvironment(env),
      });
    case "cursor":
      return commandAvailability(provider, "cursor-agent");
    case "copilot":
      return commandAvailability(provider, "copilot");
  }
}

export function assertSubagentProviderAvailable(
  provider: SubagentProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const availability = checkSubagentProviderAvailability(provider, env);
  if (availability.available) return;
  throw new Error(
    `${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

export function formatUnavailableSubagentProvider(provider: SubagentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

export function formatSubagentProviderAvailabilitySummary(
  providers: SubagentProviderAvailability[],
): string {
  const available = providers
    .filter((provider) => provider.available)
    .map((provider) => provider.name);
  const unavailable = providers
    .filter((provider) => !provider.available)
    .map((provider) => `${provider.name} (${provider.reason ?? "unavailable"})`);
  return [
    available.length > 0 ? `available: ${available.join(", ")}` : undefined,
    unavailable.length > 0 ? `unavailable: ${unavailable.join(", ")}` : undefined,
  ].filter(Boolean).join("; ");
}

function packageAvailability(
  provider: SubagentProvider,
  packageName: string,
): SubagentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: provider, available: true };
  } catch {
    return {
      name: provider,
      available: false,
      reason: `${packageName} package not found`,
    };
  }
}

function commandAvailability(
  provider: SubagentProvider,
  command: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): SubagentProviderAvailability {
  const executable = resolveCommand(command, options.env);
  if (!executable) {
    return {
      name: provider,
      available: false,
      reason: `${command} executable not found`,
    };
  }

  return { name: provider, available: true };
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const commandHasPath = command.includes("/") || command.includes("\\");
  if (commandHasPath) return executableExists(command, env) ? command : undefined;

  for (const candidate of candidateCommandPaths(command, env)) {
    if (executableExists(candidate, env)) return candidate;
  }
  return undefined;
}

function candidateCommandPaths(command: string, env: NodeJS.ProcessEnv): string[] {
  const path = env.PATH;
  if (!path) return [];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  const candidates: string[] = [];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      candidates.push(resolve(directory, `${command}${extension}`));
    }
  }
  return candidates;
}

function executableExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000,
  });
  const code = typeof result.error === "object" && result.error && "code" in result.error
    ? result.error.code
    : undefined;
  return code !== "ENOENT";
}

function piAvailabilityEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;
  return {
    ...env,
    PATH: removeDevspaceNodeModulesBinFromPath(path),
  };
}
