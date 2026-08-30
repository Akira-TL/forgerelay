import type { SubagentProvider } from "../profiles.js";

export type SubagentWriteMode = "read_only" | "allowed" | "full_access";

export interface SubagentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: SubagentWriteMode;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
}

export interface SubagentProviderAdapter {
  readonly provider: SubagentProvider;
  run(input: SubagentRunInput): Promise<SubagentRunResult>;
}
