import type { ToolCallResult, RelayedWorkspaceInspection, RelayedWorkspaceTaskSummary } from "./types.js";
export function assertRemoteToolSucceeded(alias: string, tool: string, result: ToolCallResult): void {
  if (result.isError !== true) return;
  throw new Error(`Remote ForgeRelay ${alias} ${tool} failed: ${toolResultText(result)}`);
}

export function stringField(
  structured: Record<string, unknown> | undefined,
  field: string,
  label: string,
): string {
  const value = structured?.[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} did not include ${field}.`);
  }
  return value;
}

export function copyStringField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "status" | "sourceRoot" | "branch" | "targetBranch" | "createdAt" | "lastUsedAt",
): void {
  const value = source[field];
  if (typeof value === "string") target[field] = value;
}

export function copyBooleanField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "managed" | "rootValid",
): void {
  const value = source[field];
  if (typeof value === "boolean") target[field] = value;
}

export function copyNumberField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "idleMs",
): void {
  const value = source[field];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) target[field] = value;
}

export function safeTaskSummary(value: unknown): RelayedWorkspaceTaskSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const summary = value as Record<string, unknown>;
  if (
    summary.level !== "summary" ||
    summary.version !== 1 ||
    typeof summary.revision !== "number" ||
    !Number.isInteger(summary.revision) ||
    summary.revision < 0 ||
    !Array.isArray(summary.lists)
  ) {
    return undefined;
  }
  const lists: RelayedWorkspaceTaskSummary["lists"] = [];
  for (const value of summary.lists) {
    if (!value || typeof value !== "object") return undefined;
    const list = value as Record<string, unknown>;
    if (
      typeof list.id !== "string" ||
      typeof list.name !== "string" ||
      (list.state !== "active" && list.state !== "archived") ||
      typeof list.revision !== "number" || !Number.isInteger(list.revision) || list.revision <= 0 ||
      typeof list.taskCount !== "number" || !Number.isInteger(list.taskCount) || list.taskCount < 0 ||
      typeof list.unfinishedTaskCount !== "number" || !Number.isInteger(list.unfinishedTaskCount) || list.unfinishedTaskCount < 0
    ) {
      return undefined;
    }
    lists.push({
      id: list.id,
      name: list.name,
      state: list.state,
      revision: list.revision,
      taskCount: list.taskCount,
      unfinishedTaskCount: list.unfinishedTaskCount,
    });
  }
  return {
    level: "summary",
    version: 1,
    revision: summary.revision,
    lists,
  };
}

export function toolResultText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n") || "remote tool returned an error";
}

export function remapToolResultWorkspaceId(
  result: ToolCallResult,
  remoteWorkspaceId: string,
  gatewayWorkspaceId: string,
): ToolCallResult {
  return {
    ...result,
    content: (result.content ?? []).map((entry) =>
      entry.type === "text"
        ? { ...entry, text: entry.text.split(remoteWorkspaceId).join(gatewayWorkspaceId) }
        : entry
    ),
    ...(result._meta
      ? { _meta: replaceExactWorkspaceId(result._meta, remoteWorkspaceId, gatewayWorkspaceId) }
      : {}),
    ...(result.structuredContent
      ? {
          structuredContent: replaceExactWorkspaceId(
            result.structuredContent,
            remoteWorkspaceId,
            gatewayWorkspaceId,
          ) as Record<string, unknown>,
        }
      : {}),
  } as ToolCallResult;
}

export function replaceExactWorkspaceId(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((entry) => replaceExactWorkspaceId(entry, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, replaceExactWorkspaceId(entry, from, to)]),
  );
}

export function sanitizedRemoteError(
  error: unknown,
  remoteWorkspaceId?: string,
  gatewayWorkspaceId?: string,
): Error {
  let message = errorMessage(error);
  if (remoteWorkspaceId && gatewayWorkspaceId) {
    message = message.split(remoteWorkspaceId).join(gatewayWorkspaceId);
  }
  message = message.replace(
    /(^|[^A-Za-z0-9_])ws_[0-9a-f]{10}(?=$|[^A-Za-z0-9_])/g,
    "$1[remote-workspace]",
  );
  return new Error(message, { cause: error });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
