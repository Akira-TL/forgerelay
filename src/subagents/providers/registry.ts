import type { SubagentProvider } from "../profiles.js";
import { AcpSubagentAdapter } from "./adapters/acp.js";
import { ClaudeSubagentAdapter } from "./adapters/claude.js";
import { CodexSubagentAdapter } from "./adapters/codex.js";
import { extractOpenCodeFinalResponse, OpencodeSubagentAdapter } from "./adapters/opencode.js";
import {
  extractPiFinalResponse,
  PiRpcSubagentAdapter,
} from "./adapters/pi.js";
import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
} from "./contract.js";

export async function runSubagentProvider(
  provider: SubagentProvider,
  input: SubagentRunInput,
): Promise<SubagentRunResult> {
  return createSubagentProviderAdapter(provider).run(input);
}

export function createSubagentProviderAdapter(provider: SubagentProvider): SubagentProviderAdapter {
  switch (provider) {
    case "codex":
      return new CodexSubagentAdapter();
    case "claude":
      return new ClaudeSubagentAdapter();
    case "opencode":
      return new OpencodeSubagentAdapter();
    case "pi":
      return new PiRpcSubagentAdapter();
    case "cursor":
    case "copilot":
      return new AcpSubagentAdapter(provider);
  }
}

export function extractSubagentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}
