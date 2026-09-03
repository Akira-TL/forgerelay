import {
  isEditTool,
  isReadTool,
  isToolName,
  isWriteTool,
  payloadText,
  type ToolResultCard,
} from "../core/card-types.js";
import type { ActivityDetail } from "./model.js";

export function activityDetailCard(detail: ActivityDetail): ToolResultCard | undefined {
  const result = asRecord(detail.result);
  const meta = asRecord(result?._meta);
  const card = asRecord(meta?.card);
  const tool = typeof meta?.tool === "string" ? meta.tool : detail.activity.tool;
  if (!card || !isToolName(tool)) return undefined;

  const request = asRecord(detail.request);
  return {
    ...(card as Omit<ToolResultCard, "tool">),
    tool,
    ...(typeof card.workspaceId === "string"
      ? {}
      : typeof request?.workspaceId === "string"
        ? { workspaceId: request.workspaceId }
        : {}),
    ...(typeof card.path === "string"
      ? {}
      : typeof request?.path === "string"
        ? { path: request.path }
        : {}),
  };
}

export function hasRichActivityPayload(card: ToolResultCard): boolean {
  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    return Boolean(card.payload?.patch || card.payload?.diff);
  }
  if (isReadTool(card.tool)) return payloadText(card.payload).length > 0;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
