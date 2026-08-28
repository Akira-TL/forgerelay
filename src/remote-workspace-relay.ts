import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isRemoteMcpUnauthorized,
  refreshRemoteAuthentication,
  withRemoteMcpClient,
} from "./remote-auth.js";
import { withRemoteServiceEndpoint } from "./remote-transport.js";
import {
  loadForgeRelayFiles,
  type ForgeRelayRemoteRecord,
  writeForgeRelayRemote,
} from "./user-config.js";

type ToolCallResult = CallToolResult;

const ROUTE_LOCK_RETRY_MS = 10;
const ROUTE_LOCK_TIMEOUT_MS = 5_000;
const ROUTE_LOCK_STALE_MS = 30_000;
const ROUTE_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface RelayedWorkspaceRoute {
  gatewayWorkspaceId: string;
  remoteInstanceId: string;
  remoteWorkspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
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
  private readonly authEnv: NodeJS.ProcessEnv;
  private readonly routeStateDir: string;
  private readonly routeStatePath: string;

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
      });
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
    const gatewayWorkspaceId = this.allocateGatewayWorkspaceId();
    const sourceRoot = typeof structured?.sourceRoot === "string" ? structured.sourceRoot : undefined;
    const route: RelayedWorkspaceRoute = {
      gatewayWorkspaceId,
      remoteInstanceId: resolved.remote.instanceId,
      remoteWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
    };
    this.routes.set(gatewayWorkspaceId, route);
    this.persistRoute(route);
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

  async read(
    gatewayWorkspaceId: string,
    input: {
      path?: string;
      paths?: string[];
      offset?: number;
      limit?: number;
    },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "read", input);
  }

  async write(
    gatewayWorkspaceId: string,
    input: { path: string; content: string },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "write", input);
  }

  async edit(
    gatewayWorkspaceId: string,
    input: {
      path?: string;
      paths?: string[];
      edits: Array<{ oldText: string; newText: string }>;
    },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "edit", input);
  }

  async rename(
    gatewayWorkspaceId: string,
    input: { path: string; newPath: string },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "rename", input);
  }

  async delete(
    gatewayWorkspaceId: string,
    input: { path?: string; paths?: string[]; recursive?: boolean },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "delete", input);
  }

  async bash(
    gatewayWorkspaceId: string,
    input: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "bash", input);
  }

  async capability(
    gatewayWorkspaceId: string,
    input: {
      name: string;
      action: "describe" | "run";
      arguments?: Record<string, unknown>;
      file?: unknown;
    },
  ): Promise<ToolCallResult> {
    return this.callWorkspaceTool(gatewayWorkspaceId, "capability", input);
  }

  private async callWorkspaceTool(
    gatewayWorkspaceId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    try {
      const result = await this.callRemoteTool(resolved.alias, resolved.remote, name, {
        ...args,
        workspaceId: route.remoteWorkspaceId,
      });
      return remapToolResultWorkspaceId(result, route.remoteWorkspaceId, gatewayWorkspaceId);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
  }

  async closeWorkspace(
    gatewayWorkspaceId: string,
    commitMessage?: string,
  ): Promise<ToolCallResult> {
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    let result: ToolCallResult;
    try {
      result = await this.callRemoteTool(resolved.alias, resolved.remote, "close_workspace", {
        workspaceId: route.remoteWorkspaceId,
        ...(commitMessage !== undefined ? { commitMessage } : {}),
      });
      assertRemoteToolSucceeded(resolved.alias, "close_workspace", result);
    } catch (error) {
      throw sanitizedRemoteError(error, route.remoteWorkspaceId, gatewayWorkspaceId);
    }
    const remoteStructured = result.structuredContent as Record<string, unknown> | undefined;
    this.routes.delete(gatewayWorkspaceId);
    this.deletePersistedRoute(gatewayWorkspaceId);

    const text = route.mode === "worktree"
      ? `Closed relayed worktree workspace ${gatewayWorkspaceId} on remote ${resolved.alias}.`
      : `Closed relayed checkout workspace ${gatewayWorkspaceId} on remote ${resolved.alias}.`;
    const structuredContent: Record<string, unknown> = {
      result: text,
      workspaceId: gatewayWorkspaceId,
      mode: route.mode,
    };
    for (const field of [
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

  private persistRoute(route: RelayedWorkspaceRoute): void {
    this.updatePersistedRoutes((routes) => {
      routes.set(route.gatewayWorkspaceId, route);
    });
  }

  private deletePersistedRoute(workspaceId: string): void {
    this.updatePersistedRoutes((routes) => {
      routes.delete(workspaceId);
    });
  }

  private updatePersistedRoutes(update: (routes: Map<string, RelayedWorkspaceRoute>) => void): void {
    mkdirSync(this.routeStateDir, { recursive: true });
    this.withRouteFileLock(() => {
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

  private withRouteFileLock<T>(operation: () => T): T {
    const lockPath = `${this.routeStatePath}.lock`;
    const deadline = Date.now() + ROUTE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        closeSync(fd);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > ROUTE_LOCK_STALE_MS) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for relayed workspace route lock: ${lockPath}`);
        }
        Atomics.wait(ROUTE_LOCK_SLEEP, 0, 0, ROUTE_LOCK_RETRY_MS);
      }
    }

    try {
      return operation();
    } finally {
      rmSync(lockPath, { force: true });
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
  ): Promise<ToolCallResult> {
    return withRemoteServiceEndpoint(
      initialRemote.target,
      initialRemote.sshRoute,
      async (endpoint) => {
        let remote = initialRemote;
        let refreshed = false;
        if (remote.accessTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
          remote = await this.refreshRemote(alias, remote, endpoint);
          refreshed = true;
        }

        const invoke = () => withRemoteMcpClient(
          remote,
          endpoint,
          async (client) => CallToolResultSchema.parse(
            await client.callTool({ name, arguments: args }),
          ),
        );
        try {
          return await invoke();
        } catch (error) {
          if (!refreshed && isRemoteMcpUnauthorized(error)) {
            remote = await this.refreshRemote(alias, remote, endpoint);
            return invoke();
          }
          throw new Error(
            `Remote ForgeRelay ${alias} request failed: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      },
    );
  }

  private async refreshRemote(
    alias: string,
    remote: ForgeRelayRemoteRecord,
    endpoint: string,
  ): Promise<ForgeRelayRemoteRecord> {
    const refreshed = await refreshRemoteAuthentication(remote, endpoint);
    writeForgeRelayRemote(alias, refreshed, this.authEnv);
    return refreshed;
  }

  private allocateGatewayWorkspaceId(): string {
    let workspaceId: string;
    do {
      workspaceId = `rws_${randomBytes(5).toString("hex")}`;
    } while (this.routes.has(workspaceId));
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
