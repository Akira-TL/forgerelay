import type { ActivityAuditJsonValue, ActivityRecord, ActivityRecordState } from "./audit-store.js";
import { ActivityAuditStore } from "./audit-store.js";
import type { BashOutputRecord } from "./bash-output-store.js";
import { BashOutputStore } from "./bash-output-store.js";
import { HostTurnStore } from "./host-turn-store.js";

export type ActivitySummaryStatus = "working" | "done" | "error";
export type ActivityBashPhase = "executing" | "returned" | "done" | "error";

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
  children?: {
    total: number;
    working: number;
    done: number;
    error: number;
  };
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
  request?: ActivityAuditJsonValue;
  result?: ActivityAuditJsonValue;
  error?: string;
}

export interface ActivityBashOutput {
  outputId: string;
  activityId: string;
  processId: number;
  command: string;
  output: string;
  status: BashOutputRecord["status"];
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  startedAt: string;
  finishedAt?: string;
}

export class ActivityQueryService {
  constructor(
    private readonly turns: HostTurnStore,
    private readonly audit: ActivityAuditStore,
    private readonly outputs: BashOutputStore,
  ) {}

  beginTurn(conversationScopeId: string | undefined, workspaceId: string): HostTurnSnapshot {
    const turn = this.turns.begin(conversationScopeId, workspaceId);
    return this.snapshot(turn.turnId);
  }

  currentTurnId(
    conversationScopeId: string | undefined,
    workspaceId: string | undefined,
  ): string | undefined {
    return this.turns.current(conversationScopeId, workspaceId)?.turnId;
  }

  snapshot(turnId: string, knownRevision?: number): HostTurnSnapshot {
    this.requireTurn(turnId);
    const revision = this.audit.turnRevision(turnId);
    const activities = this.summaries(turnId);
    const state = aggregateState(activities);
    const changed = knownRevision === undefined || knownRevision !== revision;
    return {
      turnId,
      revision,
      changed,
      state,
      activities: changed ? activities : [],
    };
  }

  detail(turnId: string, activityId: string): ActivityDetail {
    this.requireTurn(turnId);
    const record = this.audit.getActivity(activityId);
    if (!record || record.turnId !== turnId) {
      throw new Error(`Unknown Activity ${activityId} in Host Turn ${turnId}.`);
    }
    const activity = this.summaries(turnId)
      .find((summary) => summary.activityId === activityId) ?? toSummary(record);
    if (!activity.detailAvailable) {
      throw new Error(`Activity ${activityId} is summary-complete and has no lazy detail.`);
    }
    return {
      activity,
      ...(record.request !== undefined ? { request: record.request } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  bashOutput(turnId: string, outputId: string): ActivityBashOutput {
    this.requireTurn(turnId);
    const output = this.outputs.read(outputId);
    if (!output) throw new Error(`Unknown Bash output: ${outputId}.`);
    const activities = this.audit.listActivitiesByTurn(turnId);
    const visible = activities.some((activity) =>
      activity.activityId === output.activityId || activityOutputId(activity) === outputId
    );
    if (!visible) {
      throw new Error(`Bash output ${outputId} is not part of Host Turn ${turnId}.`);
    }
    return {
      outputId: output.outputId,
      activityId: output.activityId,
      processId: output.processId,
      command: output.command,
      output: output.output,
      status: output.status,
      ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
      ...(output.signal !== undefined ? { signal: output.signal } : {}),
      timedOut: output.timedOut,
      startedAt: output.startedAt,
      ...(output.finishedAt !== undefined ? { finishedAt: output.finishedAt } : {}),
    };
  }

  private summaries(turnId: string): ActivitySummary[] {
    const records = this.audit.listActivitiesByTurn(turnId);
    const summaries = records.map(toSummary);
    const children = new Map<string, ActivitySummary["children"]>();
    for (const summary of summaries) {
      if (!summary.parentActivityId) continue;
      const aggregate = children.get(summary.parentActivityId) ?? {
        total: 0,
        working: 0,
        done: 0,
        error: 0,
      };
      aggregate.total += 1;
      aggregate[summary.status] += 1;
      children.set(summary.parentActivityId, aggregate);
    }
    return summaries.map((summary) => {
      const aggregate = children.get(summary.activityId);
      return aggregate
        ? { ...summary, detailAvailable: false, children: aggregate }
        : summary;
    });
  }

  private requireTurn(turnId: string): void {
    if (!this.turns.get(turnId)) throw new Error(`Unknown Host Turn: ${turnId}.`);
  }
}

function toSummary(record: ActivityRecord): ActivitySummary {
  const request = asRecord(record.request);
  const result = asRecord(record.result);
  const structured = asRecord(result?.structuredContent);
  const directProcessId = numberField(result, "processId") ?? numberField(request, "processId");
  const processId = numberField(structured, "processId") ?? directProcessId;
  const outputId = stringField(structured, "outputId")
    ?? stringField(result, "outputId")
    ?? stringField(request, "outputId");
  const command = stringField(request, "command") ?? stringField(request, "cmd");
  const durationMs = numberField(structured, "wallTimeMs")
    ?? numberField(result, "wallTimeMs")
    ?? elapsedMs(record.startedAt, record.updatedAt, record.state);
  const bashLike = record.tool === "bash" || record.tool === "exec_command" || record.tool === "bash_result";

  const bulkGroup = arrayField(request, "paths") !== undefined &&
    (record.tool === "read" || record.tool === "edit" || record.tool === "delete");
  return {
    activityId: record.activityId,
    ...(record.parentActivityId ? { parentActivityId: record.parentActivityId } : {}),
    tool: record.tool,
    kind: activityKind(record.tool),
    status: activityStatus(record.state),
    state: record.state,
    title: activityTitle(record.tool),
    target: activityTarget(record, request, result, structured),
    detailAvailable: !bulkGroup && record.tool !== "rename" && record.tool !== "delete" && record.tool !== "batch",
    ...(record.workspace.id ? { workspaceId: record.workspace.id } : {}),
    ...(stringField(request, "member") ? { member: stringField(request, "member")! } : {}),
    ...(processId !== undefined ? { processId } : {}),
    ...(outputId !== undefined ? { outputId } : {}),
    ...(bashLike && command !== undefined ? { commandLength: command.length } : {}),
    ...(bashLike ? { bashPhase: bashPhase(record.state) } : {}),
    startedAt: record.startedAt,
    ...(record.state !== "executing" ? { finishedAt: record.updatedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function activityKind(tool: string): string {
  if (tool === "read") return "read";
  if (tool === "write") return "write";
  if (tool === "edit" || tool === "apply_patch") return "edit";
  if (tool === "rename") return "rename";
  if (tool === "delete") return "delete";
  if (tool === "bash_result") return "shell-result";
  if (tool === "bash" || tool === "exec_command") return "shell";
  if (tool === "capability") return "capability";
  if (tool === "batch") return "batch";
  return "tool";
}

function activityTitle(tool: string): string {
  const titles: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    apply_patch: "Edit",
    rename: "Rename",
    delete: "Delete",
    bash: "Bash",
    exec_command: "Command",
    bash_result: "Bash result",
    capability: "Capability",
    batch: "Batch",
  };
  return titles[tool] ?? tool;
}

function activityTarget(
  record: ActivityRecord,
  request: Record<string, ActivityAuditJsonValue> | undefined,
  result: Record<string, ActivityAuditJsonValue> | undefined,
  structured: Record<string, ActivityAuditJsonValue> | undefined,
): string {
  if (record.tool === "bash" || record.tool === "exec_command") return "Shell command";
  if (record.tool === "batch") {
    const tasks = arrayField(request, "tasks");
    return `${tasks?.length ?? 0} tasks`;
  }
  const paths = arrayField(request, "paths");
  if (paths && paths.length > 0) {
    if (record.tool === "read" || record.tool === "edit") return `${paths.length} files`;
    if (record.tool === "delete") return `${paths.length} paths`;
  }
  if (record.tool === "bash_result") {
    const processId = numberField(result, "processId") ?? numberField(request, "processId");
    const exitCode = numberField(result, "exitCode");
    const signal = stringField(result, "signal");
    const timedOut = booleanField(result, "timedOut");
    const outcome = timedOut
      ? "timed out"
      : signal
        ? `signal ${signal}`
        : exitCode !== undefined
          ? `exit ${exitCode}`
          : record.state === "failed"
            ? "failed"
            : "completed";
    return `Process ${processId ?? "?"} · ${outcome}`;
  }
  if (record.tool === "capability") {
    const name = stringField(request, "name") ?? "capability";
    const action = stringField(request, "action") ?? "run";
    return `${name} · ${action}`;
  }
  if (record.tool === "rename") {
    const from = stringField(request, "path")
      ?? stringField(request, "from")
      ?? stringField(request, "source");
    const to = stringField(request, "newPath")
      ?? stringField(request, "to")
      ?? stringField(request, "destination");
    return [from, to].filter((value): value is string => Boolean(value)).join(" → ") || "path";
  }
  const path = stringField(request, "path");
  if (path) return path;
  if (record.tool === "apply_patch") {
    const files = arrayField(structured, "files");
    const first = asRecord(files?.[0]);
    const firstPath = stringField(first, "path");
    if (firstPath) return files && files.length > 1 ? `${firstPath} +${files.length - 1}` : firstPath;
  }
  return record.tool;
}

function activityStatus(state: ActivityRecordState): ActivitySummaryStatus {
  if (state === "executing") return "working";
  if (state === "failed" || state === "blocked") return "error";
  return "done";
}

function bashPhase(state: ActivityRecordState): ActivityBashPhase {
  if (state === "executing") return "executing";
  if (state === "returned") return "returned";
  if (state === "failed" || state === "blocked") return "error";
  return "done";
}

function aggregateState(activities: ActivitySummary[]): ActivitySummaryStatus {
  if (activities.length === 0) return "working";
  if (activities.some((activity) => activity.status === "working")) return "working";
  if (activities.some((activity) => activity.status === "error")) return "error";
  return "done";
}

function activityOutputId(activity: ActivityRecord): string | undefined {
  const request = asRecord(activity.request);
  const result = asRecord(activity.result);
  const structured = asRecord(result?.structuredContent);
  return stringField(request, "outputId")
    ?? stringField(result, "outputId")
    ?? stringField(structured, "outputId");
}

function asRecord(value: ActivityAuditJsonValue | undefined): Record<string, ActivityAuditJsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, ActivityAuditJsonValue>
    : undefined;
}

function stringField(record: Record<string, ActivityAuditJsonValue> | undefined, key: string): string | undefined {
  return typeof record?.[key] === "string" ? record[key] as string : undefined;
}

function numberField(record: Record<string, ActivityAuditJsonValue> | undefined, key: string): number | undefined {
  return typeof record?.[key] === "number" ? record[key] as number : undefined;
}

function booleanField(record: Record<string, ActivityAuditJsonValue> | undefined, key: string): boolean | undefined {
  return typeof record?.[key] === "boolean" ? record[key] as boolean : undefined;
}

function arrayField(record: Record<string, ActivityAuditJsonValue> | undefined, key: string): ActivityAuditJsonValue[] | undefined {
  return Array.isArray(record?.[key]) ? record[key] as ActivityAuditJsonValue[] : undefined;
}

function elapsedMs(startedAt: string, updatedAt: string, state: ActivityRecordState): number | undefined {
  if (state === "executing") return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}
