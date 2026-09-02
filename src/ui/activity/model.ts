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
  member?: string;
  processId?: number;
  outputId?: string;
  commandLength?: number;
  bashPhase?: ActivityBashPhase;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  children?: ActivityChildSummary;
}

export interface HostTurnState {
  turnId: string;
  revision: number;
  changed: boolean;
  state: ActivitySummaryStatus;
}

export interface ActivityIndex extends HostTurnState {
  activities: ActivitySummary[];
}

export type HostTurnSnapshot = ActivityIndex;

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
  cursor: number;
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

export function activityRefreshDelayMs(
  state: ActivitySummaryStatus,
  unchangedRefreshes: number,
  visible: boolean,
): number | null {
  if (!visible || state !== "working") return null;
  if (unchangedRefreshes <= 0) return 1_000;
  if (unchangedRefreshes === 1) return 2_000;
  if (unchangedRefreshes === 2) return 5_000;
  return 10_000;
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
  if (isHostTurnState(structuredContent)) return "activity";
  return panelActive ? "preserve-panel" : "tool-card";
}

export function isHostTurnState(value: unknown): value is HostTurnState {
  if (!isRecord(value)) return false;
  return (
    typeof value.turnId === "string" &&
    isNonnegativeInteger(value.revision) &&
    typeof value.changed === "boolean" &&
    isActivityStatus(value.state)
  );
}

export function isActivityIndex(value: unknown): value is ActivityIndex {
  if (!isHostTurnState(value) || !isRecord(value)) return false;
  if (!Array.isArray(value.activities)) return false;
  return value.activities.every(isActivitySummary);
}

export function isHostTurnSnapshot(value: unknown): value is HostTurnSnapshot {
  return isActivityIndex(value);
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
    !isNonnegativeInteger(value.cursor) ||
    (value.status !== "running" && value.status !== "done" && value.status !== "failed") ||
    typeof value.timedOut !== "boolean" ||
    typeof value.startedAt !== "string"
  ) return false;
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) return false;
  if (value.signal !== undefined && typeof value.signal !== "string") return false;
  return value.finishedAt === undefined || typeof value.finishedAt === "string";
}

export function applyActivityIndex(
  current: ActivitySummary[],
  incoming: ActivityIndex,
): ActivitySummary[] {
  if (!incoming.changed) return current;
  const updates = new Map(incoming.activities.map((activity) => [activity.activityId, activity]));
  const merged = current.map((activity) => updates.get(activity.activityId) ?? activity);
  const existing = new Set(current.map((activity) => activity.activityId));
  for (const activity of incoming.activities) {
    if (!existing.has(activity.activityId)) merged.push(activity);
  }
  return merged;
}

export function applyActivitySnapshot(
  current: HostTurnSnapshot | null,
  incoming: HostTurnSnapshot,
): HostTurnSnapshot {
  return {
    ...incoming,
    activities: applyActivityIndex(current?.activities ?? [], incoming),
  };
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
  if (value.member !== undefined && typeof value.member !== "string") return false;
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
