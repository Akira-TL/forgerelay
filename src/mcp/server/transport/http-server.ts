import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import express from "express";
import { ActivityAuditStore } from "../../../activity/history/audit-store.js";
import { BashOutputStore } from "../../../activity/history/bash-output-store.js";
import { HostTurnStore } from "../../../activity/history/host-turn-store.js";
import { ActivityLifecycle } from "../../../activity/runtime/lifecycle.js";
import { ActivityQueryService } from "../../../activity/history/query-service.js";
import type { ServerConfig } from "../../../runtime/config/config.js";
import { CodeIntelligenceManager } from "../../../lsp/runtime/manager.js";
import { createOpenAIIncomingArtifactAdapter, type IncomingArtifactAdapter } from "../../artifacts/incoming-artifacts.js";
import { logEvent, requestPath, transportSessionIdPrefix } from "../../../runtime/logging/logger.js";
import { SingleUserOAuthProvider } from "../../oauth/oauth-provider.js";
import { createForgeRelayAuthRouter } from "../../oauth/router.js";
import { publicEndpointPaths, publicEndpointUrl } from "../../oauth/public-url.js";
import { McpTransportRegistry, type McpTransportCloseResult } from "./mcp-sessions.js";
import { ProcessManager } from "../../process/process-sessions.js";
import { createReviewCheckpointManager } from "../../../workspaces/review/review-checkpoints.js";
import { RemoteWorkspaceRelay } from "../../../workspaces/relay/workspace-relay.js";
import { CompositeWorkspaceRegistry } from "../../../workspaces/composite/composite-workspaces.js";
import { createWorkspaceStore } from "../../../workspaces/state/workspace-store.js";
import { WorkspaceTaskReminderTracker } from "../../../workspaces/tasks/workspace-task-reminders.js";
import { WorkspaceTaskStore } from "../../../workspaces/tasks/workspace-tasks.js";
import { WorkspaceRegistry } from "../../../workspaces.js";
import { getSubagentProviderAvailabilitySnapshot, type SubagentProviderAvailability } from "../../../subagents/providers/availability.js";
import { activityPanelAssetDirectory, setActivityPanelAssetHeaders } from "../../panel/app.js";
import { mcpRequestDebugFields, requestLogFields, sendJsonRpcError } from "./http-support.js";

type Transport = StreamableHTTPServerTransport;
const MCP_TRANSPORT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_MCP_TRANSPORT_SESSIONS = 64;
const MCP_TRANSPORT_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

export interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  subagentProviders: SubagentProviderAvailability[];
  close(): Promise<void>;
}

type CreateMcpServer = (
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
  options: {
    taskReminders: WorkspaceTaskReminderTracker;
    remoteWorkspaces: RemoteWorkspaceRelay;
    compositeWorkspaces: CompositeWorkspaceRegistry;
  },
) => McpServer;

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createHttpServer(
  config: ServerConfig,
  options: CreateServerOptions,
  createMcpServer: CreateMcpServer,
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpTransportRegistry<Transport>({
    maxTransports: MAX_MCP_TRANSPORT_SESSIONS,
  });
  const routeBaseUrls = config.publicBaseUrls.map((baseUrl) => new URL(baseUrl));
  const mcpUrl = publicEndpointUrl(config.publicBaseUrl, "mcp");
  const mcpPaths = publicEndpointPaths(routeBaseUrls, "mcp");
  const activityPanelAssetsPaths = publicEndpointPaths(routeBaseUrls, "mcp-app-assets");
  const healthPaths = publicEndpointPaths(routeBaseUrls, "healthz");
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "forgerelay"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const sharedRemoteWorkspaces = new RemoteWorkspaceRelay(config.configDir, config.stateDir);
  const sharedCompositeWorkspaces = new CompositeWorkspaceRegistry(config.stateDir);
  const sharedWorkspaceTasks = new WorkspaceTaskStore(config.stateDir);
  const sharedTaskReminders = new WorkspaceTaskReminderTracker(
    config.taskReminderInterval,
    sharedWorkspaceTasks,
  );
  const activityAuditStore = new ActivityAuditStore(config.stateDir);
  const bashOutputStore = new BashOutputStore(config.stateDir);
  const hostTurnStore = new HostTurnStore(config.stateDir);
  const activityQueries = new ActivityQueryService(hostTurnStore, activityAuditStore, bashOutputStore);
  const activityLifecycle = new ActivityLifecycle(activityAuditStore, {
    turnIdForConversation: (conversationScopeId, workspaceId) =>
      activityQueries.currentTurnId(conversationScopeId, workspaceId),
  });
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessManager({ outputAudit: bashOutputStore });
  const codeIntelligence = new CodeIntelligenceManager(config);
  const subagentProviders = config.subagents
    ? getSubagentProviderAvailabilitySnapshot()
    : [];

  const logTransportCloseResults = (
    reason: "idle_timeout" | "capacity_limit" | "server_shutdown",
    results: McpTransportCloseResult[],
  ) => {
    let closedCount = 0;

    for (const result of results) {
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_transport_session_close_failed", {
          reason,
          transportSessionIdPrefix: transportSessionIdPrefix(result.transportSessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      closedCount += 1;
      if (reason !== "server_shutdown") {
        logEvent(config.logging, "debug", "mcp_transport_session_closed", {
          reason,
          transportSessionIdPrefix: transportSessionIdPrefix(result.transportSessionId),
        });
      }
    }

    if (reason === "server_shutdown" && closedCount > 0) {
      logEvent(config.logging, "debug", "mcp_transport_sessions_closed", {
        reason,
        count: closedCount,
      });
    }
  };

  const logRuntimeResources = (): void => {
    const memory = process.memoryUsage();
    const processStats = processSessions.stats();
    const codeStats = codeIntelligence.stats();
    logEvent(config.logging, "debug", "runtime_resources", {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      mcpTransports: transports.size,
      processesTotal: processStats.total,
      processesRunning: processStats.running,
      processesCompleted: processStats.completed,
      cachedWorkspaces: workspaces.cachedWorkspaceCount,
      reviewStates: reviewCheckpoints.stateCount,
      languageServices: codeStats.servicesTotal,
      languageServicesActive: codeStats.servicesActive,
      languageProcessesRunning: codeStats.processesRunning,
      languageOperationsInFlight: codeStats.operationsInFlight,
      languageRequestsActive: codeStats.semanticRequestsActive,
      languageRequestsQueued: codeStats.semanticRequestsQueued,
      languageOpenDocuments: codeStats.openDocuments,
      languageDiagnosticSnapshots: codeStats.diagnosticSnapshots,
      languageDiagnosticsRetained: codeStats.diagnosticsRetained,
      languageStderrBytes: codeStats.stderrBytes,
      languagePendingCreations: codeStats.pendingCreations,
      languageCrashCooldowns: codeStats.crashCooldowns,
      languageInvalidatedServices: codeStats.invalidatedServices,
      languageRetiredWorkspaceRoots: codeStats.retiredWorkspaceRoots,
    });
  };
  const transportCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_TRANSPORT_IDLE_TIMEOUT_MS)
      .then((results) => logTransportCloseResults("idle_timeout", results))
      .finally(logRuntimeResources);
  }, MCP_TRANSPORT_CLEANUP_INTERVAL_MS);
  transportCleanupTimer.unref();
  logRuntimeResources();

  if (config.proxyTrust !== false) {
    app.set("trust proxy", config.proxyTrust);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && activityPanelAssetsPaths.some((assetPath) => path.startsWith(assetPath))) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req),
      });
    });

    next();
  });

  app.use(
    createForgeRelayAuthRouter({
      provider: oauthProvider,
      cliAuthenticationProvider: oauthProvider,
      instanceId: config.instanceId,
      issuerUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      routeBaseUrls,
      scopesSupported: config.oauth.scopes,
      resourceName: "ForgeRelay",
    }),
  );

  app.options(activityPanelAssetsPaths.map((assetPath) => `${assetPath}/{*asset}`), (_req, res) => {
    setActivityPanelAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    activityPanelAssetsPaths,
    express.static(activityPanelAssetDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setActivityPanelAssetHeaders,
    }),
  );

  app.get(healthPaths, (_req, res) => {
    res.json({ ok: true, name: "forgerelay" });
  });

  app.all(mcpPaths, async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const transportSessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      httpMethod: req.method,
      transportSessionIdPresent: Boolean(transportSessionId),
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
      isInitialize: initializeRequest,
      ...mcpRequestDebugFields(req.body),
    });

    try {
      let transport: Transport | undefined;

      if (transportSessionId) {
        transport = transports.get(transportSessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP transport session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newTransportSessionId) => {
            if (transport) {
              void transports
                .register(newTransportSessionId, transport)
                .then((results) => logTransportCloseResults("capacity_limit", results));
            }
            logEvent(config.logging, "debug", "mcp_transport_session_created", {
              requestId,
              transportSessionIdPrefix: transportSessionIdPrefix(newTransportSessionId),
              ...requestLogFields(req),
            });
          },
        });

        transport.onclose = () => {
          const closedTransportSessionId = transport?.sessionId;
          if (closedTransportSessionId && transports.remove(closedTransportSessionId)) {
            logEvent(config.logging, "debug", "mcp_transport_session_closed", {
              reason: "transport_close",
              transportSessionIdPrefix: transportSessionIdPrefix(closedTransportSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          subagentProviders,
          incomingArtifactAdapters,
          codeIntelligence,
          activityLifecycle,
          bashOutputStore,
          activityQueries,
          {
            taskReminders: sharedTaskReminders,
            remoteWorkspaces: sharedRemoteWorkspaces,
            compositeWorkspaces: sharedCompositeWorkspaces,
          },
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP transport session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    subagentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(transportCleanupTimer);
        const results = await transports.closeAll();
        logTransportCloseResults("server_shutdown", results);
        await sharedRemoteWorkspaces.shutdown();
        processSessions.shutdown();
        await codeIntelligence.shutdown();
        oauthProvider.close();
        hostTurnStore.close();
        bashOutputStore.close();
        activityAuditStore.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

