import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { BashOutputStore } from "./activity/history/bash-output-store.js";
import { registerActivityQueryTools } from "./activity/runtime/mcp-query-tools.js";
import { ActivityLifecycle } from "./activity/runtime/lifecycle.js";
import { ActivityQueryService } from "./activity/history/query-service.js";
import { buildCapabilityFingerprint, loadCapabilityGuides } from "./mcp/server/core/capabilities.js";
import { CapabilityError, createCapabilityRegistry } from "./mcp/server/core/capability-registry.js";
import { downloadIncomingArtifact, isArtifactDownloadSupportedPlatform } from "./mcp/artifacts/artifact-tools.js";
import { ArtifactError } from "./mcp/artifacts/artifact-error.js";
import { loadConfig, type ServerConfig } from "./runtime/config/config.js";
import { CodeIntelligenceError } from "./lsp/code-intelligence.js";
import { CodeIntelligenceManager } from "./lsp/runtime/manager.js";
import {
  installManagedLanguageServers,
  installedManagedLanguageServers,
  supportedManagedLanguageServers,
  type ManagedLanguageServerInstallResult,
  type ManagedLanguageServerId,
} from "./lsp/runtime/managed-language-servers.js";
import { HookRunner } from "./mcp/hooks/hooks.js";
import { checkHookConfiguration } from "./mcp/hooks/hook-cli.js";
import { buildServerInstructions, buildToolDescriptions, toolNames } from "./mcp/server-instructions.js";
import { IncomingArtifactAdapterRegistry, type IncomingArtifactAdapter } from "./mcp/artifacts/incoming-artifacts.js";
import { BatchExecutor } from "./mcp/operations/batch/executor.js";
import { type CoreOperationContext } from "./mcp/operations/core-operation-executor.js";
import { ProcessManager } from "./mcp/process/process-sessions.js";
import { createReviewCheckpointManager } from "./workspaces/review/review-checkpoints.js";
import { registerProcessTools } from "./mcp/process/tools.js";
import { attachCompletedProcessNotices, recordBashCompletion } from "./mcp/process/runtime.js";
import { CompositeActivityCoordinator } from "./workspaces/composite/composite-activity.js";
import { CompositeWorkspaceRegistry } from "./workspaces/composite/composite-workspaces.js";
import { RemoteWorkspaceRelay } from "./workspaces/relay/workspace-relay.js";
import { hostConversationScopeId } from "./mcp/request-meta.js";
import { createActivityPanelApp } from "./mcp/panel/app.js";
import { shutdownHttpServer } from "./mcp/server/transport/server-shutdown.js";
import { formatPathForPrompt } from "./workspaces/resources/skills.js";
import { WorkspaceTaskReminderTracker } from "./workspaces/tasks/workspace-task-reminders.js";
import { WorkspaceTaskStore } from "./workspaces/tasks/workspace-tasks.js";
import { WorkspaceCheckpointStore } from "./workspaces/state/workspace-checkpoints.js";
import { compactWorkspacePresentation } from "./workspaces/presentation/workspace-presentation.js";
import { formatAgentsPath, WorkspaceRegistry, type Workspace, type WorkspaceBootstrapComponent } from "./workspaces.js";
import { summarizeSubagentProfile } from "./subagents/profiles.js";
import { formatSubagentProviderAvailabilitySummary, type SubagentProviderAvailability } from "./subagents/providers/availability.js";
import { createSubagentMcpRuntime, type SubagentMcpRuntimeOptions } from "./subagents/sessions/mcp/runtime.js";
import { FORGERELAY_VERSION } from "./mcp/server/core/version.js";
import { capabilityContextFor, requireCapabilityWorkspaceRoot, reviewWorkspaceChanges, runWorkspaceTasksCapability } from "./mcp/server/core/capability-support.js";
import { createHttpServer } from "./mcp/server/transport/http-server.js";
import { registerFilesystemTools } from "./mcp/server/operations/runtime/filesystem-tools.js";
import { createOperationRuntime } from "./mcp/server/operations/runtime/operation-runtime.js";
import { registerWorkspaceAuxiliaryTools } from "./mcp/server/workspace/runtime/workspace-tools.js";
import { registerOpenWorkspaceTool } from "./mcp/server/workspace/runtime/workspace-open.js";
import { redactSkillDiagnosticPaths } from "./mcp/server/core/schemas.js";
import { attachWorkspaceContextUpdate, attachWorkspaceTaskReminder, remapCompositeToolResult, toolResultIsError } from "./mcp/server/core/tool-support.js";
interface CreateMcpServerOptions extends SubagentMcpRuntimeOptions {
  taskReminders?: WorkspaceTaskReminderTracker;
  remoteWorkspaces?: RemoteWorkspaceRelay;
  compositeWorkspaces?: CompositeWorkspaceRegistry;
  managedLanguageServerInstaller?: (
    ids: readonly ManagedLanguageServerId[],
    configDir: string,
  ) => Promise<ManagedLanguageServerInstallResult>;
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessManager,
  subagentProviders: SubagentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  codeIntelligence: CodeIntelligenceManager,
  activityLifecycle: ActivityLifecycle,
  bashOutputStore: BashOutputStore,
  activityQueries: ActivityQueryService,
  options: CreateMcpServerOptions = {},
): McpServer {
  const connectionScopeId = `mcp-connection:${randomUUID()}`;
  const activityPanelApp = createActivityPanelApp(config, FORGERELAY_VERSION);
  const ownsRemoteWorkspaces = options.remoteWorkspaces === undefined;
  const remoteWorkspaces = options.remoteWorkspaces
    ?? new RemoteWorkspaceRelay(config.configDir, config.stateDir);
  const compositeWorkspaces = options.compositeWorkspaces
    ?? new CompositeWorkspaceRegistry(config.stateDir);
  const workspaceTasks = new WorkspaceTaskStore(config.stateDir);
  const workspaceCheckpoints = new WorkspaceCheckpointStore(config.stateDir);
  const taskReminders = options.taskReminders
    ?? new WorkspaceTaskReminderTracker(config.taskReminderInterval, workspaceTasks);
  const compositeTaskGuides = loadCapabilityGuides(config).filter((guide) => guide.name === "workspace-tasks");
  const compositeActivity = new CompositeActivityCoordinator(
    compositeWorkspaces,
    activityQueries,
    remoteWorkspaces,
  );
  const resolveExecutionTarget = (workspaceId: string, memberName?: string) => {
    if (!compositeWorkspaces.has(workspaceId)) {
      if (memberName !== undefined) {
        throw new Error(`Workspace ${workspaceId} is not composite and does not accept member.`);
      }
      return { executionWorkspaceId: workspaceId };
    }
    if (!memberName) {
      throw new Error(`Composite Workspace ${workspaceId} requires member for this operation.`);
    }
    const member = compositeWorkspaces.member(workspaceId, memberName);
    try {
      if (!remoteWorkspaces.has(member.workspaceId)) workspaces.getWorkspace(member.workspaceId);
    } catch (error) {
      throw new Error(
        `Composite Workspace ${workspaceId} member ${member.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      executionWorkspaceId: member.workspaceId,
      compositeWorkspaceId: workspaceId,
      memberName: member.name,
    };
  };
  const subagentMcp = createSubagentMcpRuntime(config, activityLifecycle, options);
  const presentExecutionResult = <T>(
    result: T,
    target: ReturnType<typeof resolveExecutionTarget>,
  ): T => {
    const presented = !target.compositeWorkspaceId || !target.memberName
      ? result
      : remapCompositeToolResult(
          result,
          target.executionWorkspaceId,
          target.compositeWorkspaceId,
          target.memberName,
        );
    return subagentMcp.decorateResult(target.executionWorkspaceId, presented);
  };
  const taskReminderWorkspaceIdFor = (
    target: ReturnType<typeof resolveExecutionTarget>,
  ): string | undefined => {
    if (target.compositeWorkspaceId) return target.compositeWorkspaceId;
    if (remoteWorkspaces.has(target.executionWorkspaceId)) return undefined;
    try {
      return workspaces.getWorkspace(target.executionWorkspaceId).id;
    } catch {
      return undefined;
    }
  };
  const presentSemanticWorkResult = <T>(
    result: T,
    target: ReturnType<typeof resolveExecutionTarget>,
    conversationScopeId?: string,
  ): T => {
    let presented = presentExecutionResult(result, target);
    if (toolResultIsError(presented)) return presented;
    if (!remoteWorkspaces.has(target.executionWorkspaceId)) {
      const update = workspaces.claimResourceUpdates(target.executionWorkspaceId, conversationScopeId);
      presented = attachWorkspaceContextUpdate(presented, update?.text);
    }
    const reminderWorkspaceId = taskReminderWorkspaceIdFor(target);
    return attachWorkspaceTaskReminder(
      presented,
      reminderWorkspaceId ? taskReminders.recordWork(reminderWorkspaceId) : undefined,
    );
  };
  const hostScopeIdFor = (requestMeta: unknown, transportSessionId?: string): string =>
    hostConversationScopeId(requestMeta, transportSessionId, connectionScopeId);
  const prepareExecutionContext = async (
    target: ReturnType<typeof resolveExecutionTarget>,
    requestMeta: unknown,
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
  ): Promise<CoreOperationContext> => {
    const conversationScopeId = hostScopeIdFor(requestMeta, sessionId);
    const turnId = target.compositeWorkspaceId && target.memberName
      ? await compositeActivity.prepareMember(
          target.compositeWorkspaceId,
          target.memberName,
          target.executionWorkspaceId,
          conversationScopeId,
        )
      : undefined;
    return {
      requestMeta,
      signal,
      sessionId,
      ...(turnId ? { turnId } : {}),
      ...(target.memberName ? { activityMember: target.memberName } : {}),
    };
  };
  const toolDescriptions = buildToolDescriptions(config);
  const hooks = new HookRunner(
    config.hooks,
    config.logging,
    process.env,
    (workspaceId, result) => attachCompletedProcessNotices(
      processSessions,
      workspaceId,
      result,
      (snapshot) => recordBashCompletion(activityLifecycle, bashOutputStore, snapshot.outputId),
    ),
  );
  const incomingArtifactRegistry = new IncomingArtifactAdapterRegistry(incomingArtifactAdapters);
  const artifactDownloadAvailable = config.artifactsEnabled && isArtifactDownloadSupportedPlatform();
  const reviewChangesAvailable = config.widgets === "changes";
  let batchExecutor: BatchExecutor | undefined;
  const batchExecuteAvailable = config.toolMode !== "codex";
  const capabilityRegistry = createCapabilityRegistry({
    inspectHooks: (workspaceRoot) => checkHookConfiguration(workspaceRoot, config.hooks),
    ...subagentMcp.registryDependencies,
    workspaceRecovery: {
      available: true,
      run: async (input, context) => ({
        value: await workspaces.runManagedWorktreeRecovery(context.workspaceId, input.operation),
      }),
    },
    workspaceCheckpoint: {
      available: true,
      run: async (input, context) => {
        const root = requireCapabilityWorkspaceRoot(context);
        switch (input.operation) {
          case "create":
            return {
              value: {
                workspaceId: context.workspaceId,
                checkpoint: await workspaceCheckpoints.create(context.workspaceId, root, input.name),
                ignoredFilesIncluded: false,
              },
            };
          case "list":
            return { value: await workspaceCheckpoints.list(context.workspaceId, root, input) };
          case "inspect":
            return { value: await workspaceCheckpoints.inspect(context.workspaceId, root, input.checkpointId) };
          case "delete":
            return { value: await workspaceCheckpoints.delete(context.workspaceId, root, input.checkpointId) };
        }
      },
    },
    workspaceTasks: {
      available: true,
      run: async (input, context) => {
        const value = runWorkspaceTasksCapability(workspaceTasks, context.workspaceId, input);
        if (input.operation !== "get") taskReminders.reset(context.workspaceId);
        return { value };
      },
    },
    batchExecute: {
      available: batchExecuteAvailable,
      unavailableReason: batchExecuteAvailable
        ? undefined
        : "batch.execute is unavailable in Codex tool mode because v0.5.5 core batch tasks use the regular Read/Write/Edit/Bash operation surface.",
      run: async (input, context, options) => {
        if (!batchExecutor) throw new Error("Batch executor is not initialized.");
        return {
          value: await batchExecutor.run(context.workspaceId, input, {
            requestMeta: options.requestMeta,
            signal: options.signal,
            sessionId: options.sessionId,
          }),
        };
      },
    },
    codeIntelligence: {
      available: true,
      run: async (input, context, runOptions) => {
        if (input.operation === "managed.status") {
          return {
            value: {
              supported: supportedManagedLanguageServers(),
              installed: installedManagedLanguageServers(config.configDir),
              agentInstallAllowed: config.allowAgentLanguageServerInstall,
            },
          };
        }
        if (input.operation === "managed.install") {
          if (!config.allowAgentLanguageServerInstall) {
            throw new CapabilityError(
              "code.managed_install_disabled",
              "Agent-managed Language Server installation is disabled. Enable it explicitly with forgerelay init --force.",
            );
          }
          const install = options.managedLanguageServerInstaller ?? installManagedLanguageServers;
          const installed = await install(input.servers, config.configDir);
          return {
            value: {
              ...installed,
              availableNow: installedManagedLanguageServers(config.configDir),
              restartRequired: false,
            },
          };
        }
        try {
          return {
            value: await codeIntelligence.run(requireCapabilityWorkspaceRoot(context), input, { signal: runOptions.signal }),
          };
        } catch (error) {
          if (error instanceof CodeIntelligenceError) {
            throw new CapabilityError(error.code, error.message);
          }
          throw error;
        }
      },
    },
    reviewChanges: {
      available: reviewChangesAvailable,
      unavailableReason: reviewChangesAvailable
        ? undefined
        : "Aggregate change review is disabled; start ForgeRelay with widgets=changes.",
      run: async (context) => {
        const review = await reviewWorkspaceChanges(reviewCheckpoints, {
          id: context.workspaceId,
          root: requireCapabilityWorkspaceRoot(context),
        });
        return {
          value: {
            result: review.result,
            summary: review.summary,
            files: review.files,
          },
          card: {
            summary: review.summary,
            files: review.files,
            payload: { patch: review.patch },
          },
        };
      },
    },
    downloadArtifact: {
      available: artifactDownloadAvailable,
      unavailableReason: !config.artifactsEnabled
        ? "Native artifact ingress is disabled."
        : !isArtifactDownloadSupportedPlatform()
          ? "Native artifact ingress is unsupported on this platform."
          : undefined,
      run: async (input, context) => {
        try {
          const downloaded = await downloadIncomingArtifact({
            registry: incomingArtifactRegistry,
            workspaceId: context.workspaceId,
            workspaceRoot: requireCapabilityWorkspaceRoot(context),
            maxFileBytes: config.artifactMaxFileBytes,
            file: input.file,
            path: input.path,
          });
          return {
            value: { path: downloaded.path },
            changedPaths: [downloaded.path],
          };
        } catch (error) {
          if (error instanceof ArtifactError) {
            throw new CapabilityError(`artifact.${error.code}`, error.message);
          }
          throw error;
        }
      },
    },
  });
  const loadCompositeMemberContext = async (
    compositeWorkspaceId: string,
    memberName: string,
    contextPolicy: "auto" | "full" | "none",
    conversationScopeId: string | undefined,
    protectedWorkspaceIds: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> => {
    const target = resolveExecutionTarget(compositeWorkspaceId, memberName);
    if (remoteWorkspaces.has(target.executionWorkspaceId)) {
      const resumed = await remoteWorkspaces.resumeWorkspace(
        target.executionWorkspaceId,
        contextPolicy,
        conversationScopeId,
      );
      const presented = presentExecutionResult(resumed, target) as {
        structuredContent?: Record<string, unknown>;
      };
      return {
        member: memberName,
        ...(presented.structuredContent ?? {}),
      };
    }

    const opened = await workspaces.openWorkspace(
      { workspaceId: target.executionWorkspaceId, context: contextPolicy },
      { conversationScopeId, protectedWorkspaceIds },
    );
    const workspace = opened.workspace;
    const capabilityFingerprint = buildCapabilityFingerprint(config, FORGERELAY_VERSION, {
      artifactDownloadSupported: isArtifactDownloadSupportedPlatform(),
    });
    const capabilityCatalog = capabilityRegistry.catalog(capabilityContextFor(workspace));
    const agentsFiles = opened.agentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
      content: file.content,
    }));
    const availableAgentsFiles = opened.availableAgentsFiles.map((file) => ({
      path: formatAgentsPath(file.path, workspace.root),
    }));
    const skills = workspace.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description }));
    const capabilityGuides = workspace.capabilityGuides.map((guide) => ({
      name: guide.name,
      description: guide.description,
      whenToRead: guide.whenToRead,
      path: formatPathForPrompt(guide.filePath),
    }));
    const agentProviders = config.subagents ? subagentProviders : [];
    const agents = workspace.agentProfiles.map((profile) => {
      const summary = summarizeSubagentProfile(profile);
      const availability = agentProviders.find((provider) => provider.name === summary.provider);
      return {
        ...summary,
        providerAvailable: availability?.available,
        providerUnavailableReason: availability?.reason,
      };
    });
    const bootstrapComponents = new Set<WorkspaceBootstrapComponent>(opened.bootstrapContextComponents);
    return {
      member: memberName,
      workspaceId: compositeWorkspaceId,
      root: workspace.root,
      mode: workspace.mode,
      contextFingerprint: opened.contextFingerprint,
      capabilityFingerprint,
      capabilityCatalog,
      includeBootstrapContext: opened.includeBootstrapContext,
      ...(bootstrapComponents.has("capabilityGuides") ? { capabilityGuides } : {}),
      ...(bootstrapComponents.has("agentsFiles") ? { agentsFiles } : {}),
      ...(bootstrapComponents.has("availableAgentsFiles") ? { availableAgentsFiles } : {}),
      ...(bootstrapComponents.has("skills") ? { skills } : {}),
      ...(bootstrapComponents.has("agentProfiles") ? { agentProviders, agents } : {}),
      ...(bootstrapComponents.has("skillDiagnostics")
        ? { skillDiagnostics: redactSkillDiagnosticPaths(workspace.skillDiagnostics) }
        : {}),
      instruction: opened.includeBootstrapContext
        ? `Bootstrap context for Composite member ${memberName}. Keep using Composite workspaceId ${compositeWorkspaceId} and pass member=${memberName} for work operations.`
        : contextPolicy === "none"
          ? `Bootstrap context for Composite member ${memberName} was intentionally suppressed by context=none. Keep using Composite workspaceId ${compositeWorkspaceId} with member=${memberName}; request context=auto or context=full when member bootstrap is needed.`
          : `Composite member ${memberName} context was already delivered for this Host context; keep using Composite workspaceId ${compositeWorkspaceId} with member=${memberName}.`,
    };
  };
  const operationRuntime = createOperationRuntime({
    config, workspaces, activityLifecycle, hooks, processSessions, bashOutputStore,
    capabilityRegistry, codeIntelligence, hostScopeIdFor,
  });
  batchExecutor = operationRuntime.batchExecutor;
  const { coreOperations, nativeBulkMutations } = operationRuntime;

  const server = new McpServer(
    {
      name: "forgerelay",
      title: "ForgeRelay",
      version: FORGERELAY_VERSION,
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: buildServerInstructions(config),
    },
  );

  const workspacePanelStates = new Map<string, Record<string, unknown>>();
  const liveWorkspacePanelState = (workspace: Workspace): Record<string, unknown> => {
    const loadedInstructionPathSet = new Set(workspace.loadedInstructionPaths);
    const loadedInstructionPaths = [...loadedInstructionPathSet]
      .map((path) => formatAgentsPath(path, workspace.root));
    const availableInstructionPaths = [...new Set(
      [...workspace.knownInstructionPathsByDir.values()].flat(),
    )]
      .filter((path) => !loadedInstructionPathSet.has(path))
      .map((path) => formatAgentsPath(path, workspace.root));
    const agentProviders = config.subagents ? subagentProviders : [];
    const agents = workspace.agentProfiles.map((profile) => {
      const summary = summarizeSubagentProfile(profile);
      const availability = agentProviders.find((provider) => provider.name === summary.provider);
      return {
        ...summary,
        providerAvailable: availability?.available,
        providerUnavailableReason: availability?.reason,
      };
    });
    const skills = workspace.skills
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: skill.description }));

    return compactWorkspacePresentation({
      workspaceId: workspace.id,
      root: workspace.root,
      path: workspace.root,
      mode: workspace.mode,
      sourceRoot: workspace.sourceRoot,
      worktree: workspace.worktree,
      agentsFiles: loadedInstructionPaths.map((path) => ({ path })),
      availableAgentsFiles: availableInstructionPaths.map((path) => ({ path })),
      skills,
      agentProviders,
      agents,
      summary: {
        mode: workspace.mode,
        agentsFiles: loadedInstructionPaths.length,
        availableAgentsFiles: availableInstructionPaths.length,
        skills: skills.length,
        agentProviders: agentProviders.length,
        agents: agents.length,
      },
    });
  };
  const workspacePanelState = (workspaceId: string): Record<string, unknown> | undefined => {
    const remembered = workspacePanelStates.get(workspaceId);
    if (remoteWorkspaces.has(workspaceId) || compositeWorkspaces.has(workspaceId)) {
      return remembered;
    }
    try {
      const live = liveWorkspacePanelState(workspaces.getWorkspace(workspaceId));
      return remembered ? { ...live, ...remembered } : live;
    } catch {
      return undefined;
    }
  };
  const rememberWorkspacePanelState = (
    workspaceId: string,
    response: { _meta?: unknown },
  ): void => {
    if (typeof response._meta !== "object" || response._meta === null) return;
    const meta = response._meta as Record<string, unknown>;
    const card = meta.card;
    if (meta.tool !== toolNames.openWorkspace || typeof card !== "object" || card === null) return;
    const compact = compactWorkspacePresentation(card as Record<string, unknown>);
    workspacePanelStates.set(
      workspaceId,
      {
        ...(workspacePanelStates.get(workspaceId) ?? {}),
        ...compact,
      },
    );
  };

  registerAppResource(
    server,
    "ForgeRelay Activity Panel",
    activityPanelApp.uri,
    activityPanelApp.resourceMetadata,
    async (uri, extra) => activityPanelApp.readResource(uri.toString(), extra.sessionId),
  );

  registerOpenWorkspaceTool({
    server, config, workspaces, remoteWorkspaces, compositeWorkspaces, workspaceTasks, processSessions,
    capabilityRegistry, compositeTaskGuides, loadCompositeMemberContext, rememberWorkspacePanelState, hostScopeIdFor,
    presentation: {
      config, forgerelayVersion: FORGERELAY_VERSION, workspaces, workspaceTasks, reviewCheckpoints,
      capabilityRegistry, subagentProviders, hooks, rememberWorkspacePanelState,
    },
  });

  registerActivityQueryTools(
    server,
    activityQueries,
    connectionScopeId,
    activityPanelApp.toolMeta._meta,
    config.activityPanelExpanded,
    config.logging,
    workspacePanelState,
    {
      panel: async (workspaceId, conversationScopeId) => {
        if (compositeWorkspaces.has(workspaceId)) {
          return compositeActivity.beginPanel(workspaceId, conversationScopeId);
        }
        return remoteWorkspaces.has(workspaceId)
          ? remoteWorkspaces.activityPanel(workspaceId, conversationScopeId)
          : undefined;
      },
      snapshot: async (input, conversationScopeId) => {
        const compositeTurnId = input.turnId ?? (
          input.workspaceId && compositeWorkspaces.has(input.workspaceId)
            ? compositeActivity.currentTurnId(conversationScopeId, input.workspaceId)
            : undefined
        );
        if (compositeTurnId) {
          const composite = await compositeActivity.snapshot(compositeTurnId, input.knownRevision);
          if (composite) return composite;
        }
        return remoteWorkspaces.activitySnapshot(input, conversationScopeId);
      },
      index: async (turnId, knownRevision, conversationScopeId) => {
        const composite = await compositeActivity.index(turnId, knownRevision);
        return composite ?? remoteWorkspaces.activityIndex(turnId, knownRevision, conversationScopeId);
      },
      detail: async (turnId, activityId, conversationScopeId) => {
        const composite = await compositeActivity.detail(turnId, activityId);
        return composite ?? remoteWorkspaces.activityDetail(turnId, activityId, conversationScopeId);
      },
      output: async (turnId, outputId, conversationScopeId, cursor) => {
        const composite = await compositeActivity.output(turnId, outputId, cursor);
        return composite ?? remoteWorkspaces.activityOutput(turnId, outputId, conversationScopeId, cursor);
      },
    },
  );

  registerWorkspaceAuxiliaryTools({
    server, config, workspaces, remoteWorkspaces, compositeWorkspaces, compositeTaskGuides, capabilityRegistry,
    coreOperations, activityLifecycle, hooks, workspaceTasks, workspaceCheckpoints, taskReminders, activityQueries, compositeActivity,
    workspacePanelStates, processSessions, reviewCheckpoints, codeIntelligence, resolveExecutionTarget,
    prepareExecutionContext, hostScopeIdFor, presentExecutionResult, presentSemanticWorkResult,
  });

  registerFilesystemTools({
    server,
    config,
    workspaces,
    compositeWorkspaces,
    compositeTaskGuides,
    remoteWorkspaces,
    coreOperations,
    nativeBulkMutations,
    activityLifecycle,
    codeIntelligence,
    hooks,
    toolDescriptions,
    resolveExecutionTarget,
    prepareExecutionContext,
    presentSemanticWorkResult,
    hostScopeIdFor,
  });

  registerProcessTools({
    server,
    config,
    workspaces,
    processSessions,
    hooks,
    activityLifecycle,
    bashOutputStore,
    shellRun: (input, context) => coreOperations.shellRun(input, context),
    routing: {
      resolve: resolveExecutionTarget,
      prepare: prepareExecutionContext,
      present: presentExecutionResult,
      presentSemantic: presentSemanticWorkResult,
      isRemote: (workspaceId) => remoteWorkspaces.has(workspaceId),
      bashRemote: (workspaceId, input, conversationScopeId) =>
        remoteWorkspaces.bash(workspaceId, input, conversationScopeId),
      execCommandRemote: (workspaceId, input, conversationScopeId) =>
        remoteWorkspaces.execCommand(workspaceId, input, conversationScopeId),
      writeStdinRemote: (workspaceId, input, conversationScopeId) =>
        remoteWorkspaces.writeStdin(workspaceId, input, conversationScopeId),
      hostScopeIdFor,
    },
    descriptions: {
      shell: toolDescriptions.shell,
      shellCommand: toolDescriptions.shellCommand,
    },
  });

  if (ownsRemoteWorkspaces) {
    const closeServer = server.close.bind(server);
    let closePromise: Promise<void> | undefined;
    server.close = () => {
      closePromise ??= (async () => {
        try {
          await closeServer();
        } finally {
          await remoteWorkspaces.shutdown();
        }
      })();
      return closePromise;
    };
  }

  return server;
}

export type { CreateServerOptions, RunningServer } from "./mcp/server/transport/http-server.js";

export function createServer(
  config = loadConfig(),
  options: import("./mcp/server/transport/http-server.js").CreateServerOptions = {},
) {
  return createHttpServer(config, options, createMcpServer);
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, subagentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `forgerelay listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatSubagentProviderAvailabilitySummary(subagentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("forgerelay shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
