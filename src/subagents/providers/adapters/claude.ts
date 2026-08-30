import { spawnSync } from "node:child_process";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
} from "../contract.js";
import { directString, linkedAbortController, requireFinalResponse } from "../shared.js";

export class ClaudeSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "claude" as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const claudeExecutable = process.env.CLAUDE_COMMAND ?? resolveExecutable("claude");
    const linkedAbort = linkedAbortController(input.signal);
    try {
      const messages = query({
        prompt: input.prompt,
        options: {
          cwd: input.workspace,
          model: input.model,
          ...(input.thinking ? { thinking: { type: "adaptive" } as const, effort: input.thinking as EffortLevel } : {}),
          resume: input.providerSessionId,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: claudeCommandEnvironment(process.env),
          ...(linkedAbort.controller ? { abortController: linkedAbort.controller } : {}),
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        },
      });

      let providerSessionId = input.providerSessionId ?? null;
      let finalResponse = "";
      for await (const message of messages) {
        const record = message as Record<string, unknown>;
        if (typeof record.session_id === "string") providerSessionId = record.session_id;
        if (record.type === "result" && typeof record.result === "string") {
          const resultError = claudeResultError(record);
          if (resultError) throw new Error(resultError);
          finalResponse = record.result;
        }
      }

      finalResponse = requireFinalResponse("Claude", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
      };
    } finally {
      linkedAbort.dispose();
    }
  }
}

function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
  const isError = record.is_error === true || subtype?.startsWith("error");
  if (!isError) return undefined;
  const message =
    directString(record.error) ??
    directString(record.message) ??
    directString(record.result) ??
    subtype ??
    "Claude returned an error result.";
  return `Claude returned an error result: ${message}`;
}

function resolveExecutable(command: string): string | undefined {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "command", [
    ...(process.platform === "win32" ? [command] : ["-v", command]),
  ], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  const executable = result.stdout?.split(/\r?\n/).find((line) => line.trim());
  return executable?.trim() || undefined;
}

export function claudeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_AGENT_SDK_VERSION",
  ]) {
    delete next[key];
  }
  return next;
}
