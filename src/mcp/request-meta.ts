import type { McpProtocolEra } from "./request-context.js";

export const FORGERELAY_CONVERSATION_META_KEY = "dev.forgerelay/conversation";

export interface HostConversationRequestContext {
  requestMeta?: unknown;
  transportSessionId?: string;
  sessionId?: string;
  requestId?: string | number;
  protocolEra?: McpProtocolEra;
}

function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  return metadataString(meta, "openai/session");
}

export function forgeRelayConversationScopeId(
  meta: unknown,
): string | undefined {
  const value = metadataString(meta, FORGERELAY_CONVERSATION_META_KEY);
  return value ? `forgerelay-conversation:${value}` : undefined;
}

function stableHostConversationScopeId(context: HostConversationRequestContext): string | undefined {
  return openAiConversationScopeId(context.requestMeta)
    ?? forgeRelayConversationScopeId(context.requestMeta);
}

function modernRequestScopeId(
  context: HostConversationRequestContext,
  connectionScopeId: string,
): string {
  return `mcp-request:${connectionScopeId}:${String(context.requestId ?? "unknown")}`;
}

export function hostConversationScopeId(
  context: HostConversationRequestContext,
  connectionScopeId: string,
): string {
  const stableScope = stableHostConversationScopeId(context);
  if (stableScope) return stableScope;
  if (context.protocolEra === "modern") return modernRequestScopeId(context, connectionScopeId);

  const transportSessionId = context.transportSessionId ?? context.sessionId;
  return transportSessionId ? `mcp-session:${transportSessionId}` : connectionScopeId;
}

export function hostContextDeliveryScopeId(
  context: HostConversationRequestContext,
  connectionScopeId: string,
): string | undefined {
  const stableScope = stableHostConversationScopeId(context);
  if (stableScope) return stableScope;
  return context.protocolEra === "modern"
    ? modernRequestScopeId(context, connectionScopeId)
    : undefined;
}
