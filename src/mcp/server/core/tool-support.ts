import { resolve } from "node:path";
import type { ServerConfig } from "../../../runtime/config/config.js";
import { commandPreview, logEvent, workspaceLogLabel } from "../../../runtime/logging/logger.js";
import { formatAgentsPath, type Workspace, type WorkspaceRegistry } from "../../../workspaces.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface DiffStats {
  additions: number;
  removals: number;
}

export interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  workspace?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  exitCode?: number;
  running?: boolean;
  processId?: number;
  capability?: string;
  action?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export function workspaceLogContext(
  workspace: Workspace,
  _transportSessionId?: string,
): Pick<ToolLogFields, "workspaceId" | "workspace"> {
  return {
    workspaceId: workspace.id,
    workspace: workspaceLogLabel(workspace.root, workspace.id),
  };
}

export function formatDiscoveredWorkspaceInstructions(
  files: Array<{ path: string; content: string }>,
  workspaceRoot: string,
): string {
  return [
    "Workspace instructions discovered for this path. Apply them to follow-up work under their directories:",
    ...files.flatMap((file) => [
      `--- ${formatAgentsPath(file.path, workspaceRoot)} ---`,
      file.content.trimEnd(),
    ]),
  ].join("\n");
}

export async function assertWorkspaceInstructionsLoadedBeforeSideEffect(
  workspaces: WorkspaceRegistry,
  workspace: Workspace,
  paths: string[],
): Promise<void> {
  const discovered = new Map<string, { path: string; content: string }>();
  for (const path of paths) {
    const absolutePath = resolve(workspace.root, path);
    for (const file of await workspaces.discoverPathInstructions(workspace, absolutePath)) {
      discovered.set(file.path, file);
    }
  }
  if (discovered.size === 0) return;

  throw new Error([
    formatDiscoveredWorkspaceInstructions([...discovered.values()], workspace.root),
    "Apply these instructions, then retry this tool call. No mutation or command was executed.",
  ].join("\n"));
}


export function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

export function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

export function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

export function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

export function attachWorkspaceTaskReminder<T>(result: T, reminder: string | undefined): T {
  return attachWorkspaceNotice(result, reminder);
}

export function attachWorkspaceContextUpdate<T>(result: T, update: string | undefined): T {
  return attachWorkspaceNotice(result, update);
}

function attachWorkspaceNotice<T>(result: T, notice: string | undefined): T {
  if (!notice || toolResultIsError(result) || typeof result !== "object" || result === null) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return { ...result, content: [...content, textBlock(notice)] } as T;
}

export function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

export function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

export function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}


export function toolResultIsError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

export function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return String(result ?? "");
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
    if (typeof value === "string") return value;
  }
  return "";
}

export function toolResultContent(result: unknown): ToolContent[] {
  if (typeof result !== "object" || result === null) return [];
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? content as ToolContent[] : [];
}

export function remapCompositeToolResult<T>(
  result: T,
  executionWorkspaceId: string,
  compositeWorkspaceId: string,
  member: string,
): T {
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  const remapped = replaceWorkspaceIdentity(record, executionWorkspaceId, compositeWorkspaceId) as Record<string, unknown>;
  const meta = typeof remapped._meta === "object" && remapped._meta !== null
    ? { ...(remapped._meta as Record<string, unknown>) }
    : undefined;
  if (meta) {
    const card = typeof meta.card === "object" && meta.card !== null
      ? { ...(meta.card as Record<string, unknown>), workspaceId: compositeWorkspaceId, member }
      : undefined;
    if (card) meta.card = card;
    remapped._meta = meta;
  }
  const structured = typeof remapped.structuredContent === "object" && remapped.structuredContent !== null
    ? { ...(remapped.structuredContent as Record<string, unknown>), member }
    : undefined;
  if (structured) remapped.structuredContent = structured;
  return remapped as T;
}

export function replaceWorkspaceIdentity(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((entry) => replaceWorkspaceIdentity(entry, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, replaceWorkspaceIdentity(entry, from, to)]),
  );
}

export function toolResultAgentsFiles(result: unknown): Array<{ path: string; content: string }> {
  if (typeof result !== "object" || result === null) return [];
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return [];
  const agentsFiles = (structured as { agentsFiles?: unknown }).agentsFiles;
  if (!Array.isArray(agentsFiles)) return [];
  return agentsFiles.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const path = (entry as { path?: unknown }).path;
    const content = (entry as { content?: unknown }).content;
    return typeof path === "string" && typeof content === "string" ? [{ path, content }] : [];
  });
}

