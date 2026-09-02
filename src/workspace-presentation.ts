import { createHash } from "node:crypto";

const PRESENTATION_FIELDS = [
  "workspaceId",
  "kind",
  "name",
  "members",
  "root",
  "path",
  "mode",
  "sourceRoot",
  "workspaceReused",
  "includeBootstrapContext",
  "worktree",
  "summary",
] as const;

export function compactWorkspacePresentation(
  card: Record<string, unknown>,
): Record<string, unknown> {
  const presentation: Record<string, unknown> = {};
  for (const field of PRESENTATION_FIELDS) {
    const value = card[field];
    if (value !== undefined) presentation[field] = value;
  }
  presentation.presentationRevision = presentationRevision(card, presentation);
  return presentation;
}

function presentationRevision(
  card: Record<string, unknown>,
  presentation: Record<string, unknown>,
): string {
  if (typeof card.presentationRevision === "string" && card.presentationRevision.length > 0) {
    return card.presentationRevision;
  }
  if (typeof card.contextFingerprint === "string" && card.contextFingerprint.length > 0) {
    return card.contextFingerprint;
  }
  return createHash("sha256")
    .update(JSON.stringify(presentation))
    .digest("hex");
}
