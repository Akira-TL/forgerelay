import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isRemoteMcpUnauthorized,
  refreshRemoteAuthentication,
  withRemoteMcpClient,
} from "./remote-auth.js";
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

export interface RelayedWorkspaceOpenResult {
  workspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
  capabilityFingerprint?: unknown;
  capabilityCatalog?: unknown;
  instruction: string;
}

export class RemoteWorkspaceRelay {
  private readonly routes = new Map<string, RelayedWorkspaceRoute>();
  private readonly authEnv: NodeJS.ProcessEnv;

  constructor(configDir: string) {
    this.authEnv = { FORGERELAY_CONFIG_DIR: configDir };
  }

  has(workspaceId: string): boolean {
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
        context: "none",
      });
    } catch (error) {
      throw sanitizedRemoteError(error);
    }
    assertRemoteToolSucceeded(alias, "open_workspace", result);
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const remoteWorkspaceId = stringField(structured, "workspaceId", "Remote open_workspace response");
    const root = stringField(structured, "root", "Remote open_workspace response");
    const mode = structured?.mode;
    if (mode !== "checkout" && mode !== "worktree") {
      throw new Error("Remote open_workspace response did not include a valid workspace mode.");
    }
    const gatewayWorkspaceId = this.allocateGatewayWorkspaceId();
    const sourceRoot = typeof structured?.sourceRoot === "string" ? structured.sourceRoot : undefined;
    this.routes.set(gatewayWorkspaceId, {
      gatewayWorkspaceId,
      remoteInstanceId: resolved.remote.instanceId,
      remoteWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
    });
    return {
      workspaceId: gatewayWorkspaceId,
      root,
      mode,
      ...(sourceRoot ? { sourceRoot } : {}),
      capabilityFingerprint: structured?.capabilityFingerprint,
      capabilityCatalog: structured?.capabilityCatalog,
      instruction: `Use workspaceId ${gatewayWorkspaceId} for subsequent calls. This workspace executes on remote ${alias}.`,
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
    const route = this.requireRoute(gatewayWorkspaceId);
    const resolved = this.remoteByInstance(route.remoteInstanceId);
    try {
      const result = await this.callRemoteTool(resolved.alias, resolved.remote, "read", {
        workspaceId: route.remoteWorkspaceId,
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.paths !== undefined ? { paths: input.paths } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
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
    const route = this.routes.get(workspaceId);
    if (!route) throw new Error(`Unknown relayed workspace: ${workspaceId}`);
    return route;
  }

  private remoteByAlias(aliasInput: string): { alias: string; remote: ForgeRelayRemoteRecord } {
    const alias = aliasInput.trim();
    if (!alias) throw new Error("Remote relay alias must not be empty.");
    const remote = loadForgeRelayFiles(this.authEnv).auth.remotes?.[alias];
    if (!remote) throw new Error(`Unknown remote relay alias: ${alias}`);
    assertDirectRemote(alias, remote);
    return { alias, remote };
  }

  private remoteByInstance(instanceId: string): { alias: string; remote: ForgeRelayRemoteRecord } {
    const entry = Object.entries(loadForgeRelayFiles(this.authEnv).auth.remotes ?? {})
      .find(([, remote]) => remote.instanceId === instanceId);
    if (!entry) throw new Error(`Remote ForgeRelay instance ${instanceId} is no longer registered.`);
    assertDirectRemote(entry[0], entry[1]);
    return { alias: entry[0], remote: entry[1] };
  }

  private async callRemoteTool(
    alias: string,
    initialRemote: ForgeRelayRemoteRecord,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    let remote = initialRemote;
    let refreshed = false;
    if (remote.accessTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
      remote = await this.refreshRemote(alias, remote);
      refreshed = true;
    }

    const invoke = () => withRemoteMcpClient(
      remote,
      remote.target,
      async (client) => CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }),
      ),
    );
    try {
      return await invoke();
    } catch (error) {
      if (!refreshed && isRemoteMcpUnauthorized(error)) {
        remote = await this.refreshRemote(alias, remote);
        return invoke();
      }
      throw new Error(
        `Remote ForgeRelay ${alias} request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async refreshRemote(
    alias: string,
    remote: ForgeRelayRemoteRecord,
  ): Promise<ForgeRelayRemoteRecord> {
    const refreshed = await refreshRemoteAuthentication(remote);
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

function assertDirectRemote(alias: string, remote: ForgeRelayRemoteRecord): void {
  if (remote.sshRoute && remote.sshRoute.length > 0) {
    throw new Error(
      `Remote relay ${alias} requires an SSH route; SSH-routed workspace relay is not enabled in this tracer bullet.`,
    );
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
