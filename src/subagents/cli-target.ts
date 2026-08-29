import {
  isSubagentProvider,
  SUBAGENT_PROVIDERS,
  type SubagentProfile,
  type SubagentProvider,
} from "./profiles.js";

export interface ParsedSubagentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
}

export type SubagentTarget =
  | {
      kind: "profile";
      name: string;
      provider: SubagentProvider;
      model?: string;
      thinking?: string;
      profile: SubagentProfile;
    }
  | {
      kind: "provider";
      name: SubagentProvider;
      provider: SubagentProvider;
      model?: string;
      thinking?: string;
    };

export function parseSubagentRunArgs(args: string[]): ParsedSubagentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error('Usage: forgerelay agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] "<prompt>"');
  }

  let model: string | undefined;
  let thinking: string | undefined;
  const promptParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (part === "--model") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = part.slice("--model=".length).trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      continue;
    }
    if (part === "--thinking") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --thinking.");
      thinking = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--thinking=")) {
      const value = part.slice("--thinking=".length).trim();
      if (!value) throw new Error("Missing value for --thinking.");
      thinking = value;
      continue;
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: forgerelay agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] "<prompt>"');
  }

  return { target, prompt, model, thinking };
}

export function resolveSubagentTarget(
  target: string,
  profiles: SubagentProfile[],
  modelOverride?: string,
  thinkingOverride?: string,
): SubagentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model,
      thinking: thinkingOverride ?? profile.thinking,
      profile,
    };
  }

  if (isSubagentProvider(target)) {
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride,
      thinking: thinkingOverride,
    };
  }

  return undefined;
}

export function formatAvailableSubagentTargets(profiles: SubagentProfile[]): string {
  const profileNames = profiles.map((profile) => profile.name);
  const parts = [
    profileNames.length > 0 ? `profiles: ${profileNames.join(", ")}` : undefined,
    `providers: ${SUBAGENT_PROVIDERS.join(", ")}`,
  ].filter(Boolean);
  return parts.join("; ");
}
