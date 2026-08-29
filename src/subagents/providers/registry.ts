import type { LocalAgentProvider } from "../profiles.js";
import { AcpLocalAgentAdapter } from "./adapters/acp.js";
import { ClaudeLocalAgentAdapter } from "./adapters/claude.js";
import { CodexLocalAgentAdapter } from "./adapters/codex.js";
import { extractOpenCodeFinalResponse, OpencodeLocalAgentAdapter } from "./adapters/opencode.js";
import {
  extractPiFinalResponse,
  PiRpcLocalAgentAdapter,
} from "./adapters/pi.js";
import type {
  LocalAgentAdapter,
  LocalAgentRunInput,
  LocalAgentRunResult,
} from "./contract.js";

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input);
}

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider);
  }
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}
