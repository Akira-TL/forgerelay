import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
  SubagentWriteMode,
} from "../contract.js";
import {
  runExternalCommand,
  type ExternalCommandRunner,
} from "../runtime/external-command.js";
import { removeForgeRelayNodeModulesBinFromPath } from "../path.js";
import { asRecord, directString, requireFinalResponse } from "../shared.js";

export class CodexSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "codex" as const;

  constructor(
    private readonly runner: ExternalCommandRunner = runExternalCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const command = this.env.CODEX_COMMAND?.trim() || "codex";
    const result = await this.runner({
      command,
      args: codexCommandArgs(input),
      cwd: input.workspace,
      env: codexCommandEnvironment(this.env),
      signal: input.signal,
      stdin: input.prompt,
      label: "Codex",
    });
    const parsed = parseCodexJsonLines(result.stdout);
    if (parsed.error) throw new Error(`Codex returned an error: ${parsed.error}`);
    if (
      input.providerSessionId &&
      parsed.providerSessionId &&
      parsed.providerSessionId !== input.providerSessionId
    ) {
      throw new Error(
        `Codex resume returned a different session id (${parsed.providerSessionId}) than requested (${input.providerSessionId}).`,
      );
    }
    return {
      provider: this.provider,
      providerSessionId: parsed.providerSessionId ?? input.providerSessionId ?? null,
      finalResponse: requireFinalResponse("Codex", parsed.finalResponse),
    };
  }
}

export function codexCommandArgs(input: SubagentRunInput): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    codexSandboxMode(input.writeMode),
    "--cd",
    input.workspace,
    "--config",
    'approval_policy="never"',
  ];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(input.thinking)}`);
  }
  if (input.providerSessionId) args.push("resume", input.providerSessionId);
  return args;
}

function codexSandboxMode(writeMode: SubagentWriteMode | undefined): string {
  switch (writeMode) {
    case "allowed":
      return "workspace-write";
    case "full_access":
      return "danger-full-access";
    case "read_only":
    case undefined:
      return "read-only";
  }
}

export function codexCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CODEX_COMMAND || !env.PATH) return { ...env };
  return {
    ...env,
    PATH: removeForgeRelayNodeModulesBinFromPath(env.PATH),
  };
}

export function parseCodexJsonLines(output: string): {
  providerSessionId?: string;
  finalResponse: string;
  error?: string;
} {
  let providerSessionId: string | undefined;
  let finalResponse = "";
  let error: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (!record) continue;
      event = record;
    } catch {
      continue;
    }

    if (event.type === "thread.started") {
      providerSessionId = directString(event.thread_id) ?? providerSessionId;
      continue;
    }
    if (event.type === "item.completed") {
      const item = asRecord(event.item);
      if (item?.type === "agent_message") {
        finalResponse = directString(item.text) ?? finalResponse;
      }
      continue;
    }
    if (event.type === "turn.failed") {
      const failure = asRecord(event.error);
      error = directString(failure?.message) ?? directString(event.message) ?? error;
      continue;
    }
    if (event.type === "error") {
      const nested = asRecord(event.error);
      error = directString(event.message) ?? directString(nested?.message) ?? error;
    }
  }

  return { providerSessionId, finalResponse, error };
}
