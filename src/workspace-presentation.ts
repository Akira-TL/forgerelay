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
  assignProjectedArray(presentation, "agentsFiles", card.agentsFiles, (entry) => pickFields(entry, ["path"]));
  assignProjectedArray(
    presentation,
    "availableAgentsFiles",
    card.availableAgentsFiles,
    (entry) => pickFields(entry, ["path"]),
  );
  assignProjectedArray(
    presentation,
    "skills",
    card.skills,
    (entry) => pickFields(entry, ["name"]),
  );
  assignProjectedArray(
    presentation,
    "agentProviders",
    card.agentProviders,
    (entry) => pickFields(entry, ["name", "available", "reason"]),
  );
  assignProjectedArray(
    presentation,
    "agents",
    card.agents,
    (entry) => pickFields(entry, [
      "name",
      "provider",
      "model",
      "providerAvailable",
    ]),
  );
  presentation.presentationRevision = presentationRevision(card, presentation);
  return presentation;
}

function assignProjectedArray(
  target: Record<string, unknown>,
  field: string,
  value: unknown,
  project: (entry: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (!Array.isArray(value)) return;
  const projected = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = project(entry as Record<string, unknown>);
    return Object.keys(item).length > 0 ? [item] : [];
  });
  target[field] = projected;
}

function pickFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = value[field];
    if (
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      typeof entry === "number"
    ) {
      projected[field] = entry;
    }
  }
  return projected;
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
