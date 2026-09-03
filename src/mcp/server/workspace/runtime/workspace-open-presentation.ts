import { buildCapabilityFingerprint } from "../../../../capabilities.js";
import { createCapabilityRegistry } from "../../../../capability-registry.js";
import type { ServerConfig } from "../../../../config.js";
import { isArtifactDownloadSupportedPlatform } from "../../../../artifact-tools.js";
import { HookRunner, attachHookReports } from "../../../../hooks.js";
import { createReviewCheckpointManager } from "../../../../review-checkpoints.js";
import { formatPathForPrompt } from "../../../../skills.js";
import { compactWorkspacePresentation } from "../../../../workspace-presentation.js";
import { WorkspaceTaskStore } from "../../../../workspace-tasks.js";
import { formatAgentsPath, type WorkspaceBootstrapComponent, WorkspaceRegistry } from "../../../../workspaces.js";
import { formatAvailableSubagentProfile, summarizeSubagentProfile } from "../../../../subagents/profiles.js";
import { formatUnavailableSubagentProvider, type SubagentProviderAvailability } from "../../../../subagents/providers/availability.js";
import { capabilityContextFor } from "../../core/capability-support.js";
import { redactSkillDiagnosticPaths } from "../../core/schemas.js";
import { logToolCall, workspaceLogContext, type ToolContent } from "../../core/tool-support.js";
import type { OpenWorkspaceToolInput } from "./workspace-open-schema.js";

export interface LocalWorkspaceOpenPresentationOptions {
  config: ServerConfig;
  forgerelayVersion: string;
  workspaces: WorkspaceRegistry;
  workspaceTasks: WorkspaceTaskStore;
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>;
  capabilityRegistry: ReturnType<typeof createCapabilityRegistry>;
  subagentProviders: SubagentProviderAvailability[];
  hooks: HookRunner;
  rememberWorkspacePanelState: (workspaceId: string, response: { _meta?: unknown }) => void;
}

export async function presentLocalWorkspaceOpen(
  options: LocalWorkspaceOpenPresentationOptions,
  input: OpenWorkspaceToolInput,
  contextData: {
    conversationScopeId: string | undefined;
    protectedWorkspaceIds: ReadonlySet<string>;
    startedAt: number;
    sessionId?: string;
  },
) {
  const {
    config, forgerelayVersion: FORGERELAY_VERSION, workspaces, workspaceTasks, reviewCheckpoints,
    capabilityRegistry, subagentProviders, hooks, rememberWorkspacePanelState,
  } = options;
  const { path, workspaceId, mode, baseRef, newWorktree, newWorkspace, context } = input;
  const { conversationScopeId, protectedWorkspaceIds, startedAt, sessionId } = contextData;
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        hookReports,
        workspaceReused,
        includeBootstrapContext,
        bootstrapContextComponents,
        contextFingerprint,
      } = await workspaces.openWorkspace(
        { path, workspaceId, mode, baseRef, newWorktree, newWorkspace, context },
        {
          conversationScopeId,
          protectedWorkspaceIds,
        },
      );
      workspaceTasks.initializeWorkspace(workspace.id);
      const knownWorktrees = await workspaces.listKnownWorktrees(workspace);
      const staleWorkspaces = await workspaces.listStaleWorkspaces(workspace);
      const capabilityFingerprint = buildCapabilityFingerprint(config, FORGERELAY_VERSION, {
        artifactDownloadSupported: isArtifactDownloadSupportedPlatform(),
      });
      if (config.widgets === "changes") {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
        }));
      const capabilityGuides = workspace.capabilityGuides.map((guide) => ({
        name: guide.name,
        description: guide.description,
        whenToRead: guide.whenToRead,
        path: formatPathForPrompt(guide.filePath),
      }));
      const capabilityCatalog = capabilityRegistry.catalog(capabilityContextFor(workspace));
      const cardAgentProviders = config.subagents ? subagentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeSubagentProfile(profile);
        const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const bootstrapComponents = new Set<WorkspaceBootstrapComponent>(bootstrapContextComponents);
      const visibleSkills = bootstrapComponents.has("skills") ? cardSkills : [];
      const visibleSkillDiagnostics = bootstrapComponents.has("skillDiagnostics")
        ? redactSkillDiagnosticPaths(workspace.skillDiagnostics)
        : [];
      const visibleCapabilityGuides = bootstrapComponents.has("capabilityGuides") ? capabilityGuides : [];
      const visibleAgentProviders = bootstrapComponents.has("agentProfiles") ? cardAgentProviders : [];
      const visibleAgents = bootstrapComponents.has("agentProfiles") ? cardAgents : [];
      const loadedAgentsFiles = bootstrapComponents.has("agentsFiles") ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = bootstrapComponents.has("availableAgentsFiles")
        ? cardAvailableAgentsFiles
        : [];
      const workspaceContextInstruction =
        "For later open_workspace calls, context=\"auto\" avoids repeating unchanged bootstrap context; use context=\"none\" when only the workspace handle/metadata is needed, or context=\"full\" to force a refresh.";
      const workspaceManagementInstruction =
        "Use open_workspace(action=\"list\") for lightweight Workspace inventory. Use action=\"inspect\" with one known workspaceId for bounded read-only metadata without opening/resuming it. Explicitly open a Workspace before executing or mutating against it, and ask the user before close_workspace cleanup.";
      const cardInstruction = config.skillsEnabled
        ? `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches an available skill, load it with read(path=\"skills://<name>\") before proceeding. When a task matches a capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`
        : `Use this workspaceId in all subsequent tool calls for this project. Follow loaded agentsFiles instructions. Read an availableAgentsFiles path before working under it. When a task matches a capability guide, read its advertised path before proceeding. ${workspaceContextInstruction} ${workspaceManagementInstruction}`;
      const instruction = workspaceReused
        ? includeBootstrapContext
          ? [
              `Workspace already exists as ${workspace.id} for this directory.`,
              "Reuse this workspaceId for subsequent tool calls.",
              `Project bootstrap context components included in this response: ${bootstrapContextComponents.join(", ")}. Components not listed are unchanged and are not repeated.`,
              workspaceContextInstruction,
              workspaceManagementInstruction,
            ].join("\n\n")
          : [
              `Workspace already open as ${workspace.id}.`,
              "Reuse this workspaceId for subsequent tool calls. This is the same directory previously opened in this conversation.",
              "Continue following the project instructions, nested instruction files, skills, capability guides, agent profiles, and diagnostics previously provided for this workspace. They remain active and are not repeated here.",
              workspaceContextInstruction,
              workspaceManagementInstruction,
            ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent tool calls. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for this isolated worktree."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            capabilityCatalog.length > 0
              ? `Optional capabilities: ${capabilityCatalog.map((entry) => entry.name).join(", ")}`
              : undefined,
            visibleCapabilityGuides.length > 0
              ? `Capability guides: ${visibleCapabilityGuides.map((guide) => guide.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableSubagentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatAvailableSubagentProfile).join(", ")}`
              : undefined,
            knownWorktrees.length > 0
              ? `Known worktrees: ${knownWorktrees.map((worktree) => `${worktree.path} [${worktree.workspaceId}]${worktree.branch ? ` branch=${worktree.branch}` : ""}${worktree.targetBranch ? ` target=${worktree.targetBranch}` : ""}${worktree.current ? " (current)" : ""}`).join(", ")}`
              : undefined,
            staleWorkspaces.length > 0
              ? `This Workspace has been idle for more than 2 days: ${staleWorkspaces.map((stale) => `${stale.workspaceId} last-used=${stale.lastUsedAt}`).join(", ")}. It remains available to resume or explicitly close; do not clean it up automatically.`
              : undefined,
            `ForgeRelay ${capabilityFingerprint.version} capabilities: ${capabilityFingerprint.capabilities.join(", ")}`,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        ...workspaceLogContext(workspace, sessionId),
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const workspaceCard = {
        workspaceId: workspace.id,
        kind: "workspace" as const,
        root: workspace.root,
        path: workspace.root,
        mode: workspace.mode,
        workspaceReused,
        includeBootstrapContext,
        sourceRoot: workspace.sourceRoot,
        worktree: workspace.worktree,
        worktrees: knownWorktrees,
        staleWorkspaces,
        capabilityFingerprint,
        contextFingerprint,
        capabilityCatalog,
        agentsFiles: cardAgentsFiles,
        availableAgentsFiles: cardAvailableAgentsFiles,
        skills: cardSkills,
        agentProviders: cardAgentProviders,
        agents: cardAgents,
        instruction: cardInstruction,
        summary: {
          mode: workspace.mode,
          agentsFiles: cardAgentsFiles.length,
          availableAgentsFiles: cardAvailableAgentsFiles.length,
          skills: cardSkills.length,
          capabilities: capabilityCatalog.length,
          agentProviders: cardAgentProviders.length,
          agents: cardAgents.length,
        },
      };
      const response = hooks.decorateResult(workspace.id, attachHookReports({
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: includeBootstrapContext
            ? workspaceCard
            : compactWorkspacePresentation(workspaceCard),
        },
        structuredContent: {
          action: "open" as const,
          workspaceId: workspace.id,
          kind: "workspace" as const,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          worktrees: knownWorktrees,
          staleWorkspaces,
          capabilityFingerprint,
          contextFingerprint,
          capabilityCatalog,
          ...(bootstrapComponents.has("capabilityGuides")
            ? { capabilityGuides: visibleCapabilityGuides }
            : {}),
          ...(bootstrapComponents.has("agentsFiles") ? { agentsFiles: loadedAgentsFiles } : {}),
          ...(bootstrapComponents.has("availableAgentsFiles")
            ? { availableAgentsFiles: availableAgentsFileOutputs }
            : {}),
          ...(bootstrapComponents.has("skills") ? { skills: visibleSkills } : {}),
          ...(bootstrapComponents.has("agentProfiles")
            ? { agentProviders: visibleAgentProviders, agents: visibleAgents }
            : {}),
          ...(bootstrapComponents.has("skillDiagnostics")
            ? { skillDiagnostics: visibleSkillDiagnostics }
            : {}),
          instruction,
        },
      }, hookReports));
      rememberWorkspacePanelState(workspace.id, response);
      return response;
}
