import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  AvailableAgentsFile,
  LoadedAgentsFile,
  Workspace,
  WorkspaceBootstrapComponent,
  WorkspaceBootstrapContextMode,
} from "../workspaces.js";

export const BOOTSTRAP_CONTEXT_COMPONENTS: readonly WorkspaceBootstrapComponent[] = [
  "agentsFiles",
  "availableAgentsFiles",
  "skills",
  "skillDiagnostics",
  "capabilityGuides",
  "agentProfiles",
];

export function resolveBootstrapContextComponents(
  mode: WorkspaceBootstrapContextMode,
  currentFingerprints: Record<WorkspaceBootstrapComponent, string>,
  deliveries: Array<{ contextFingerprint: string; componentFingerprints?: Record<string, string> }>,
  contextFingerprint?: string,
): WorkspaceBootstrapComponent[] {
  if (mode === "none") return [];
  if (mode === "full") return [...BOOTSTRAP_CONTEXT_COMPONENTS];
  if (deliveries.length === 0) return [...BOOTSTRAP_CONTEXT_COMPONENTS];

  if (
    contextFingerprint &&
    deliveries.some((delivery) =>
      !delivery.componentFingerprints && delivery.contextFingerprint === contextFingerprint
    )
  ) {
    return [];
  }

  return BOOTSTRAP_CONTEXT_COMPONENTS.filter((component) =>
    !deliveries.some((delivery) =>
      delivery.componentFingerprints?.[component] === currentFingerprints[component]
    )
  );
}

export function bootstrapContextFingerprints(
  workspace: Workspace,
  agentsFiles: LoadedAgentsFile[],
  availableAgentsFiles: AvailableAgentsFile[],
): {
  contextFingerprint: string;
  componentFingerprints: Record<WorkspaceBootstrapComponent, string>;
} {
  const payload = {
    agentsFiles: agentsFiles
      .map((file) => ({ path: resolve(file.path), content: file.content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    availableAgentsFiles: availableAgentsFiles
      .map((file) => resolve(file.path))
      .sort((left, right) => left.localeCompare(right)),
    skills: workspace.skills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: resolve(skill.filePath),
        disableModelInvocation: skill.disableModelInvocation ?? false,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath)
      ),
    skillDiagnostics: workspace.skillDiagnostics,
    capabilityGuides: workspace.capabilityGuides
      .map((guide) => ({
        name: guide.name,
        description: guide.description,
        whenToRead: guide.whenToRead,
        filePath: resolve(guide.filePath),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    agentProfiles: workspace.agentProfiles
      .map((profile) => ({
        name: profile.name,
        description: profile.description,
        provider: profile.provider,
        model: profile.model,
        thinking: profile.thinking,
        filePath: resolve(profile.filePath),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  return {
    contextFingerprint: hash(payload),
    componentFingerprints: {
      agentsFiles: hash(payload.agentsFiles),
      availableAgentsFiles: hash(payload.availableAgentsFiles),
      skills: hash(payload.skills),
      skillDiagnostics: hash(payload.skillDiagnostics),
      capabilityGuides: hash(payload.capabilityGuides),
      agentProfiles: hash(payload.agentProfiles),
    },
  };
}
