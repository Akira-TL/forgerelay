import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActivitySummary, HostTurnSnapshot } from "./activity/query-service.js";
import { ActivityQueryService } from "./activity/query-service.js";
import { CompositeWorkspaceRegistry } from "./composite-workspaces.js";
import { RemoteWorkspaceRelay } from "./remote-workspace-relay.js";

interface RemoteMemberTurn {
  member: string;
  workspaceId: string;
  remoteTurnId: string;
  revision?: number;
  activities?: ActivitySummary[];
}

interface CompositeTurnState {
  compositeWorkspaceId: string;
  conversationScopeId: string;
  remoteMembers: Map<string, RemoteMemberTurn>;
  remoteActivities: Map<string, RemoteMemberTurn>;
  remoteOutputs: Map<string, RemoteMemberTurn>;
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
    return snapshotResult(snapshot, `Started Composite Workspace Host Turn ${snapshot.turnId}.`);
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
    });
    return turnId;
  }

  async snapshot(
    turnId: string,
    knownRevision: number | undefined,
  ): Promise<CallToolResult | undefined> {
    const state = this.turns.get(turnId);
    if (!state) return undefined;

    const local = this.queries.snapshot(turnId);
    const remoteSnapshots = await Promise.all(
      [...state.remoteMembers.values()].map(async (route) => ({
        route,
        snapshot: await this.remoteWorkspaces.activitySnapshot(
          {
            turnId: route.remoteTurnId,
            ...(route.revision !== undefined ? { knownRevision: route.revision } : {}),
          },
          state.conversationScopeId,
        ),
      })),
    );

    state.remoteActivities.clear();
    state.remoteOutputs.clear();
    const remoteActivities: ActivitySummary[] = [];
    let revision = local.revision;
    for (const { route, snapshot } of remoteSnapshots) {
      if (!snapshot?.structuredContent) continue;
      const structured = snapshot.structuredContent as Record<string, unknown>;
      const remoteRevision = structured.revision;
      if (typeof remoteRevision === "number" && Number.isInteger(remoteRevision) && remoteRevision >= 0) {
        route.revision = remoteRevision;
      }
      if (route.revision !== undefined) revision += route.revision;
      if (structured.changed !== false) {
        route.activities = Array.isArray(structured.activities)
          ? structured.activities as ActivitySummary[]
          : [];
      }
      for (const activity of route.activities ?? []) {
        const presented = { ...activity, member: route.member } as ActivitySummary;
        remoteActivities.push(presented);
        state.remoteActivities.set(activity.activityId, route);
        if (activity.outputId) state.remoteOutputs.set(activity.outputId, route);
      }
    }

    const activities = [...local.activities, ...remoteActivities]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const changed = knownRevision === undefined || knownRevision !== revision;
    const snapshot: HostTurnSnapshot = {
      turnId,
      revision,
      changed,
      state: aggregateState(activities),
      activities: changed ? activities : [],
    };
    return snapshotResult(snapshot, changed
      ? `Composite Activity snapshot ${turnId} revision ${revision}.`
      : `Composite Activity snapshot ${turnId} unchanged at revision ${revision}.`);
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

function snapshotResult(snapshot: HostTurnSnapshot, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

function aggregateState(activities: ActivitySummary[]): HostTurnSnapshot["state"] {
  if (activities.length === 0) return "working";
  if (activities.some((activity) => activity.status === "working")) return "working";
  if (activities.some((activity) => activity.status === "error")) return "error";
  return "done";
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
