import { createHash } from "node:crypto";

function metadataString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeHash(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const session = metadataString(meta, "openai/session");
  if (!session) return undefined;

  return createHash("sha256")
    .update(JSON.stringify(["openai", session]))
    .digest("hex");
}
