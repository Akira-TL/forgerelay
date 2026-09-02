import type { ActivityOutcome } from "../../activity/lifecycle.js";
import { ActivityLifecycle } from "../../activity/lifecycle.js";
import {
  BashOutputStore,
  type BashOutputMetadata,
  type BashOutputRecord,
} from "../../activity/bash-output-store.js";
import type { ProcessManager, CompletedProcessSnapshot, ProcessSnapshot } from "../../process-sessions.js";

const PROCESS_RESPONSE_OUTPUT_LINES = 10;

type ToolContent = { type: "text"; text: string };

export type ProcessToolResponse = ReturnType<typeof processToolResponse>;

export function attachCompletedProcessNotices<T>(
  processSessions: ProcessManager,
  workspaceId: string,
  result: T,
  onCompleted?: (snapshot: CompletedProcessSnapshot) => void,
): T {
  if (result instanceof Error) {
    const completed = processSessions.takeCompleted(workspaceId);
    for (const snapshot of completed) onCompleted?.(snapshot);
    if (completed.length > 0) {
      result.message = [
        result.message,
        ...completed.map((snapshot) => completedProcessResult(snapshot)),
      ].join("\n\n");
    }
    return result;
  }
  if (typeof result !== "object" || result === null) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;

  const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  const currentProcessId = structured?.running === true
    ? typeof structured.processId === "number"
      ? structured.processId
      : typeof structured.sessionId === "number"
        ? structured.sessionId
        : undefined
    : undefined;
  const completed = processSessions.takeCompleted(workspaceId, undefined, currentProcessId);
  for (const snapshot of completed) onCompleted?.(snapshot);
  if (completed.length === 0) return result;

  return {
    ...result,
    content: [
      ...content,
      ...completed.map((snapshot) => textBlock(completedProcessResult(snapshot))),
    ],
  } as T;
}

export function processToolResponse(
  tool: "bash" | "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const compact = compactProcessOutput(snapshot.output);
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(compact.output ? [textBlock(compact.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      processId: snapshot.processId,
      sessionId: snapshot.sessionId,
      outputId: snapshot.outputId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      timedOut: snapshot.timedOut,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated || compact.truncated,
    },
  };
}

export function durableOutputResponse(
  tool: "bash" | "write_stdin",
  workspaceId: string,
  record: BashOutputRecord,
) {
  const result = durableOutputResult(record);
  const content = [textBlock(result)];
  const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
  const startedAt = Date.parse(record.startedAt);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: textSummary(record.output ? [textBlock(record.output)] : []),
        payload: { content },
      },
    },
    structuredContent: {
      result,
      processId: record.processId,
      sessionId: record.processId,
      outputId: record.outputId,
      running: record.status === "running",
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      wallTimeMs: Math.max(0, Number.isFinite(finishedAt - startedAt) ? finishedAt - startedAt : 0),
      outputTruncated: false,
    },
  };
}

export function readWorkspaceBashOutput(
  store: BashOutputStore,
  workspaceId: string,
  outputId: string,
): BashOutputRecord {
  const record = store.read(outputId);
  if (!record) throw new Error(`Unknown Bash output: ${outputId}`);
  if (record.workspaceId !== workspaceId) {
    throw new Error(`Bash output ${outputId} does not belong to workspace ${workspaceId}.`);
  }
  return record;
}

export function markReturnedOutput(store: BashOutputStore, result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return;
  const record = structured as { running?: unknown; outputId?: unknown };
  if (record.running === true && typeof record.outputId === "string") {
    store.markReturned(record.outputId);
  }
}

export function recordBashCompletion(
  lifecycle: ActivityLifecycle,
  store: BashOutputStore,
  outputId: string | undefined,
): void {
  if (!outputId) return;
  const completion = store.claimCompletion(outputId);
  if (!completion) return;
  lifecycle.recordLinked({
    sourceActivityId: completion.activityId,
    tool: "bash_result",
    request: {
      processId: completion.processId,
      outputId: completion.outputId,
    },
    result: {
      processId: completion.processId,
      outputId: completion.outputId,
      exitCode: completion.exitCode,
      signal: completion.signal,
      timedOut: completion.timedOut,
    },
    outcome: completion.status === "failed"
      ? { type: "failed", error: bashCompletionError(completion) }
      : { type: "succeeded" },
  });
}

export function processActivityOutcome(result: unknown): ActivityOutcome {
  if (toolResultIsError(result)) return { type: "failed", error: activityFailureMessage(result) };
  if (typeof result !== "object" || result === null) return { type: "succeeded" };
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return { type: "succeeded" };
  const process = structured as {
    running?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    timedOut?: unknown;
  };
  if (process.running === true) return { type: "returned" };
  if (
    process.timedOut === true ||
    typeof process.signal === "string" ||
    (typeof process.exitCode === "number" && process.exitCode !== 0)
  ) {
    return { type: "failed", error: activityFailureMessage(result) };
  }
  return { type: "succeeded" };
}

export function toolResultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

function compactProcessOutput(output: string): { output: string; truncated: boolean } {
  if (!output) return { output: "", truncated: false };
  const trailingNewline = output.endsWith("\n");
  const body = trailingNewline ? output.slice(0, -1) : output;
  const lines = body.split("\n");
  if (lines.length <= PROCESS_RESPONSE_OUTPUT_LINES) return { output, truncated: false };
  const compact = lines.slice(-PROCESS_RESPONSE_OUTPUT_LINES).join("\n");
  return {
    output: trailingNewline ? `${compact}\n` : compact,
    truncated: true,
  };
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with process ID ${snapshot.processId}.`
    : snapshot.timedOut
      ? "Process timed out and was terminated."
      : snapshot.signal
        ? `Process exited after signal ${snapshot.signal}.`
        : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const compact = compactProcessOutput(snapshot.output).output.replace(/\n$/, "");
  return [compact, status, outputIdNotice(snapshot.outputId)].filter(Boolean).join("\n");
}

function completedProcessResult(snapshot: CompletedProcessSnapshot): string {
  const status = snapshot.timedOut
    ? `Background process ${snapshot.processId} timed out and was terminated.`
    : snapshot.signal
      ? `Background process ${snapshot.processId} exited after signal ${snapshot.signal}.`
      : `Background process ${snapshot.processId} exited with code ${snapshot.exitCode ?? "unknown"}.`;
  const command = `Command: ${snapshot.command}`;
  const output = compactProcessOutput(snapshot.output).output.replace(/\n$/, "");
  return [status, command, output, outputIdNotice(snapshot.outputId)].filter(Boolean).join("\n");
}

function outputIdNotice(outputId: string | undefined): string {
  return outputId ? `Full output ID: ${outputId}.` : "";
}

function durableOutputResult(record: BashOutputRecord): string {
  const status = record.status === "running"
    ? `Process ${record.processId} is still running.`
    : record.timedOut
      ? `Process ${record.processId} timed out and was terminated.`
      : record.signal
        ? `Process ${record.processId} exited after signal ${record.signal}.`
        : `Process ${record.processId} exited with code ${record.exitCode ?? "unknown"}.`;
  return [record.output.replace(/\n$/, ""), status, `Full output ID: ${record.outputId}.`]
    .filter(Boolean)
    .join("\n");
}

function bashCompletionError(record: BashOutputMetadata): string {
  if (record.error) return record.error;
  if (record.timedOut) return `Background process ${record.processId} timed out.`;
  if (record.signal) return `Background process ${record.processId} exited after signal ${record.signal}.`;
  return `Background process ${record.processId} exited with code ${record.exitCode ?? "unknown"}.`;
}

function activityFailureMessage(result: unknown): string {
  if (typeof result !== "object" || result === null) return "Tool returned a failed result.";
  const record = result as { content?: unknown; structuredContent?: unknown };
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return "";
        const value = (entry as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (typeof record.structuredContent === "object" && record.structuredContent !== null) {
    const value = (record.structuredContent as { result?: unknown }).result;
    if (typeof value === "string" && value) return value;
  }
  return "Tool returned a failed result.";
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): { lines: number; characters: number } {
  const text = content.map((item) => item.text).join("\n");
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}
