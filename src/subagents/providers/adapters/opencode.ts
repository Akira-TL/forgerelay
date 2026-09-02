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
import {
  asRecord,
  directString,
  readArray,
  requireFinalResponse,
  unwrapProviderPayload,
} from "../shared.js";

export class OpencodeSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "opencode" as const;

  constructor(
    private readonly runner: ExternalCommandRunner = runExternalCommand,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const command = this.env.OPENCODE_COMMAND?.trim() || "opencode";
    const commandEnv = opencodeCommandEnvironment(this.env);
    const result = await this.runner({
      command,
      args: opencodeCommandArgs(input),
      cwd: input.workspace,
      env: commandEnv,
      signal: input.signal,
      stdin: input.prompt,
      label: "OpenCode",
    });
    const streamed = parseOpenCodeJsonLines(result.stdout);
    const providerSessionId = streamed.providerSessionId ?? input.providerSessionId ?? null;
    let finalResponse = streamed.finalResponse;

    if (!finalResponse && providerSessionId) {
      const exported = await this.runner({
        command,
        args: ["export", providerSessionId],
        cwd: input.workspace,
        env: commandEnv,
        signal: input.signal,
        label: "OpenCode export",
      });
      finalResponse = extractOpenCodeExportFinalResponse(exported.stdout);
    }

    return {
      provider: this.provider,
      providerSessionId,
      finalResponse: requireFinalResponse("OpenCode", finalResponse),
    };
  }
}

export function opencodeCommandArgs(input: SubagentRunInput): string[] {
  const args = [
    "run",
    "--format",
    "json",
    "--dir",
    input.workspace,
    "--dangerously-skip-permissions",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.thinking) args.push("--variant", input.thinking);
  if (input.providerSessionId) args.push("--session", input.providerSessionId);
  return args;
}

export function opencodeCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.OPENCODE_COMMAND || !env.PATH) return { ...env };
  return {
    ...env,
    PATH: removeForgeRelayNodeModulesBinFromPath(env.PATH),
  };
}

export function parseOpenCodeJsonLines(output: string): {
  providerSessionId?: string;
  finalResponse: string;
} {
  let providerSessionId: string | undefined;
  const textByMessage = new Map<string, string[]>();
  const messageOrder: string[] = [];
  let fallback = "";
  let anonymousIndex = 0;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      if (!parsed) continue;
      record = parsed;
    } catch {
      continue;
    }

    providerSessionId =
      directString(record.sessionID) ??
      directString(record.sessionId) ??
      providerSessionId;

    if (record.type === "text") {
      const part = asRecord(record.part);
      const text = typeof part?.text === "string" ? part.text : undefined;
      if (!text) continue;
      const messageId =
        directString(part?.messageID) ??
        directString(part?.messageId) ??
        `anonymous-${anonymousIndex++}`;
      if (!textByMessage.has(messageId)) {
        textByMessage.set(messageId, []);
        messageOrder.push(messageId);
      }
      textByMessage.get(messageId)!.push(text);
      continue;
    }

    const extracted = extractOpenCodeFinalResponse(record);
    if (extracted) fallback = extracted;
  }

  const lastMessageId = messageOrder.at(-1);
  const finalResponse = lastMessageId
    ? (textByMessage.get(lastMessageId) ?? []).join("").trim()
    : fallback;
  return { providerSessionId, finalResponse };
}

function extractOpenCodeExportFinalResponse(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";
  try {
    return extractOpenCodeFinalResponse(JSON.parse(trimmed));
  } catch {
    return "";
  }
}

export function extractOpenCodeFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (messages) return extractLastOpenCodeAssistantMessageText(messages);
  return extractOpenCodeAssistantMessageText(root);
}

function extractLastOpenCodeAssistantMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const info = asRecord(message.info);
    const role = typeof info?.role === "string" ? info.role : message.role;
    const type = typeof message.type === "string" ? message.type : undefined;
    if (role !== "assistant" && type !== "assistant") continue;
    const text = extractOpenCodeAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

function extractOpenCodeAssistantMessageText(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";

  const content = readArray(message, "content");
  if (content) {
    const text = content
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const parts = readArray(message, "parts");
  if (parts) {
    const text = parts
      .map((part) => {
        const partRecord = asRecord(part);
        if (!partRecord || partRecord.type !== "text") return "";
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text.trim()) return text.trim();
  }

  const info = asRecord(message.info) ?? message;
  return stringifyStructuredAssistantMessage(info.structured);
}

function stringifyStructuredAssistantMessage(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}
