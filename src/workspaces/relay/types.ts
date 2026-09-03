import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolCallResult = CallToolResult;

export interface RelayedWorkspaceRoute {
  gatewayWorkspaceId: string;
  remoteInstanceId: string;
  remoteWorkspaceId: string;
  root: string;
  mode: "checkout" | "worktree";
  sourceRoot?: string;
}

export interface RelayedWorkspaceTaskSummary {
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
