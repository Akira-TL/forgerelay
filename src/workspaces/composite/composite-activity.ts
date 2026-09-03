import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActivitySummary, HostTurnSnapshot, HostTurnState } from "../../activity/history/query-service.js";
import { ActivityQueryService } from "../../activity/history/query-service.js";
import { CompositeWorkspaceRegistry } from "./composite-workspaces.js";
import { RemoteWorkspaceRelay } from "../relay/workspace-relay.js";

interface RemoteMemberTurn {
  member: string;
  workspaceId: string;
  remoteTurnId: string;
  stateRevision?: number;
  state?: HostTurnState["state"];
  indexRevision?: number;
  activities?: ActivitySummary[];
}

interface CompositeTurnState {
  compositeWorkspaceId: string;
  conversationScopeId: string;
  remoteMembers: Map<string, RemoteMemberTurn>;
  remoteActivities: Map<string, RemoteMemberTurn>;
  remoteOutputs: Map<string, RemoteMemberTurn>;
  localIndexRevision?: number;
  lastIndexRevision?: number;
}

export class CompositeActivityCoordinator {
  private readonly turns = new Map<string, CompositeTurnState>();

  constructor(
    private readonly composites: CompositeWorkspaceRegistry,
    private readonly queries: ActivityQueryService,
    private readonly remoteWorkspaces: RemoteWorkspaceRelay,
  ) {}

  hasComposite(workspaceId: string): boolean {
    return this.composites.has(workspaceId);
  }

  beginPanel(workspaceId: string, conversationScopeId: string): CallToolResult {
    this.composites.touchActive(workspaceId);
    const snapshot = this.queries.beginTurn(conversationScopeId, workspaceId);
    this.turns.set(snapshot.turnId, {
      compositeWorkspaceId: workspaceId,
      conversationScopeId,
      remoteMembers: new Map(),
      remoteActivities: new Map(),
      remoteOutputs: new Map(),
    });
    return panelResult(snapshot, `Started Composite Workspace Host Turn ${snapshot.turnId}.`);
  }

  currentTurnId(
    conversationScopeId: string,
    compositeWorkspaceId: string,
  ): string | undefined {
    const turnId = this.queries.currentTurnId(conversationScopeId, compositeWorkspaceId);
    return turnId && this.turns.has(turnId) ? turnId : undefined;
  }

  async prepareMember(
    compositeWorkspaceId: string,
    member: string,
    executionWorkspaceId: string,
    conversationScopeId: string,
  ): Promise<string | undefined> {
    const turnId = this.currentTurnId(conversationScopeId, compositeWorkspaceId);
    if (!turnId) return undefined;
    if (!this.remoteWorkspaces.has(executionWorkspaceId)) return turnId;

    const state = this.turns.get(turnId)!;
    const existing = state.remoteMembers.get(member);
    if (existing?.workspaceId === executionWorkspaceId) return turnId;

    const panel = await this.remoteWorkspaces.activityPanel(executionWorkspaceId, conversationScopeId);
    const remoteTurnId = requiredString(panel.structuredContent, "turnId", "Remote Activity panel");
    state.remoteMembers.set(member, {
      member,
      workspaceId: executionWorkspaceId,
      remoteTurnId,
      stateRevision: optionalNonnegativeInteger(panel.structuredContent, "revision"),
      state: optionalActivityState(panel.structuredContent),
    });
    return turnId;
  }

  async snapshot(
    turnId: string,
    knownRevision: number | undefined,
  ): Promise<CallToolResult | undefined> {
    const state = this.turns.get(turnId);
    if (!state) return undefined;

    const local = this.queries.state(turnId);
    const remoteSnapshots = await Promise.all(
      [...state.remoteMembers.values()].map(async (route) => ({
        route,
        snapshot: await this.remoteWorkspaces.activitySnapshot(
          {
            turnId: route.remoteTurnId,
            ...(route.stateRevision !== undefined ? { knownRevision: route.stateRevision } : {}),
          },
          state.conversationScopeId,
        ),
      })),
    );

    let revision = local.revision;
    for (const { route, snapshot } of remoteSnapshots) {
      if (!snapshot?.structuredContent) continue;
      const remoteRevision = optionalNonnegativeInteger(snapshot.structuredContent, "revision");
      const remoteState = optionalActivityState(snapshot.structuredContent);
      if (remoteRevision !== undefined) route.stateRevision = remoteRevision;
      if (remoteState !== undefined) route.state = remoteState;
      revision += route.stateRevision ?? 0;
    }

    const snapshot: HostTurnState = {
      turnId,
      revision,
      changed: knownRevision === undefined || knownRevision !== revision,
      state: aggregateSourceState(local, state.remoteMembers.values()),
    };
    return dataResult(snapshot);
  }

  async index(
    turnId: string,
    knownRevision: number | undefined,
  ): Promise<CallToolResult | undefined> {
    const state = this.turns.get(turnId);
    if (!state) return undefined;

    const incremental = knownRevision !== undefined && state.lastIndexRevision === knownRevision;
    const local = this.queries.index(
      turnId,
      incremental ? state.localIndexRevision : undefined,
    );
    const remoteIndexes = await Promise.all(
      [...state.remoteMembers.values()].map(async (route) => ({
        route,
        index: await this.remoteWorkspaces.activityIndex(
          route.remoteTurnId,
          incremental ? route.indexRevision : undefined,
          state.conversationScopeId,
        ),
      })),
    );

    state.localIndexRevision = local.revision;
    const returnedRemoteActivities: ActivitySummary[] = [];
    for (const { route, index } of remoteIndexes) {
      if (!index?.structuredContent) continue;
      const structured = index.structuredContent as Record<string, unknown>;
      const remoteRevision = optionalNonnegativeInteger(structured, "revision");
      const remoteState = optionalActivityState(structured);
      const incoming = Array.isArray(structured.activities)
        ? structured.activities as ActivitySummary[]
        : [];
      if (remoteRevision !== undefined) {
        route.indexRevision = remoteRevision;
        route.stateRevision = remoteRevision;
      }
      if (remoteState !== undefined) route.state = remoteState;
      route.activities = incremental
        ? mergeActivities(route.activities ?? [], incoming)
        : [...incoming];
      returnedRemoteActivities.push(...(incremental ? incoming : route.activities).map((activity) => ({
        ...activity,
        member: route.member,
      })));
    }

    rebuildRemoteRoutes(state);
    const revision = local.revision + [...state.remoteMembers.values()]
      .reduce((sum, route) => sum + (route.indexRevision ?? route.stateRevision ?? 0), 0);
    const changed = knownRevision === undefined || knownRevision !== revision;
    const activities = changed
      ? [...local.activities, ...returnedRemoteActivities]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      : [];
    state.lastIndexRevision = revision;

    const index: HostTurnSnapshot = {
      turnId,
      revision,
      changed,
      state: aggregateSourceState(local, state.remoteMembers.values()),
      activities,
    };
    return dataResult(index);
  }

  async detail(
    turnId: string,
    activityId: string,
  ): Promise<CallToolResult | undefined> {
    const state = this.turns.get(turnId);
    if (!state) return undefined;
    const route = state.remoteActivities.get(activityId);
    if (!route) return undefined;
    const result = await this.remoteWorkspaces.activityDetail(
      route.remoteTurnId,
      activityId,
      state.conversationScopeId,
    );
    if (!result?.structuredContent) return result;
    const structured = result.structuredContent as Record<string, unknown>;
    const activity = structured.activity;
    return {
      ...result,
      structuredContent: {
        ...structured,
        ...(activity && typeof activity === "object"
          ? { activity: { ...(activity as Record<string, unknown>), member: route.member } }
          : {}),
      },
    };
  }

  async output(
    turnId: string,
    outputId: string,
    cursor?: number,
  ): Promise<CallToolResult | undefined> {
    const state = this.turns.get(turnId);
    if (!state) return undefined;
    const route = state.remoteOutputs.get(outputId);
    if (!route) return undefined;
    return this.remoteWorkspaces.activityOutput(
      route.remoteTurnId,
      outputId,
      state.conversationScopeId,
      cursor,
    );
  }

  forgetComposite(workspaceId: string): void {
    for (const [turnId, state] of this.turns) {
      if (state.compositeWorkspaceId === workspaceId) this.turns.delete(turnId);
    }
  }
}

function panelResult(snapshot: HostTurnState, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

function dataResult(snapshot: HostTurnState | HostTurnSnapshot): CallToolResult {
  return {
    content: [],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

function aggregateSourceState(
  local: HostTurnState,
  remotes: Iterable<RemoteMemberTurn>,
): HostTurnState["state"] {
  const sources = [
    ...(local.revision > 0 ? [{ revision: local.revision, state: local.state }] : []),
    ...[...remotes].flatMap((route) => {
      const revision = route.stateRevision ?? route.indexRevision ?? 0;
      return revision > 0 && route.state ? [{ revision, state: route.state }] : [];
    }),
  ];
  if (sources.length === 0) return "working";
  if (sources.some((source) => source.state === "working")) return "working";
  if (sources.some((source) => source.state === "error")) return "error";
  return "done";
}

function mergeActivities(
  current: ActivitySummary[],
  incoming: ActivitySummary[],
): ActivitySummary[] {
  const updates = new Map(incoming.map((activity) => [activity.activityId, activity]));
  const merged = current.map((activity) => updates.get(activity.activityId) ?? activity);
  const existing = new Set(current.map((activity) => activity.activityId));
  for (const activity of incoming) {
    if (!existing.has(activity.activityId)) merged.push(activity);
  }
  return merged;
}

function rebuildRemoteRoutes(state: CompositeTurnState): void {
  state.remoteActivities.clear();
  state.remoteOutputs.clear();
  for (const route of state.remoteMembers.values()) {
    for (const activity of route.activities ?? []) {
      state.remoteActivities.set(activity.activityId, route);
      if (activity.outputId) state.remoteOutputs.set(activity.outputId, route);
    }
  }
}

function optionalNonnegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function optionalActivityState(value: unknown): HostTurnState["state"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).state;
  return candidate === "working" || candidate === "done" || candidate === "error"
    ? candidate
    : undefined;
}

function requiredString(
  value: unknown,
  field: string,
  label: string,
): string {
  if (!value || typeof value !== "object") throw new Error(`${label} did not return structured content.`);
  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== "string" || !fieldValue) throw new Error(`${label} did not include ${field}.`);
  return fieldValue;
}
