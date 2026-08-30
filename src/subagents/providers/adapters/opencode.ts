import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
} from "../contract.js";
import {
  asRecord,
  readArray,
  readNestedString,
  requireFinalResponse,
  unwrapProviderPayload,
} from "../shared.js";

export class OpencodeSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "opencode" as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const { client, server } = await createOpencode();
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(client, input);
      let abortPromise: Promise<void> | undefined;
      const abort = () => {
        abortPromise ??= abortOpencodeSession(client, sessionId, input.workspace);
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      try {
        input.signal?.throwIfAborted();
        const promptResult = await promptOpencodeSession(client, sessionId, input);
        await waitForOpencodeSession(client, sessionId, input.signal);
        const messages = await readOpencodeMessages(client, sessionId, input.signal);
        const finalResponse = requireFinalResponse(
          "OpenCode",
          extractOpenCodeFinalResponse(messages) || extractOpenCodeFinalResponse(promptResult),
        );
        return {
          provider: this.provider,
          providerSessionId: sessionId,
          finalResponse,
        };
      } finally {
        input.signal?.removeEventListener("abort", abort);
        if (abortPromise) await abortPromise;
      }
    } finally {
      server.close();
    }
  }
}

async function createOpencodeSession(client: unknown, input: SubagentRunInput): Promise<string> {
  const sessionClient = client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  };
  const result = await sessionClient.session.create({
    directory: input.workspace,
    location: { directory: input.workspace },
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
  }, { throwOnError: true, signal: input.signal });
  const id =
    readNestedString(result, ["id"]) ??
    readNestedString(result, ["data", "id"]) ??
    readNestedString(result, ["session", "id"]) ??
    readNestedString(result, ["data", "session", "id"]);
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

async function promptOpencodeSession(
  client: unknown,
  sessionId: string,
  input: SubagentRunInput,
): Promise<unknown> {
  const session = (client as {
    session: {
      prompt(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session;

  const promptInput = {
    sessionID: sessionId,
    directory: input.workspace,
    prompt: { parts: [{ type: "text", text: input.prompt }] },
    parts: [{ type: "text", text: input.prompt }],
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
    ...(input.thinking ? { variant: input.thinking } : {}),
  };
  return session.prompt(promptInput, { throwOnError: true, signal: input.signal });
}

async function waitForOpencodeSession(
  client: unknown,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const session = (client as {
    session?: { wait?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.wait) return;
  await session.wait({ sessionID: sessionId }, { throwOnError: true, signal });
}

async function readOpencodeMessages(
  client: unknown,
  sessionId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const session = (client as {
    session?: {
      messages?: (parameters?: unknown, options?: unknown) => Promise<unknown>;
    };
  }).session;
  if (!session?.messages) return undefined;
  return session.messages(
    { sessionID: sessionId, order: "asc", limit: 100 },
    { throwOnError: true, signal },
  );
}

async function abortOpencodeSession(client: unknown, sessionId: string, workspace: string): Promise<void> {
  const session = (client as {
    session?: { abort?: (parameters?: unknown, options?: unknown) => Promise<unknown> };
  }).session;
  if (!session?.abort) return;
  try {
    await session.abort(
      { sessionID: sessionId, directory: workspace },
      { throwOnError: true },
    );
  } catch {
    // The prompt request may already have observed the AbortSignal and closed the local server.
  }
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
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
