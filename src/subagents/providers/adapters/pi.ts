import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  SubagentProviderAdapter,
  SubagentRunInput,
  SubagentRunResult,
} from "../contract.js";
import { removeForgeRelayNodeModulesBinFromPath } from "../path.js";
import {
  asRecord,
  assertPipedChild,
  errorMessage,
  readArray,
  readNestedString,
  requireFinalResponse,
  terminateChildOnAbort,
  unwrapProviderPayload,
} from "../shared.js";

const PI_AGENT_TIMEOUT_MS = 120_000;
const PI_RPC_MAX_LINE_BYTES = 8 * 1024 * 1024;
const PI_RPC_STDERR_TAIL_BYTES = 128 * 1024;
const PI_STREAMING_TEXT_MAX_BYTES = 8 * 1024 * 1024;
const PI_ERROR_PREVIEW_BYTES = 4 * 1024;

export class PiRpcSubagentAdapter implements SubagentProviderAdapter {
  readonly provider = "pi" as const;

  async run(input: SubagentRunInput): Promise<SubagentRunResult> {
    const args = ["--mode", "rpc"];
    if (input.model) args.push("--model", input.model);
    if (input.thinking) args.push("--thinking", input.thinking);
    if (input.providerSessionId) args.push("--session", input.providerSessionId);
    const child = spawn(process.env.PI_COMMAND ?? "pi", args, {
      cwd: input.workspace,
      env: piCommandEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const detachAbort = terminateChildOnAbort(child, input.signal);
    const rpc = new JsonLineRpc(child);
    let streamingText = "";
    let streamingTextBytes = 0;
    let streamingProviderError = "";
    rpc.onEvent((event) => {
      const text = extractPiStreamingText([event]);
      if (text) {
        const nextBytes = streamingTextBytes + Buffer.byteLength(text, "utf8");
        if (nextBytes > PI_STREAMING_TEXT_MAX_BYTES) {
          rpc.fail(new Error(`Pi streaming response exceeded ${PI_STREAMING_TEXT_MAX_BYTES} bytes.`));
          child.kill();
          return;
        }
        streamingText += text;
        streamingTextBytes = nextBytes;
      }
      const providerError = extractPiProviderError(event);
      if (providerError) streamingProviderError = boundedUtf8Tail(providerError, PI_RPC_STDERR_TAIL_BYTES);
    });
    try {
      const state = await rpc.request({ type: "get_state" });
      const providerSessionId = readNestedString(state, ["sessionId"]) ?? input.providerSessionId ?? null;
      const done = rpc.waitForEvent(
        (event) => asRecord(event)?.type === "agent_end",
        PI_AGENT_TIMEOUT_MS,
        input.signal,
      );
      await rpc.request({ type: "prompt", message: input.prompt });
      const agentEnd = await done;
      const sessionMessages = await rpc.request({ type: "get_messages" });
      const finalResponse =
        extractPiFinalResponse(agentEnd) ||
        extractPiFinalResponse(sessionMessages) ||
        streamingText.trim();
      if (!finalResponse) {
        const providerError =
          extractPiProviderError(agentEnd) ||
          extractPiProviderError(sessionMessages) ||
          streamingProviderError;
        if (providerError) throw new Error(`Pi returned an error: ${providerError}`);
      }
      requireFinalResponse("Pi", finalResponse);
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse,
      };
    } finally {
      detachAbort();
      child.kill();
    }
  }
}

export function piCommandEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.PI_COMMAND) return env;
  const path = env.PATH;
  if (!path) return env;

  return {
    ...env,
    PATH: removeForgeRelayNodeModulesBinFromPath(path),
  };
}

export class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly eventSubscribers = new Set<(event: unknown) => void>();
  private readonly failureSubscribers = new Set<(error: Error) => void>();
  private buffer = "";
  private bufferBytes = 0;
  private nextId = 1;
  private stderr = "";
  private fatalError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = boundedUtf8Tail(`${this.stderr}${chunk.toString("utf8")}`, PI_RPC_STDERR_TAIL_BYTES);
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onEvent(callback: (event: unknown) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  fail(error: Error): void {
    this.failAll(error);
  }

  waitForEvent(
    predicate: (event: unknown) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        unsubscribe();
        unsubscribeFailure();
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => finish(() => {
        const error = new Error("Pi RPC cancelled.");
        error.name = "AbortError";
        reject(error);
      });
      const timer = setTimeout(() => finish(() => {
        reject(new Error(`Pi RPC timed out waiting for agent completion\n${this.stderr}`.trim()));
      }), timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return;
        finish(() => resolve(event));
      });
      const unsubscribeFailure = this.onFailure((error) => finish(() => reject(error)));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, "utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        if (this.bufferBytes > PI_RPC_MAX_LINE_BYTES) {
          const error = new Error(`Pi RPC line exceeded ${PI_RPC_MAX_LINE_BYTES} bytes.`);
          this.failAll(error);
          this.child.kill();
        }
        return;
      }
      const consumed = this.buffer.slice(0, newline + 1);
      const line = consumed.slice(0, -1).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferBytes = Math.max(0, this.bufferBytes - Buffer.byteLength(consumed, "utf8"));
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > PI_RPC_MAX_LINE_BYTES) {
        const error = new Error(`Pi RPC line exceeded ${PI_RPC_MAX_LINE_BYTES} bytes.`);
        this.failAll(error);
        this.child.kill();
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        const preview = boundedUtf8Tail(line, PI_ERROR_PREVIEW_BYTES);
        this.stderr = boundedUtf8Tail(`${this.stderr}${preview}\n`, PI_RPC_STDERR_TAIL_BYTES);
        this.failAll(new Error(`Pi RPC emitted malformed JSON on stdout: ${preview}`));
        this.child.kill();
        return;
      }
      if (message.type !== "response") {
        for (const subscriber of this.eventSubscribers) subscriber(message);
        continue;
      }

      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.success === false || message.error) {
        pending.reject(new Error(errorMessage(message.error ?? `Pi RPC request failed: ${message.command ?? id}`)));
      } else {
        pending.resolve(message.data ?? message.result ?? message);
      }
    }
  }

  private onFailure(callback: (error: Error) => void): () => void {
    this.failureSubscribers.add(callback);
    return () => this.failureSubscribers.delete(callback);
  }

  private failAll(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const subscriber of [...this.failureSubscribers]) subscriber(error);
  }
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

export function extractPiFinalResponse(value: unknown): string {
  const root = unwrapProviderPayload(value);
  const messages = Array.isArray(root) ? root : readArray(root, "messages");
  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const text = extractPiAssistantMessageText(message);
    if (text) return text;
  }
  return "";
}

export function extractPiStreamingText(events: unknown[]): string {
  return events
    .map((event) => {
      const record = asRecord(event);
      if (!record || record.type !== "message_update") return "";
      const update = asRecord(record.assistantMessageEvent);
      if (!update || update.type !== "text_delta") return "";
      return typeof update.delta === "string" ? update.delta : "";
    })
    .filter(Boolean)
    .join("")
    .trim();
}

export function extractPiProviderError(value: unknown): string {
  const root = unwrapProviderPayload(value);
  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);
      if (error) return error;
    }
    return "";
  }

  const messages = readArray(root, "messages");
  if (messages) return extractPiProviderError(messages);

  const message = asRecord(root)?.message ?? root;
  const record = asRecord(message);
  if (!record) return "";
  const error = record.errorMessage ?? record.error;
  return typeof error === "string" ? error.trim() : "";
}

function extractPiAssistantMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
