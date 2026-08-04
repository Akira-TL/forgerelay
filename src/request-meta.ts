function metadataString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  return metadataString(meta, "openai/session");
}
