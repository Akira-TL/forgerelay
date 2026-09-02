import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { subagentProviderContinuationSupported } from "./continuation.js";
import { removeForgeRelayNodeModulesBinFromPath } from "./path.js";
import {
  SUBAGENT_PROVIDERS,
  type SubagentProvider,
} from "../profiles.js";

export interface SubagentProviderAvailability {
  name: SubagentProvider;
  available: boolean;
  continuationSupported: boolean;
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
      return commandAvailability(provider, env.CODEX_COMMAND ?? "codex", {
        env: externalProviderEnvironment(env, "CODEX_COMMAND"),
      });
    case "claude":
      return commandAvailability(provider, env.CLAUDE_COMMAND ?? "claude", {
        env: externalProviderEnvironment(env, "CLAUDE_COMMAND"),
      });
    case "opencode":
      return commandAvailability(provider, env.OPENCODE_COMMAND ?? "opencode", {
        env: externalProviderEnvironment(env, "OPENCODE_COMMAND"),
      });
    case "pi":
      return commandAvailability(provider, env.PI_COMMAND ?? "pi", {
        env: externalProviderEnvironment(env, "PI_COMMAND"),
      });
    case "cursor":
      return commandAvailability(provider, "cursor-agent", { env });
    case "copilot":
      return commandAvailability(provider, "copilot", { env });
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
      continuationSupported: subagentProviderContinuationSupported(provider),
      reason: `${command} executable not found`,
    };
  }

  return {
    name: provider,
    available: true,
    continuationSupported: subagentProviderContinuationSupported(provider),
  };
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

function externalProviderEnvironment(
  env: NodeJS.ProcessEnv,
  explicitCommandKey: "CODEX_COMMAND" | "CLAUDE_COMMAND" | "OPENCODE_COMMAND" | "PI_COMMAND",
): NodeJS.ProcessEnv {
  if (env[explicitCommandKey] || !env.PATH) return env;
  return {
    ...env,
    PATH: removeForgeRelayNodeModulesBinFromPath(env.PATH),
  };
}
