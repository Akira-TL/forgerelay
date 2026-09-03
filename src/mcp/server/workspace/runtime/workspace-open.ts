import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { loadCapabilityGuides } from "../../../../capabilities.js";
import { createCapabilityRegistry } from "../../../../capability-registry.js";
import type { ServerConfig } from "../../../../config.js";
import { ProcessManager } from "../../../../process-sessions.js";
import { CompositeWorkspaceRegistry } from "../../../../composite-workspaces.js";
import { RemoteWorkspaceRelay } from "../../../../remote-workspace-relay.js";
import { openAiConversationScopeId } from "../../../../request-meta.js";
import { formatPathForPrompt } from "../../../../skills.js";
import { WorkspaceTaskStore } from "../../../../workspace-tasks.js";
import { WorkspaceRegistry } from "../../../../workspaces.js";
import { compositeCapabilityContext } from "../../core/capability-support.js";
import { workspaceInspectionOutputSchema } from "../../core/schemas.js";
import { logToolCall, textBlock } from "../../core/tool-support.js";
import { openWorkspaceToolDefinition, type OpenWorkspaceToolInput } from "./workspace-open-schema.js";
import { presentLocalWorkspaceOpen, type LocalWorkspaceOpenPresentationOptions } from "./workspace-open-presentation.js";

export interface RegisterOpenWorkspaceToolOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  remoteWorkspaces: RemoteWorkspaceRelay;
  compositeWorkspaces: CompositeWorkspaceRegistry;
  workspaceTasks: WorkspaceTaskStore;
  processSessions: ProcessManager;
  capabilityRegistry: ReturnType<typeof createCapabilityRegistry>;
  compositeTaskGuides: ReturnType<typeof loadCapabilityGuides>;
  loadCompositeMemberContext: (
    compositeWorkspaceId: string,
    memberName: string,
    contextPolicy: "auto" | "full" | "none",
    conversationScopeId: string | undefined,
    protectedWorkspaceIds: ReadonlySet<string>,
  ) => Promise<Record<string, unknown>>;
  rememberWorkspacePanelState: (workspaceId: string, response: { _meta?: unknown }) => void;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
  presentation: LocalWorkspaceOpenPresentationOptions;
}

export function registerOpenWorkspaceTool(options: RegisterOpenWorkspaceToolOptions): void {
  const { server } = options;
  registerAppTool(
    server,
    "open_workspace",
    openWorkspaceToolDefinition,
    (args, extra) => handleOpenWorkspace(options, args, extra),
  );
}

async function handleOpenWorkspace(
  options: RegisterOpenWorkspaceToolOptions,
  input: OpenWorkspaceToolInput,
  extra: { _meta?: unknown; sessionId?: string },
) {
  const {
    config, workspaces, remoteWorkspaces, compositeWorkspaces, workspaceTasks, processSessions, capabilityRegistry,
    compositeTaskGuides, loadCompositeMemberContext, rememberWorkspacePanelState, hostScopeIdFor, presentation,
  } = options;
  const {
    action = "open", memberAction, member, kind, name, memberName, path, relay, workspaceId, mode, baseRef,
    newWorktree, newWorkspace, context, root, status, state, staleOnly, offset, limit,
  } = input;
  const { _meta, sessionId } = extra;
      const startedAt = performance.now();
      const conversationScopeId = openAiConversationScopeId(_meta);
      const protectedWorkspaceIds = processSessions.activeWorkspaceIds();

      const inspectTaskSummary = (targetWorkspaceId: string) => {
        try {
          const summary = workspaceTasks.inspectSummary(targetWorkspaceId);
          if (!summary) return undefined;
          const { fingerprint: _fingerprint, ...inspectionSummary } = summary;
          return inspectionSummary;
        } catch {
          return undefined;
        }
      };
      const inspectCompositeMember = async (entry: { name: string; purpose: string; workspaceId: string }) => {
        if (remoteWorkspaces.has(entry.workspaceId)) {
          try {
            const inspected = await remoteWorkspaces.inspectWorkspace(entry.workspaceId);
            return {
              name: entry.name,
              purpose: entry.purpose,
              workspaceId: entry.workspaceId,
              known: true,
              location: inspected.location,
              routeState: inspected.routeState,
              state: inspected.state,
              status: inspected.status,
              mode: inspected.mode,
              rootValid: inspected.rootValid,
            };
          } catch {
            return {
              name: entry.name,
              purpose: entry.purpose,
              workspaceId: entry.workspaceId,
              known: false,
            };
          }
        }
        try {
          const inspected = await workspaces.inspectWorkspace(entry.workspaceId);
          return {
            name: entry.name,
            purpose: entry.purpose,
            workspaceId: entry.workspaceId,
            known: true,
            location: inspected.location,
            state: inspected.state,
            status: inspected.status,
            mode: inspected.mode,
            rootValid: inspected.rootValid,
          };
        } catch {
          return {
            name: entry.name,
            purpose: entry.purpose,
            workspaceId: entry.workspaceId,
            known: false,
          };
        }
      };

      if (action === "inspect") {
        if (!workspaceId) {
          throw new Error("open_workspace action=inspect requires workspaceId.");
        }
        if (
          memberAction !== undefined || member !== undefined || kind !== undefined || name !== undefined ||
          memberName !== undefined || path !== undefined || relay !== undefined || mode !== undefined ||
          baseRef !== undefined || newWorktree !== undefined || newWorkspace !== undefined || context !== undefined ||
          root !== undefined || status !== undefined || state !== undefined || staleOnly !== undefined ||
          offset !== undefined || limit !== undefined
        ) {
          throw new Error("open_workspace action=inspect accepts only workspaceId. It never opens, resumes, binds, or mutates the inspected Workspace.");
        }

        let inspection: z.infer<typeof workspaceInspectionOutputSchema>;
        if (compositeWorkspaces.has(workspaceId)) {
          const composite = compositeWorkspaces.get(workspaceId);
          const members = await Promise.all(composite.members.map(inspectCompositeMember));
          const taskSummary = inspectTaskSummary(composite.id);
          inspection = {
            workspaceId: composite.id,
            kind: "composite",
            name: composite.name,
            status: composite.status,
            state: composite.status,
            createdAt: composite.createdAt,
            lastUsedAt: composite.lastUsedAt,
            members,
            ...(taskSummary ? { taskSummary } : {}),
          };
        } else if (remoteWorkspaces.has(workspaceId)) {
          inspection = await remoteWorkspaces.inspectWorkspace(workspaceId);
        } else {
          const inspected = await workspaces.inspectWorkspace(workspaceId);
          const taskSummary = inspectTaskSummary(inspected.workspaceId);
          inspection = {
            ...inspected,
            ...(taskSummary ? { taskSummary } : {}),
          };
        }

        const instruction =
          "This is a bounded read-only Workspace inspection. It does not open/resume the target, deliver bootstrap context, bind this conversation, or grant file/process/Git/Capability authority. Explicitly open the Workspace before modifying or executing against it.";
        const result = [
          `Inspected Workspace ${inspection.workspaceId} (${inspection.kind}).`,
          inspection.kind === "composite"
            ? `State: ${inspection.state}; members=${inspection.members.length}.`
            : inspection.location === "relay"
              ? inspection.state
                ? `State: ${inspection.state}; route=${inspection.routeState}; mode=${inspection.mode}; location=${inspection.location}. Lifecycle and Task facts come from the Execution ForgeRelay.`
                : `Route: ${inspection.routeState}; mode=${inspection.mode}; location=${inspection.location}.`
              : `State: ${inspection.state}; mode=${inspection.mode}; location=${inspection.location}.`,
          "Task summary is included only when durable Task state already exists on the owning Workspace; Task bodies are never returned.",
          instruction,
        ].join("\n");
        logToolCall(config, {
          tool: "open_workspace",
          action: "inspect",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: {
            action: "inspect" as const,
            workspaceId: inspection.workspaceId,
            kind: inspection.kind,
            inspection,
            instruction,
          },
        };
      }

      if (action === "member") {
        if (!workspaceId || !compositeWorkspaces.has(workspaceId)) {
          throw new Error("open_workspace action=member requires an existing Composite Workspace workspaceId.");
        }
        if (!compositeWorkspaces.isActive(workspaceId)) {
          throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before changing members.`);
        }
        if (!memberAction || !member) {
          throw new Error("open_workspace action=member requires memberAction and member.");
        }
        if (
          kind !== undefined || name !== undefined || memberName !== undefined || path !== undefined || relay !== undefined || mode !== undefined ||
          baseRef !== undefined || newWorktree !== undefined || newWorkspace !== undefined || context !== undefined ||
          root !== undefined || status !== undefined || state !== undefined || staleOnly !== undefined ||
          offset !== undefined || limit !== undefined
        ) {
          throw new Error(
            "open_workspace action=member accepts workspaceId, memberAction, and member only. Put any Workspace open definition inside member.",
          );
        }

        const resolveMemberTargetWorkspaceId = async (): Promise<string> => {
          const byWorkspaceId = typeof member.workspaceId === "string" && member.workspaceId.length > 0;
          const byPath = typeof member.path === "string" && member.path.length > 0;
          if (byWorkspaceId === byPath) {
            throw new Error("A Composite Workspace member target requires exactly one of member.workspaceId or member.path.");
          }
          if (byWorkspaceId) {
            const targetWorkspaceId = member.workspaceId!;
            if (compositeWorkspaces.has(targetWorkspaceId)) {
              throw new Error("A Composite Workspace cannot be mounted as a Composite Workspace member.");
            }
            if (
              member.relay !== undefined || member.mode !== undefined || member.baseRef !== undefined ||
              member.newWorktree !== undefined || member.newWorkspace !== undefined
            ) {
              throw new Error("member.workspaceId cannot be combined with relay/mode/baseRef/newWorktree/newWorkspace.");
            }
            if (!remoteWorkspaces.has(targetWorkspaceId)) workspaces.getWorkspace(targetWorkspaceId);
            return targetWorkspaceId;
          }
          if (member.relay !== undefined) {
            const opened = await remoteWorkspaces.openWorkspace(member.relay, {
              path: member.path!,
              ...(member.mode ? { mode: member.mode } : {}),
              ...(member.baseRef ? { baseRef: member.baseRef } : {}),
              ...(member.newWorktree !== undefined ? { newWorktree: member.newWorktree } : {}),
              ...(member.newWorkspace !== undefined ? { newWorkspace: member.newWorkspace } : {}),
              context: "none",
            });
            return opened.workspaceId;
          }
          const opened = await workspaces.openWorkspace(
            {
              path: member.path,
              ...(member.mode ? { mode: member.mode } : {}),
              ...(member.baseRef ? { baseRef: member.baseRef } : {}),
              ...(member.newWorktree !== undefined ? { newWorktree: member.newWorktree } : {}),
              ...(member.newWorkspace !== undefined ? { newWorkspace: member.newWorkspace } : {}),
              context: "none",
            },
            { protectedWorkspaceIds },
          );
          return opened.workspace.id;
        };

        let composite;
        if (memberAction === "add") {
          if (member.newName !== undefined) {
            throw new Error("Adding a Composite Workspace member does not accept member.newName.");
          }
          const purpose = member.purpose?.trim();
          if (!purpose) throw new Error("Adding a Composite Workspace member requires member.purpose.");
          const targetWorkspaceId = await resolveMemberTargetWorkspaceId();
          composite = compositeWorkspaces.addMember(workspaceId, {
            name: member.name,
            purpose,
            workspaceId: targetWorkspaceId,
          });
        } else if (memberAction === "update") {
          const targetFieldsPresent =
            member.workspaceId !== undefined || member.path !== undefined || member.relay !== undefined ||
            member.mode !== undefined || member.baseRef !== undefined || member.newWorktree !== undefined ||
            member.newWorkspace !== undefined;
          if (member.newName === undefined && member.purpose === undefined && !targetFieldsPresent) {
            throw new Error("Updating a Composite Workspace member requires newName, purpose, or a replacement Workspace target.");
          }
          const targetWorkspaceId = targetFieldsPresent
            ? await resolveMemberTargetWorkspaceId()
            : undefined;
          composite = compositeWorkspaces.updateMember(workspaceId, member.name, {
            ...(member.newName !== undefined ? { name: member.newName } : {}),
            ...(member.purpose !== undefined ? { purpose: member.purpose } : {}),
            ...(targetWorkspaceId !== undefined ? { workspaceId: targetWorkspaceId } : {}),
          });
        } else {
          if (
            member.newName !== undefined || member.purpose !== undefined || member.workspaceId !== undefined || member.path !== undefined ||
            member.relay !== undefined || member.mode !== undefined || member.baseRef !== undefined ||
            member.newWorktree !== undefined || member.newWorkspace !== undefined
          ) {
            throw new Error("Removing a Composite Workspace member accepts only member.name.");
          }
          composite = compositeWorkspaces.removeMember(workspaceId, member.name);
        }

        const memberActionVerb = memberAction === "add"
          ? "Added"
          : memberAction === "update"
            ? "Updated"
            : "Removed";
        const memberActionPreposition = memberAction === "remove" ? "from" : "in";
        const instruction = [
          `${memberActionVerb} member ${member.name} ${memberActionPreposition} Composite Workspace ${composite.name} (${composite.id}).`,
          composite.members.length > 0
            ? `Members: ${composite.members.map((entry) => `${entry.name} — ${entry.purpose}`).join("; ")}.`
            : "This Composite Workspace currently has no members.",
          "Use the Composite workspaceId as the top-level handle. Work operations on it require an explicit member name; ForgeRelay never infers a member from tool type or purpose.",
        ].join("\n");
        const response = {
          content: [textBlock(instruction)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: composite.id,
              kind: "composite" as const,
              name: composite.name,
              path: composite.name,
              members: composite.members,
              instruction,
              summary: { members: composite.members.length },
            },
          },
          structuredContent: {
            action: "member" as const,
            workspaceId: composite.id,
            memberAction,
            kind: "composite" as const,
            name: composite.name,
            members: composite.members,
            instruction,
          },
        };
        rememberWorkspacePanelState(composite.id, response);
        return response;
      }

      if (action === "list") {
        if (
          path !== undefined || relay !== undefined || name !== undefined || memberName !== undefined || baseRef !== undefined || newWorktree !== undefined ||
          newWorkspace !== undefined || context !== undefined
        ) {
          throw new Error(
            "open_workspace action=list does not accept path, relay, name, memberName, baseRef, newWorktree, newWorkspace, or context. Use kind/root/workspaceId/mode/status/state/staleOnly for inventory filters.",
          );
        }
        const compositeInventory = () => compositeWorkspaces.list()
          .filter((entry) => workspaceId === undefined || entry.id === workspaceId)
          .filter((entry) => status === undefined || entry.status === status)
          .filter((entry) => state === undefined || entry.status === state)
          .map((entry) => ({
            workspaceId: entry.id,
            kind: entry.kind,
            name: entry.name,
            status: entry.status,
            state: entry.status,
            members: entry.members,
            createdAt: entry.createdAt,
            lastUsedAt: entry.lastUsedAt,
          }));
        if (kind === "composite") {
          if (
            root !== undefined || mode !== undefined || staleOnly !== undefined ||
            offset !== undefined || limit !== undefined
          ) {
            throw new Error(
              "Composite Workspace inventory does not accept root/mode/staleOnly/offset/limit filters; use workspaceId/status/state when selecting Composite Workspaces.",
            );
          }
          const composites = compositeInventory();
          const instruction =
            "Open a Composite Workspace by workspaceId to resume or reopen it. close_workspace preserves its identity; action=delete permanently dissolves only Composite-owned state.";
          const result = [
            `Composite Workspace inventory: ${composites.length} matching record${composites.length === 1 ? "" : "s"}.`,
            ...composites.map((entry) => `${entry.name} [${entry.workspaceId}] state=${entry.state} members=${entry.members.length} last-used=${entry.lastUsedAt}`),
            instruction,
          ].join("\n");
          return {
            content: [textBlock(result)],
            structuredContent: {
              action: "list" as const,
              compositeWorkspaces: composites,
              instruction,
            },
          };
        }
        const inventory = await workspaces.listWorkspaces(
          { workspaceId, mode, root, status, state, staleOnly, offset, limit },
          { conversationScopeId, protectedWorkspaceIds },
        );
        const composites = kind === "workspace" || root !== undefined || mode !== undefined || staleOnly
          ? []
          : compositeInventory();
        const nextOffset = inventory.page.offset + inventory.page.limit;
        const instruction = [
          "Resume a selected workspaceId with open_workspace(action=\"open\", workspaceId=...).",
          "Use close_workspace only after the user chooses cleanup; Composite close preserves identity, while action=delete dissolves only Composite-owned state. Never close inventory entries automatically.",
          inventory.page.hasMore
            ? `More matching workspaces are available; continue with offset=${nextOffset}.`
            : undefined,
        ].filter(Boolean).join(" ");
        const result = [
          `Logical workspace inventory: ${inventory.summary.matching} matching ordinary records; ${composites.length} Composite Workspace record${composites.length === 1 ? "" : "s"}.`,
          `States: active=${inventory.summary.active}, stale=${inventory.summary.stale}, invalid=${inventory.summary.invalid}, closed=${inventory.summary.closed}.`,
          ...inventory.workspaces.map((entry) => [
            entry.label,
            `state=${entry.state}`,
            `status=${entry.status}`,
            `mode=${entry.mode}`,
            entry.managed ? "managed" : undefined,
            entry.current ? "current" : undefined,
            `root=${entry.root}`,
            `last-used=${entry.lastUsedAt}`,
          ].filter(Boolean).join(" ")),
          ...composites.map((entry) => `${entry.name} [${entry.workspaceId}] kind=composite state=${entry.state} members=${entry.members.length}`),
          instruction,
        ].join("\n");
        logToolCall(config, {
          tool: "open_workspace",
          action: "list",
          path: root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          content: [textBlock(result)],
          structuredContent: {
            action: "list" as const,
            ...inventory,
            ...(composites.length > 0 ? { compositeWorkspaces: composites } : {}),
            instruction,
          },
        };
      }

      if (
        root !== undefined || status !== undefined || state !== undefined ||
        staleOnly !== undefined || offset !== undefined || limit !== undefined
      ) {
        throw new Error(
          "open_workspace inventory filters root, status, state, staleOnly, offset, and limit are only valid with action=list.",
        );
      }

      const openingComposite = kind === "composite" ||
        (workspaceId !== undefined && compositeWorkspaces.has(workspaceId));
      if (openingComposite) {
        if (relay !== undefined || path !== undefined || mode !== undefined || baseRef !== undefined ||
          newWorktree !== undefined || newWorkspace !== undefined) {
          throw new Error(
            "Composite Workspace open accepts name/workspaceId/context only; members are attached separately and keep their own Workspace definitions.",
          );
        }
        if (workspaceId !== undefined && kind === "workspace") {
          throw new Error(`${workspaceId} is a Composite Workspace, not an ordinary Workspace.`);
        }
        const composite = workspaceId !== undefined
          ? compositeWorkspaces.open(workspaceId)
          : compositeWorkspaces.create(name ?? "");
        workspaceTasks.initializeWorkspace(composite.id);
        const compositeTaskContext = compositeCapabilityContext(composite.id, compositeTaskGuides);
        const compositeCapabilityCatalog = capabilityRegistry.catalog(compositeTaskContext);
        const compositeCapabilityGuides = compositeTaskGuides.map((guide) => ({
          name: guide.name,
          description: guide.description,
          whenToRead: guide.whenToRead,
          path: formatPathForPrompt(guide.filePath),
        }));
        const memberContext = memberName
          ? await loadCompositeMemberContext(
              composite.id,
              memberName,
              context ?? "auto",
              conversationScopeId,
              protectedWorkspaceIds,
            )
          : undefined;
        const instruction = [
          `This is Composite Workspace ${composite.name} (${composite.id}).`,
          "It has no mounted working directory of its own. Use the Composite workspaceId as the top-level Workspace handle and explicitly select one named member for member-scoped work operations.",
          composite.members.length > 0
            ? `Members: ${composite.members.map((member) => `${member.name} — ${member.purpose}`).join("; ")}.`
            : "This Composite Workspace currently has no members.",
          "Member names and purposes are structural context and are always returned when this Composite Workspace is opened. context=auto/full/none controls only heavy member bootstrap context, not this Composite identity.",
          compositeCapabilityCatalog.length > 0
            ? `Composite-owned capabilities: ${compositeCapabilityCatalog.map((entry) => entry.name).join(", ")}. Use these without member because their state belongs to the Composite Workspace itself.`
            : undefined,
          composite.members.length > 0
            ? "Before first work on a member, reopen this Composite Workspace with memberName=<member> and context=auto to receive that member's project bootstrap without creating an implicit current member."
            : undefined,
          "close_workspace preserves this Composite identity for later reopen. Use action=delete only when the user explicitly wants to dissolve the Composite relationship; neither operation closes or cleans up member Workspaces.",
        ].join("\n\n");
        const response = {
          content: [textBlock(instruction)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: composite.id,
              kind: "composite" as const,
              name: composite.name,
              path: composite.name,
              members: composite.members,
              instruction,
              summary: { members: composite.members.length, status: composite.status },
            },
          },
          structuredContent: {
            action: "open" as const,
            workspaceId: composite.id,
            kind: "composite" as const,
            name: composite.name,
            status: composite.status,
            state: composite.status,
            members: composite.members,
            capabilityCatalog: compositeCapabilityCatalog,
            capabilityGuides: compositeCapabilityGuides,
            ...(memberContext ? { memberContext } : {}),
            instruction,
          },
        };
        logToolCall(config, {
          tool: "open_workspace",
          action: "composite",
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        rememberWorkspacePanelState(composite.id, response);
        return response;
      }
      if (name !== undefined || memberName !== undefined) {
        throw new Error("open_workspace name/memberName are only valid for a Composite Workspace.");
      }
      if (workspaceId !== undefined && remoteWorkspaces.has(workspaceId)) {
        if (
          path !== undefined || relay !== undefined || mode !== undefined || baseRef !== undefined ||
          newWorktree !== undefined || newWorkspace !== undefined
        ) {
          throw new Error("Resuming a relayed Workspace by workspaceId accepts context only.");
        }
        const resumed = await remoteWorkspaces.resumeWorkspace(
          workspaceId,
          context ?? "auto",
          hostScopeIdFor(_meta, sessionId),
        );
        rememberWorkspacePanelState(workspaceId, resumed);
        return resumed;
      }
      if (relay !== undefined) {
        if (!path) throw new Error("Relayed open_workspace requires path.");
        const opened = await remoteWorkspaces.openWorkspace(relay, {
          path,
          mode,
          baseRef,
          newWorktree,
          newWorkspace,
          context,
        }, hostScopeIdFor(_meta, sessionId));
        const relayedSkills = Array.isArray(opened.skills)
          ? opened.skills as Array<{ name?: unknown }>
          : [];
        const relayedCapabilities = Array.isArray(opened.capabilityCatalog)
          ? opened.capabilityCatalog as Array<{ name?: unknown }>
          : [];
        const result = [
          `Opened relayed workspace ${opened.workspaceId}.`,
          `Execution remote: ${relay}`,
          `Root: ${opened.root}`,
          `Mode: ${opened.mode}`,
          relayedSkills.length > 0
            ? `Available skills: ${relayedSkills.map((skill) => String(skill.name ?? "")).filter(Boolean).join(", ")}`
            : undefined,
          relayedCapabilities.length > 0
            ? `Optional capabilities: ${relayedCapabilities.map((entry) => String(entry.name ?? "")).filter(Boolean).join(", ")}`
            : undefined,
          opened.instruction,
        ].filter(Boolean).join("\n");
        const response = {
          content: [textBlock(result)],
          _meta: {
            tool: "open_workspace",
            card: {
              workspaceId: opened.workspaceId,
              kind: "workspace" as const,
              root: opened.root,
              path: opened.root,
              mode: opened.mode,
              relay,
              instruction: opened.instruction,
              summary: { mode: opened.mode, relay },
            },
          },
          structuredContent: {
            action: "open" as const,
            workspaceId: opened.workspaceId,
            kind: "workspace" as const,
            root: opened.root,
            mode: opened.mode,
            ...(opened.sourceRoot ? { sourceRoot: opened.sourceRoot } : {}),
            ...(opened.contextFingerprint !== undefined
              ? { contextFingerprint: opened.contextFingerprint }
              : {}),
            ...(opened.capabilityFingerprint !== undefined
              ? { capabilityFingerprint: opened.capabilityFingerprint }
              : {}),
            ...(opened.capabilityCatalog !== undefined
              ? { capabilityCatalog: opened.capabilityCatalog }
              : {}),
            ...(opened.capabilityGuides !== undefined
              ? { capabilityGuides: opened.capabilityGuides }
              : {}),
            ...(opened.agentsFiles !== undefined ? { agentsFiles: opened.agentsFiles } : {}),
            ...(opened.availableAgentsFiles !== undefined
              ? { availableAgentsFiles: opened.availableAgentsFiles }
              : {}),
            ...(opened.skills !== undefined ? { skills: opened.skills } : {}),
            ...(opened.agentProviders !== undefined
              ? { agentProviders: opened.agentProviders }
              : {}),
            ...(opened.agents !== undefined ? { agents: opened.agents } : {}),
            ...(opened.skillDiagnostics !== undefined
              ? { skillDiagnostics: opened.skillDiagnostics }
              : {}),
            instruction: opened.instruction,
          },
        };
        logToolCall(config, {
          tool: "open_workspace",
          action: "relay",
          path: opened.root,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        rememberWorkspacePanelState(opened.workspaceId, response);
        return response;
      }

  return presentLocalWorkspaceOpen(
    presentation,
    input,
    { conversationScopeId, protectedWorkspaceIds, startedAt, sessionId },
  );
}
