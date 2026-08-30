import type { SubagentProvider } from "../profiles.js";

const CONTINUATION_SUPPORT: Readonly<Record<SubagentProvider, boolean>> = {
  codex: true,
  claude: true,
  opencode: true,
  pi: true,
  cursor: false,
  copilot: false,
};

export function subagentProviderContinuationSupported(provider: SubagentProvider): boolean {
  return CONTINUATION_SUPPORT[provider];
}
