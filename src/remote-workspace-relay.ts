import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isRemoteMcpUnauthorized,
  refreshRemoteAuthentication,
} from "./remote-auth.js";
import { RemoteMcpConnectionPool, type RemoteMcpConnection } from "./remote-mcp-connection-pool.js";
import { withFileLock } from "./state/file-lock.js";
import { withRemoteServiceEndpoint } from "./remote-transport.js";
import {
  loadForgeRelayFiles,
  type ForgeRelayRemoteRecord,
  writeForgeRelayRemote,
} from "./user-config.js";

type ToolCallResult = CallToolResult;

interface RelayedWorkspaceRoute {
  gatewayWorkspaceId: string;
  remoteInstanceId: string;
  remoteWorkspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
}

interface RelayedWorkspaceTaskSummary {
  level: "summary";
  version: 1;
  revision: number;
  lists: Array<{
    id: string;
    name: string;
    state: "active" | "archived";
    revision: number;
    taskCount: number;
    unfinishedTaskCount: number;
  }>;
}

export interface RelayedWorkspaceInspection {
  workspaceId: string;
  kind: "workspace";
  location: "relay";
  root: string;
  routeState: "known";
  status?: string;
  state?: "active" | "stale" | "invalid" | "closed";
  mode: "checkout" | "worktree";
  sourceRoot?: string;
  branch?: string;
  targetBranch?: string;
  managed?: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  idleMs?: number;
  rootValid?: boolean;
  taskSummary?: RelayedWorkspaceTaskSummary;
  relay: string;
  executionLocation: string;
}

export interface RelayedWorkspaceOpenResult {
  workspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
  contextFingerprint?: unknown;
  capabilityFingerprint?: unknown;
  capabilityCatalog?: unknown;
  capabilityGuides?: unknown;
  agentsFiles?: unknown;
  availableAgentsFiles?: unknown;
  skills?: unknown;
  agentProviders?: unknown;
  agents?: unknown;
  skillDiagnostics?: unknown;
  instruction: string;
}

export class RemoteWorkspaceRelay {
  private readonly routes = new Map<string, RelayedWorkspaceRoute>();
  private readonly turnRoutes = new Map<string, string>();
  private readonly authEnv: NodeJS.ProcessEnv;
  private readonly routeStateDir: string;
  private readonly routeStatePath: string;
  private readonly mcpConnections = new RemoteMcpConnectionPool();

  constructor(configDir: string, stateDir: string) {
    this.authEnv = { FORGERELAY_CONFIG_DIR: configDir };
    this.routeStateDir = stateDir;
    this.routeStatePath = join(stateDir, "remote-workspace-routes.json");
    this.loadRoutes();
  }

  has(workspaceId: string): boolean {
    if (this.routes.has(workspaceId)) return true;
    this.loadRoutes();
    return this.routes.has(workspaceId);
  }

  async shutdown(): Promise<void> {
    await this.mcpConnections.closeAll();
  }

  async inspectWorkspace(gatewayWorkspaceId: string): Promise<RelayedWorkspaceInspection> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    let result: ToolCallResult;
    try {
      result = await this.callRemoteTool(resolved.alias, resolved.remote, "open_workspace", {
        action: "inspect",
        workspaceId: route.remoteWorkspaceId,
      });
      assertRemoteToolSucceeded(resolved.alias, "open_workspace", result);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const remoteInspection = structured?.inspection as Record<string, unknown> | undefined;
    if (!remoteInspection || remoteInspection.kind !== "workspace") {
      throw new Error(`Remote ForgeRelay ${resolved.alias} inspection did not return a Workspace projection.`);
    }
    const root = stringField(remoteInspection, "root", "Remote Workspace inspection");
    const mode = remoteInspection.mode;
    if (mode !== "checkout" && mode !== "worktree") {
      throw new Error(`Remote ForgeRelay ${resolved.alias} inspection did not return a valid Workspace mode.`);
    }
    const projection: RelayedWorkspaceInspection = {
      workspaceId: route.gatewayWorkspaceId,
      kind: "workspace",
      location: "relay",
      root,
      routeState: "known",
      mode,
      relay: resolved.alias,
      executionLocation: `remote:${resolved.alias}`,
    };
    copyStringField(remoteInspection, projection, "status");
    const state = remoteInspection.state;
    if (state === "active" || state === "stale" || state === "invalid" || state === "closed") {
      projection.state = state;
    }
    copyStringField(remoteInspection, projection, "sourceRoot");
    copyStringField(remoteInspection, projection, "branch");
    copyStringField(remoteInspection, projection, "targetBranch");
    copyBooleanField(remoteInspection, projection, "managed");
    copyStringField(remoteInspection, projection, "createdAt");
    copyStringField(remoteInspection, projection, "lastUsedAt");
    copyNumberField(remoteInspection, projection, "idleMs");
    copyBooleanField(remoteInspection, projection, "rootValid");
    const taskSummary = safeTaskSummary(remoteInspection.taskSummary);
    if (taskSummary) projection.taskSummary = taskSummary;
    return projection;
  }

  async openWorkspace(
    alias: string,
    input: {
      path: string;
      mode?: "checkout" | "worktree";
      baseRef?: string;
      newWorktree?: boolean;
      newWorkspace?: boolean;
      context?: "auto" | "full" | "none";
    },
    conversationScopeId?: string,
  ): Promise<RelayedWorkspaceOpenResult> {
    const resolved = this.remoteByAlias(alias);
    let result: ToolCallResult;
    try {
      result = await this.callRemoteTool(resolved.alias, resolved.remote, "open_workspace", {
        path: input.path,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        ...(input.newWorktree !== undefined ? { newWorktree: input.newWorktree } : {}),
        ...(input.newWorkspace !== undefined ? { newWorkspace: input.newWorkspace } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      }, conversationScopeId);
      assertRemoteToolSucceeded(alias, "open_workspace", result);
    } catch (error) {
      throw sanitizedRemoteError(error);
    }
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const remoteWorkspaceId = stringField(structured, "workspaceId", "Remote open_workspace response");
    const root = stringField(structured, "root", "Remote open_workspace response");
    const mode = structured?.mode;
    if (mode !== "checkout" && mode !== "worktree") {
      throw new Error("Remote open_workspace response did not include a valid workspace mode.");
    }
    const sourceRoot = typeof structured?.sourceRoot === "string" ? structured.sourceRoot : undefined;
    const route = await this.findOrCreateRoute({
      remoteInstanceId: resolved.remote.instanceId,
      remoteWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
    });
    const gatewayWorkspaceId = route.gatewayWorkspaceId;
    const remapContext = (value: unknown) =>
      replaceExactWorkspaceId(value, remoteWorkspaceId, gatewayWorkspaceId);
    const remoteInstruction = typeof structured?.instruction === "string"
      ? String(remapContext(structured.instruction))
      : `Use workspaceId ${gatewayWorkspaceId} for subsequent calls.`;
    return {
      workspaceId: gatewayWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
      ...(structured?.contextFingerprint !== undefined
        ? { contextFingerprint: remapContext(structured.contextFingerprint) }
        : {}),
      ...(structured?.capabilityFingerprint !== undefined
        ? { capabilityFingerprint: remapContext(structured.capabilityFingerprint) }
        : {}),
      ...(structured?.capabilityCatalog !== undefined
        ? { capabilityCatalog: remapContext(structured.capabilityCatalog) }
        : {}),
      ...(structured?.capabilityGuides !== undefined
        ? { capabilityGuides: remapContext(structured.capabilityGuides) }
        : {}),
      ...(structured?.agentsFiles !== undefined
        ? { agentsFiles: remapContext(structured.agentsFiles) }
        : {}),
      ...(structured?.availableAgentsFiles !== undefined
        ? { availableAgentsFiles: remapContext(structured.availableAgentsFiles) }
        : {}),
      ...(structured?.skills !== undefined ? { skills: remapContext(structured.skills) } : {}),
      ...(structured?.agentProviders !== undefined
        ? { agentProviders: remapContext(structured.agentProviders) }
        : {}),
      ...(structured?.agents !== undefined ? { agents: remapContext(structured.agents) } : {}),
      ...(structured?.skillDiagnostics !== undefined
        ? { skillDiagnostics: remapContext(structured.skillDiagnostics) }
        : {}),
      instruction: `${remoteInstruction}\nThis workspace executes on remote ${alias}.`,
    };
  }

  async resumeWorkspace(
    gatewayWorkspaceId: string,
    context: "auto" | "full" | "none" = "auto",
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const result = await this.callWorkspaceTool(
      gatewayWorkspaceId,
      "open_workspace",
      { context },
      conversationScopeId,
    );
    if (result.isError === true) {
      throw new Error(`Remote open_workspace failed: ${toolResultText(result)}`);
    }
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const root = typeof structured?.root === "string" ? structured.root : route.root;
    const mode = structured?.mode === "checkout" || structured?.mode === "worktree"
      ? structured.mode
      : route.mode;
    const sourceRoot = typeof structured?.sourceRoot === "string" ? structured.sourceRoot : route.sourceRoot;
    await this.findOrCreateRoute({
      remoteInstanceId: route.remoteInstanceId,
      remoteWorkspaceId: route.remoteWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
    });
    return result;
  }

  async read(
    gatewayWorkspaceId: string,
    input: {
      path?: string;
      paths?: string[];
      offset?: number;
      limit?: number;
    },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "read", input, conversationScopeId);
  }

  async write(
    gatewayWorkspaceId: string,
    input: { path: string; content: string },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "write", input, conversationScopeId);
  }

  async edit(
    gatewayWorkspaceId: string,
    input: {
      path?: string;
      paths?: string[];
      edits: Array<{ oldText: string; newText: string }>;
    },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "edit", input, conversationScopeId);
  }

  async rename(
    gatewayWorkspaceId: string,
    input: { path: string; newPath: string },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "rename", input, conversationScopeId);
  }

  async delete(
    gatewayWorkspaceId: string,
    input: { path?: string; paths?: string[]; recursive?: boolean },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "delete", input, conversationScopeId);
  }

  async bash(
    gatewayWorkspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "bash", input, conversationScopeId);
  }

  async workspaceInstruction(
    gatewayWorkspaceId: string,
    path: string,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(
      gatewayWorkspaceId,
      "workspace_instruction",
      { path },
      conversationScopeId,
    );
  }

  async execCommand(
    gatewayWorkspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "exec_command", input, conversationScopeId);
  }

  async writeStdin(
    gatewayWorkspaceId: string,
    input: Record<string, unknown>,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "write_stdin", input, conversationScopeId);
  }

  async applyPatch(
    gatewayWorkspaceId: string,
    input: { patch: string },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "apply_patch", input, conversationScopeId);
  }

  async capability(
    gatewayWorkspaceId: string,
    input: {
      name: string;
      action: "describe" | "run";
      arguments?: Record<string, unknown>;
      file?: unknown;
    },
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "capability", input, conversationScopeId);
  }

  async activityPanel(
    gatewayWorkspaceId: string,
    conversationScopeId: string,
  ): Promise<ToolCallResult> {
    const result = await this.callWorkspaceTool(
      gatewayWorkspaceId,
      "activity_panel",
      {},
      conversationScopeId,
    );
    if (result.isError === true) {
      throw new Error(`Remote activity_panel failed: ${toolResultText(result)}`);
    }
    const turnId = stringField(
      result.structuredContent as Record<string, unknown> | undefined,
      "turnId",
      "Remote activity_panel response",
    );
    this.turnRoutes.set(turnId, gatewayWorkspaceId);
    return result;
  }

  async activitySnapshot(
    input: {
      turnId?: string;
      workspaceId?: string;
      knownRevision?: number;
    },
    conversationScopeId: string,
  ): Promise<ToolCallResult | undefined> {
    const gatewayWorkspaceId = input.workspaceId && this.has(input.workspaceId)
      ? input.workspaceId
      : input.turnId
        ? this.turnRoutes.get(input.turnId)
        : undefined;
    if (!gatewayWorkspaceId) return undefined;
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    try {
      const result = await this.callRemoteTool(resolved.alias, resolved.remote, "activity_snapshot", {
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        ...(input.workspaceId !== undefined ? { workspaceId: route.remoteWorkspaceId } : {}),
        ...(input.knownRevision !== undefined ? { knownRevision: input.knownRevision } : {}),
      }, conversationScopeId);
      const remapped = remapToolResultWorkspaceId(result, route.remoteWorkspaceId, gatewayWorkspaceId);
      const turnId = stringField(
        remapped.structuredContent as Record<string, unknown> | undefined,
        "turnId",
        "Remote activity_snapshot response",
      );
      this.turnRoutes.set(turnId, gatewayWorkspaceId);
      return remapped;
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
  }

  async activityIndex(
    turnId: string,
    knownRevision: number | undefined,
    conversationScopeId: string,
  ): Promise<ToolCallResult | undefined> {
    return this.callTurnTool(
      turnId,
      "activity_index",
      { turnId, ...(knownRevision !== undefined ? { knownRevision } : {}) },
      conversationScopeId,
    );
  }

  async activityDetail(
    turnId: string,
    activityId: string,
    conversationScopeId: string,
  ): Promise<ToolCallResult | undefined> {
    return this.callTurnTool(turnId, "activity_detail", { turnId, activityId }, conversationScopeId);
  }

  async activityOutput(
    turnId: string,
    outputId: string,
    conversationScopeId: string,
    cursor?: number,
  ): Promise<ToolCallResult | undefined> {
    return this.callTurnTool(
      turnId,
      "activity_output",
      { turnId, outputId, ...(cursor !== undefined ? { cursor } : {}) },
      conversationScopeId,
    );
  }

  private async callTurnTool(
    turnId: string,
    name: string,
    args: Record<string, unknown>,
    conversationScopeId: string,
  ): Promise<ToolCallResult | undefined> {
    const gatewayWorkspaceId = this.turnRoutes.get(turnId);
    if (!gatewayWorkspaceId) return undefined;
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    try {
      const result = await this.callRemoteTool(
        resolved.alias,
        resolved.remote,
        name,
        args,
        conversationScopeId,
      );
      return remapToolResultWorkspaceId(result, route.remoteWorkspaceId, gatewayWorkspaceId);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
  }

  private async callWorkspaceTool(
    gatewayWorkspaceId: string,
    name: string,
    args: Record<string, unknown>,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    try {
      const result = await this.callRemoteTool(resolved.alias, resolved.remote, name, {
        ...args,
        workspaceId: route.remoteWorkspaceId,
      }, conversationScopeId);
      return remapToolResultWorkspaceId(result, route.remoteWorkspaceId, gatewayWorkspaceId);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
  }

  async closeWorkspace(
    gatewayWorkspaceId: string,
    input: { action?: "close" | "delete"; commitMessage?: string } = {},
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    const action = input.action ?? "close";
    let result: ToolCallResult;
    try {
      result = await this.callRemoteTool(resolved.alias, resolved.remote, "close_workspace", {
        workspaceId: route.remoteWorkspaceId,
        action,
        ...(input.commitMessage !== undefined ? { commitMessage: input.commitMessage } : {}),
      }, conversationScopeId);
      assertRemoteToolSucceeded(resolved.alias, "close_workspace", result);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
    const remoteStructured = result.structuredContent as Record<string, unknown> | undefined;
    if (action === "delete") {
      this.routes.delete(gatewayWorkspaceId);
      await this.deletePersistedRoute(gatewayWorkspaceId);
    }
    for (const [turnId, routedWorkspaceId] of this.turnRoutes) {
      if (routedWorkspaceId === gatewayWorkspaceId) this.turnRoutes.delete(turnId);
    }

    const actionText = action === "delete" ? "Deleted" : "Closed";
    const text = route.mode === "worktree"
      ? `${actionText} relayed worktree workspace ${gatewayWorkspaceId} on remote ${resolved.alias}.`
      : `${actionText} relayed checkout workspace ${gatewayWorkspaceId} on remote ${resolved.alias}.`;
    const structuredContent: Record<string, unknown> = {
      result: text,
      workspaceId: gatewayWorkspaceId,
      action,
      mode: route.mode,
    };
    for (const field of [
      "status",
      "sourceRoot",
      "branch",
      "targetBranch",
      "commitSha",
      "mergedSha",
      "committed",
      "cleanupWarning",
    ] as const) {
      const value = remoteStructured?.[field];
      if (value !== undefined) {
        structuredContent[field] = replaceExactWorkspaceId(
          value,
          route.remoteWorkspaceId,
          gatewayWorkspaceId,
        );
      }
    }
    return {
      content: [{ type: "text", text }],
      _meta: {
        tool: "close_workspace",
        card: {
          workspaceId: gatewayWorkspaceId,
          action,
          mode: route.mode,
          payload: { content: [{ type: "text", text }] },
        },
      },
      structuredContent,
    };
  }

  private requireRoute(workspaceId: string): RelayedWorkspaceRoute {
    let route = this.routes.get(workspaceId);
    if (!route) {
      this.loadRoutes();
      route = this.routes.get(workspaceId);
    }
    if (!route) throw new Error(`Unknown relayed workspace: ${workspaceId}`);
    return route;
  }

  private loadRoutes(): void {
    for (const [workspaceId, route] of this.readRoutesFromDisk()) {
      this.routes.set(workspaceId, route);
    }
  }

  private async findOrCreateRoute(
    input: Omit<RelayedWorkspaceRoute, "gatewayWorkspaceId">,
  ): Promise<RelayedWorkspaceRoute> {
    mkdirSync(this.routeStateDir, { recursive: true });
    const selected = await withFileLock(`${this.routeStatePath}.lock`, () => {
      const routes = this.readRoutesFromDisk();
      const existing = [...routes.values()]
        .filter((route) =>
          route.remoteInstanceId === input.remoteInstanceId &&
          route.remoteWorkspaceId === input.remoteWorkspaceId
        )
        .sort((left, right) => left.gatewayWorkspaceId.localeCompare(right.gatewayWorkspaceId))[0];
      const route = {
        gatewayWorkspaceId: existing?.gatewayWorkspaceId ?? this.allocateGatewayWorkspaceId(routes),
        ...input,
      };
      routes.set(route.gatewayWorkspaceId, route);
      this.writeRoutesToDisk(routes);
      return route;
    });
    this.routes.set(selected.gatewayWorkspaceId, selected);
    return selected;
  }

  private async deletePersistedRoute(workspaceId: string): Promise<void> {
    await this.updatePersistedRoutes((routes) => {
      routes.delete(workspaceId);
    });
  }

  private async updatePersistedRoutes(
    update: (routes: Map<string, RelayedWorkspaceRoute>) => void,
  ): Promise<void> {
    mkdirSync(this.routeStateDir, { recursive: true });
    await withFileLock(`${this.routeStatePath}.lock`, () => {
      const routes = this.readRoutesFromDisk();
      update(routes);
      this.writeRoutesToDisk(routes);
    });
  }

  private readRoutesFromDisk(): Map<string, RelayedWorkspaceRoute> {
    const routes = new Map<string, RelayedWorkspaceRoute>();
    if (!existsSync(this.routeStatePath)) return routes;
    const parsed = JSON.parse(readFileSync(this.routeStatePath, "utf8")) as RelayedWorkspaceRoute[];
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid relayed workspace route state: ${this.routeStatePath}`);
    }
    for (const route of parsed) {
      if (
        !route || typeof route.gatewayWorkspaceId !== "string" ||
        typeof route.remoteInstanceId !== "string" || typeof route.remoteWorkspaceId !== "string" ||
        typeof route.root !== "string" || (route.mode !== "checkout" && route.mode !== "worktree")
      ) {
        throw new Error(`Invalid relayed workspace route state: ${this.routeStatePath}`);
      }
      routes.set(route.gatewayWorkspaceId, route);
    }
    return routes;
  }

  private writeRoutesToDisk(routes: Map<string, RelayedWorkspaceRoute>): void {
    const tempPath = `${this.routeStatePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify([...routes.values()], null, 2) + "\n", { mode: 0o600 });
      renameSync(tempPath, this.routeStatePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }


  private remoteByAlias(aliasInput: string): { alias: string; remote: ForgeRelayRemoteRecord } {
    const alias = aliasInput.trim();
    if (!alias) throw new Error("Remote relay alias must not be empty.");
    const remote = loadForgeRelayFiles(this.authEnv).auth.remotes?.[alias];
    if (!remote) throw new Error(`Unknown remote relay alias: ${alias}`);
    return { alias, remote };
  }

  private remoteByInstance(instanceId: string): { alias: string; remote: ForgeRelayRemoteRecord } {
    const entry = Object.entries(loadForgeRelayFiles(this.authEnv).auth.remotes ?? {})
      .find(([, remote]) => remote.instanceId === instanceId);
    if (!entry) throw new Error(`Remote ForgeRelay instance ${instanceId} is no longer registered.`);
    return { alias: entry[0], remote: entry[1] };
  }

  private async callRemoteTool(
    alias: string,
    initialRemote: ForgeRelayRemoteRecord,
    name: string,
    args: Record<string, unknown>,
    conversationScopeId?: string,
  ): Promise<ToolCallResult> {
    let remote = initialRemote;
    let refreshed = false;
    if (remote.accessTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
      remote = await withRemoteServiceEndpoint(
        remote.target,
        remote.sshRoute,
        (endpoint) => this.refreshRemote(alias, remote, endpoint),
      );
      refreshed = true;
    }

    let connection: RemoteMcpConnection;
    try {
      connection = await this.mcpConnections.get(remote);
    } catch (error) {
      if (!refreshed && isRemoteMcpUnauthorized(error)) {
        remote = await withRemoteServiceEndpoint(
          remote.target,
          remote.sshRoute,
          (endpoint) => this.refreshRemote(alias, remote, endpoint),
        );
        refreshed = true;
        connection = await this.mcpConnections.get(remote);
      } else {
        throw new Error(
          `Remote ForgeRelay ${alias} request failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }

    const invoke = async (active: RemoteMcpConnection) => CallToolResultSchema.parse(
      await active.client.callTool({
        name,
        arguments: args,
        ...(conversationScopeId
          ? { _meta: { "openai/session": conversationScopeId } }
          : {}),
      } as Parameters<Client["callTool"]>[0]),
    );

    try {
      return await invoke(connection);
    } catch (error) {
      if (!refreshed && isRemoteMcpUnauthorized(error)) {
        remote = await this.refreshRemote(alias, remote, connection.endpoint);
        refreshed = true;
        await this.mcpConnections.invalidate(remote.instanceId, connection);
        const refreshedConnection = await this.mcpConnections.get(remote);
        try {
          return await invoke(refreshedConnection);
        } catch (retryError) {
          await this.mcpConnections.invalidate(remote.instanceId, refreshedConnection);
          throw new Error(
            `Remote ForgeRelay ${alias} request failed: ${errorMessage(retryError)}`,
            { cause: retryError },
          );
        }
      }
      await this.mcpConnections.invalidate(remote.instanceId, connection);
      throw new Error(
        `Remote ForgeRelay ${alias} request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async refreshRemote(
    alias: string,
    remote: ForgeRelayRemoteRecord,
    endpoint: string,
  ): Promise<ForgeRelayRemoteRecord> {
    const refreshed = await refreshRemoteAuthentication(remote, endpoint);
    await writeForgeRelayRemote(alias, refreshed, this.authEnv);
    return refreshed;
  }

  private allocateGatewayWorkspaceId(routes: Map<string, RelayedWorkspaceRoute> = this.routes): string {
    let workspaceId: string;
    do {
      workspaceId = `rws_${randomBytes(5).toString("hex")}`;
    } while (routes.has(workspaceId));
    return workspaceId;
  }
}

function assertRemoteToolSucceeded(alias: string, tool: string, result: ToolCallResult): void {
  if (result.isError !== true) return;
  throw new Error(`Remote ForgeRelay ${alias} ${tool} failed: ${toolResultText(result)}`);
}

function stringField(
  structured: Record<string, unknown> | undefined,
  field: string,
  label: string,
): string {
  const value = structured?.[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} did not include ${field}.`);
  }
  return value;
}

function copyStringField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "status" | "sourceRoot" | "branch" | "targetBranch" | "createdAt" | "lastUsedAt",
): void {
  const value = source[field];
  if (typeof value === "string") target[field] = value;
}

function copyBooleanField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "managed" | "rootValid",
): void {
  const value = source[field];
  if (typeof value === "boolean") target[field] = value;
}

function copyNumberField(
  source: Record<string, unknown>,
  target: RelayedWorkspaceInspection,
  field: "idleMs",
): void {
  const value = source[field];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) target[field] = value;
}

function safeTaskSummary(value: unknown): RelayedWorkspaceTaskSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const summary = value as Record<string, unknown>;
  if (
    summary.level !== "summary" ||
    summary.version !== 1 ||
    typeof summary.revision !== "number" ||
    !Number.isInteger(summary.revision) ||
    summary.revision < 0 ||
    !Array.isArray(summary.lists)
  ) {
    return undefined;
  }
  const lists: RelayedWorkspaceTaskSummary["lists"] = [];
  for (const value of summary.lists) {
    if (!value || typeof value !== "object") return undefined;
    const list = value as Record<string, unknown>;
    if (
      typeof list.id !== "string" ||
      typeof list.name !== "string" ||
      (list.state !== "active" && list.state !== "archived") ||
      typeof list.revision !== "number" || !Number.isInteger(list.revision) || list.revision <= 0 ||
      typeof list.taskCount !== "number" || !Number.isInteger(list.taskCount) || list.taskCount < 0 ||
      typeof list.unfinishedTaskCount !== "number" || !Number.isInteger(list.unfinishedTaskCount) || list.unfinishedTaskCount < 0
    ) {
      return undefined;
    }
    lists.push({
      id: list.id,
      name: list.name,
      state: list.state,
      revision: list.revision,
      taskCount: list.taskCount,
      unfinishedTaskCount: list.unfinishedTaskCount,
    });
  }
  return {
    level: "summary",
    version: 1,
    revision: summary.revision,
    lists,
  };
}

function toolResultText(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((entry): entry is Extract<typeof entry, { type: "text" }> => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n") || "remote tool returned an error";
}

function remapToolResultWorkspaceId(
  result: ToolCallResult,
  remoteWorkspaceId: string,
  gatewayWorkspaceId: string,
): ToolCallResult {
  return {
    ...result,
    content: (result.content ?? []).map((entry) =>
      entry.type === "text"
        ? { ...entry, text: entry.text.split(remoteWorkspaceId).join(gatewayWorkspaceId) }
        : entry
    ),
    ...(result._meta
      ? { _meta: replaceExactWorkspaceId(result._meta, remoteWorkspaceId, gatewayWorkspaceId) }
      : {}),
    ...(result.structuredContent
      ? {
          structuredContent: replaceExactWorkspaceId(
            result.structuredContent,
            remoteWorkspaceId,
            gatewayWorkspaceId,
          ) as Record<string, unknown>,
        }
      : {}),
  } as ToolCallResult;
}

function replaceExactWorkspaceId(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((entry) => replaceExactWorkspaceId(entry, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, replaceExactWorkspaceId(entry, from, to)]),
  );
}

function sanitizedRemoteError(
  error: unknown,
  remoteWorkspaceId?: string,
  gatewayWorkspaceId?: string,
): Error {
  let message = errorMessage(error);
  if (remoteWorkspaceId && gatewayWorkspaceId) {
    message = message.split(remoteWorkspaceId).join(gatewayWorkspaceId);
  }
  message = message.replace(
    /(^|[^A-Za-z0-9_])ws_[0-9a-f]{10}(?=$|[^A-Za-z0-9_])/g,
    "$1[remote-workspace]",
  );
  return new Error(message, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
