import type { ResolvedConfigDomain } from "../config/resolution/types.js";

export type ProjectExecutionDisplayKind =
  | "hook"
  | "external-mcp"
  | "language-server"
  | "subagent-profile";

export interface ProjectExecutionRequirement {
  projectId: string;
  domain: string;
  logicalPath: string;
  source: {
    id: string;
    location?: string;
  };
  display: {
    kind: ProjectExecutionDisplayKind;
    name: string;
  };
  executableConfigFingerprint: string;
}

export interface ProjectExecutionTrustDecision {
  policy: "compatibility-allow";
  decision: "allow";
  projectId: string;
  executableConfigFingerprint: string;
}

export interface ProjectExecutionTrustPolicy {
  authorize(requirement: ProjectExecutionRequirement): Promise<ProjectExecutionTrustDecision>;
}

export const compatibilityAllowProjectExecutionTrustPolicy: ProjectExecutionTrustPolicy = {
  async authorize(requirement) {
    return {
      policy: "compatibility-allow",
      decision: "allow",
      projectId: requirement.projectId,
      executableConfigFingerprint: requirement.executableConfigFingerprint,
    };
  },
};

export function projectExecutionRequirement(input: {
  projectId: string;
  resolution: ResolvedConfigDomain;
  entryKey: string;
  display: ProjectExecutionRequirement["display"];
}): ProjectExecutionRequirement | undefined {
  const entry = input.resolution.entries[input.entryKey];
  if (
    !entry
    || entry.effective.source.scope !== "project"
    || entry.effective.executionEffect !== "process"
    || entry.tombstone === true
  ) {
    return undefined;
  }

  const executionFingerprint = entry.effective.executionFingerprint;
  if (!executionFingerprint) {
    throw new Error(`Project execution metadata is missing a fingerprint for ${entry.logicalPath}.`);
  }

  return {
    projectId: input.projectId,
    domain: input.resolution.domain,
    logicalPath: entry.logicalPath,
    source: {
      id: entry.effective.source.id,
      ...(entry.effective.source.location ? { location: entry.effective.source.location } : {}),
    },
    display: { ...input.display },
    executableConfigFingerprint: executionFingerprint,
  };
}
