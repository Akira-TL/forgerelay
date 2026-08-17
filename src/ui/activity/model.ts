import { ACTIVITY_PANEL_DEFAULT_EXPANDED_META_KEY } from "../../activity/ui/contract.js";

export type ActivitySummaryStatus = "working" | "done" | "error";
export type ActivityRecordState = "executing" | "returned" | "done" | "failed" | "blocked";
export type ActivityBashPhase = "executing" | "returned" | "done" | "error";

export interface ActivityChildSummary {
  total: number;
  working: number;
  done: number;
  error: number;
}

export interface ActivitySummary {
  activityId: string;
  parentActivityId?: string;
  tool: string;
  kind: string;
  status: ActivitySummaryStatus;
  state: ActivityRecordState;
  title: string;
  target: string;
  detailAvailable: boolean;
  workspaceId?: string;
  processId?: number;
  outputId?: string;
  commandLength?: number;
  bashPhase?: ActivityBashPhase;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  children?: ActivityChildSummary;
}

export interface HostTurnSnapshot {
  turnId: string;
  revision: number;
  changed: boolean;
  state: ActivitySummaryStatus;
  activities: ActivitySummary[];
}

export interface ActivityDetail {
  activity: ActivitySummary;
  request?: unknown;
  result?: unknown;
  error?: string;
}

export interface ActivityBashOutput {
  outputId: string;
  activityId: string;
  processId: number;
  command: string;
  output: string;
  status: "running" | "done" | "failed";
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  startedAt: string;
  finishedAt?: string;
}

export interface ActivityGroup {
  activity: ActivitySummary;
  children: ActivitySummary[];
}

export interface ActivityScrollState {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function readActivityPanelDefaultExpanded(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  return meta[ACTIVITY_PANEL_DEFAULT_EXPANDED_META_KEY] === true;
}

export type ActivityToolResultRoute = "activity" | "preserve-panel" | "tool-card";

export function routeActivityToolResult(
  panelActive: boolean,
  structuredContent: unknown,
): ActivityToolResultRoute {
  if (isHostTurnSnapshot(structuredContent)) return "activity";
  return panelActive ? "preserve-panel" : "tool-card";
}

export function isHostTurnSnapshot(value: unknown): value is HostTurnSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.turnId !== "string") return false;
  if (!isNonnegativeInteger(value.revision)) return false;
  if (typeof value.changed !== "boolean") return false;
  if (!isActivityStatus(value.state)) return false;
  if (!Array.isArray(value.activities)) return false;
  return value.activities.every(isActivitySummary);
}

export function isActivityDetail(value: unknown): value is ActivityDetail {
  if (!isRecord(value) || !isActivitySummary(value.activity)) return false;
  return value.error === undefined || typeof value.error === "string";
}

export function isActivityBashOutput(value: unknown): value is ActivityBashOutput {
  if (!isRecord(value)) return false;
  if (
    typeof value.outputId !== "string" ||
    typeof value.activityId !== "string" ||
    !isPositiveInteger(value.processId) ||
    typeof value.command !== "string" ||
    typeof value.output !== "string" ||
    (value.status !== "running" && value.status !== "done" && value.status !== "failed") ||
    typeof value.timedOut !== "boolean" ||
    typeof value.startedAt !== "string"
  ) return false;
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) return false;
  if (value.signal !== undefined && typeof value.signal !== "string") return false;
  return value.finishedAt === undefined || typeof value.finishedAt === "string";
}

export function applyActivitySnapshot(
  current: HostTurnSnapshot | null,
  incoming: HostTurnSnapshot,
): HostTurnSnapshot {
  if (
    current &&
    current.turnId === incoming.turnId &&
    incoming.changed === false
  ) {
    return {
      ...incoming,
      activities: current.activities,
    };
  }
  return incoming;
}

export function groupActivitySummaries(activities: ActivitySummary[]): ActivityGroup[] {
  const ids = new Set(activities.map((activity) => activity.activityId));
  const childrenByParent = new Map<string, ActivitySummary[]>();

  for (const activity of activities) {
    if (!activity.parentActivityId || !ids.has(activity.parentActivityId)) continue;
    const children = childrenByParent.get(activity.parentActivityId) ?? [];
    children.push(activity);
    childrenByParent.set(activity.parentActivityId, children);
  }

  return activities.flatMap((activity) => {
    if (activity.parentActivityId && ids.has(activity.parentActivityId)) return [];
    return [{
      activity,
      children: childrenByParent.get(activity.activityId) ?? [],
    }];
  });
}

export function shouldFollowActivityTail(
  state: ActivityScrollState,
  tolerancePx = 24,
): boolean {
  return state.scrollHeight - state.clientHeight - state.scrollTop <= tolerancePx;
}

function isActivitySummary(value: unknown): value is ActivitySummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.activityId === "string" &&
    typeof value.tool === "string" &&
    typeof value.kind === "string" &&
    isActivityStatus(value.status) &&
    isActivityRecordState(value.state) &&
    typeof value.title === "string" &&
    typeof value.target === "string" &&
    typeof value.detailAvailable === "boolean" &&
    typeof value.startedAt === "string"
  );
}

function isActivityStatus(value: unknown): value is ActivitySummaryStatus {
  return value === "working" || value === "done" || value === "error";
}

function isActivityRecordState(value: unknown): value is ActivityRecordState {
  return (
    value === "executing" ||
    value === "returned" ||
    value === "done" ||
    value === "failed" ||
    value === "blocked"
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
