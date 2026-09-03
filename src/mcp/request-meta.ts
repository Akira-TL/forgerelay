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

export function hostConversationScopeId(
  meta: unknown,
  transportSessionId: string | undefined,
  connectionScopeId: string,
): string {
  return openAiConversationScopeId(meta)
    ?? (transportSessionId ? `mcp-session:${transportSessionId}` : connectionScopeId);
}
