import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
} from "../contract.js";
import {
  runExternalCommand,
  type ExternalCommandRunner,
} from "../runtime/external-command.js";
import { removeForgeRelayNodeModulesBinFromPath } from "../path.js";
import { asRecord, directString, requireFinalResponse } from "../shared.js";

export class ClaudeSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "claude" as const;

  constructor(
    private readonly runner: ExternalCommandRunner = runExternalCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const command = this.env.CLAUDE_COMMAND?.trim() || "claude";
    const result = await this.runner({
      command,
      args: claudeCommandArgs(input),
      cwd: input.workspace,
      env: claudeCommandEnvironment(this.env),
      signal: input.signal,
      stdin: input.prompt,
      label: "Claude",
    });
    const parsed = parseClaudeJsonOutput(result.stdout);
    if (parsed.error) throw new Error(parsed.error);
    return {
      provider: this.provider,
      providerSessionId: parsed.providerSessionId ?? input.providerSessionId ?? null,
      finalResponse: requireFinalResponse("Claude", parsed.finalResponse),
    };
  }
}

export function claudeCommandArgs(input: SubagentRunInput): string[] {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--effort", input.thinking);
  if (input.providerSessionId) args.push("--resume", input.providerSessionId);
  return args;
}

export function parseClaudeJsonOutput(output: string): {
  providerSessionId?: string;
  finalResponse: string;
  error?: string;
} {
  const records = parseJsonRecords(output);
  let providerSessionId: string | undefined;
  let finalResponse = "";
  let error: string | undefined;

  for (const record of records) {
    providerSessionId = directString(record.session_id) ?? providerSessionId;
    const resultError = claudeResultError(record);
    if (resultError) error = resultError;
    if (typeof record.result === "string") finalResponse = record.result;
  }
  return { providerSessionId, finalResponse, error };
}

function parseJsonRecords(output: string): Record<string, unknown>[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record));
    }
    const record = asRecord(parsed);
    return record ? [record] : [];
  } catch {
    const records: Record<string, unknown>[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        const record = asRecord(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        // Ignore non-JSON diagnostic lines; the command runner preserves stderr separately.
      }
    }
    return records;
  }
}

function claudeResultError(record: Record<string, unknown>): string | undefined {
  const subtype = directString(record.subtype);
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
  if (!env.CLAUDE_COMMAND && next.PATH) {
    next.PATH = removeForgeRelayNodeModulesBinFromPath(next.PATH);
  }
  return next;
}
