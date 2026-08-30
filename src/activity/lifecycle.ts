import { randomUUID } from "node:crypto";
import { HookExecutionError } from "../hooks.js";
import {
  ActivityAuditStore,
  type ActivityAuditJsonValue,
  type ActivityWorkspaceSnapshot,
} from "./audit-store.js";

export type ActivityOutcome =
  | { type: "succeeded" }
  | { type: "returned" }
  | { type: "failed"; error: string };

export interface ActivityExecutionContext {
  activityId: string;
  turnId: string;
  parentActivityId?: string;
  conversationScopeId?: string;
}

export interface ActivityRunOptions<T> {
  activityId?: string;
  turnId?: string;
  parentActivityId?: string;
  conversationScopeId?: string;
  tool: string;
  workspace: ActivityWorkspaceSnapshot;
  request?: unknown;
  operation: (context: ActivityExecutionContext) => Promise<T>;
  outcome?: (result: T) => ActivityOutcome;
  auditResult?: (result: T) => unknown;
}

export interface ActivityRecordOptions {
  activityId?: string;
  turnId?: string;
  parentActivityId?: string;
  conversationScopeId?: string;
  tool: string;
  workspace: ActivityWorkspaceSnapshot;
  request?: unknown;
  result?: unknown;
  outcome: ActivityOutcome;
}

export interface LinkedActivityRecordOptions extends Omit<ActivityRecordOptions, "workspace" | "conversationScopeId"> {
  sourceActivityId: string;
}

export interface ActivityLifecycleOptions {
  activityId?: () => string;
  turnId?: () => string;
  turnIdForConversation?: (
    conversationScopeId: string | undefined,
    workspaceId: string | undefined,
  ) => string | undefined;
}

export class ActivityLifecycle {
  private readonly activityId: () => string;
  private readonly turnId: () => string;
  private readonly turnIdForConversation?: (
    conversationScopeId: string | undefined,
    workspaceId: string | undefined,
  ) => string | undefined;

  constructor(
    private readonly auditStore: ActivityAuditStore,
    options: ActivityLifecycleOptions = {},
  ) {
    this.activityId = options.activityId ?? newActivityId;
    this.turnId = options.turnId ?? newTurnId;
    this.turnIdForConversation = options.turnIdForConversation;
  }

  record(options: ActivityRecordOptions): ActivityExecutionContext {
    const context = this.start(options);
    this.finish(context.activityId, options.result, options.outcome);
    return context;
  }

  recordLinked(options: LinkedActivityRecordOptions): ActivityExecutionContext {
    const source = this.auditStore.getActivity(options.sourceActivityId);
    if (!source) throw new Error(`Unknown source Activity: ${options.sourceActivityId}`);
    const { sourceActivityId: _sourceActivityId, ...record } = options;
    return this.record({
      ...record,
      ...(source.conversationScopeId ? { conversationScopeId: source.conversationScopeId } : {}),
      workspace: source.workspace,
    });
  }

  async run<T>(options: ActivityRunOptions<T>): Promise<T> {
    const executionContext = this.start(options);
    const activityId = executionContext.activityId;

    try {
      const result = await options.operation(executionContext);
      this.finish(
        activityId,
        options.auditResult?.(result) ?? result,
        options.outcome?.(result) ?? { type: "succeeded" as const },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.auditStore.append(
        error instanceof HookExecutionError && error.event === "BeforeTool"
          ? { type: "blocked", activityId, error: message }
          : { type: "failed", activityId, error: message },
      );
      throw error;
    }
  }

  private start(options: {
    activityId?: string;
    turnId?: string;
    parentActivityId?: string;
    conversationScopeId?: string;
    tool: string;
    workspace: ActivityWorkspaceSnapshot;
    request?: unknown;
  }): ActivityExecutionContext {
    const activityId = options.activityId ?? this.activityId();
    const turnId = options.turnId
      ?? this.turnIdForConversation?.(options.conversationScopeId, options.workspace.id)
      ?? this.turnId();
    const request = normalizeAuditValue(options.request);
    this.auditStore.append({
      type: "started",
      activityId,
      turnId,
      ...(options.parentActivityId ? { parentActivityId: options.parentActivityId } : {}),
      ...(options.conversationScopeId ? { conversationScopeId: options.conversationScopeId } : {}),
      tool: options.tool,
      workspace: options.workspace,
      ...(request !== undefined ? { request } : {}),
    });
    return {
      activityId,
      turnId,
      ...(options.parentActivityId ? { parentActivityId: options.parentActivityId } : {}),
      ...(options.conversationScopeId ? { conversationScopeId: options.conversationScopeId } : {}),
    };
  }

  private finish(activityId: string, result: unknown, outcome: ActivityOutcome): void {
    const normalizedResult = normalizeAuditValue(result);
    switch (outcome.type) {
      case "succeeded":
      case "returned":
        this.auditStore.append({
          type: outcome.type,
          activityId,
          ...(normalizedResult !== undefined ? { result: normalizedResult } : {}),
        });
        break;
      case "failed":
        this.auditStore.append({
          type: "failed",
          activityId,
          ...(normalizedResult !== undefined ? { result: normalizedResult } : {}),
          error: outcome.error,
        });
        break;
    }
  }
}

function newActivityId(): string {
  return `act_${randomUUID().replaceAll("-", "")}`;
}

function newTurnId(): string {
  return `turn_${randomUUID().replaceAll("-", "")}`;
}

export function normalizeAuditValue(value: unknown): ActivityAuditJsonValue | undefined {
  return normalizeAuditValueInternal(value, new WeakSet<object>());
}

function normalizeAuditValueInternal(
  value: unknown,
  seen: WeakSet<object>,
): ActivityAuditJsonValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (value instanceof Uint8Array) {
    return {
      type: "bytes",
      encoding: "base64",
      data: Buffer.from(value).toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAuditValueInternal(entry, seen) ?? null);
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  try {
    const normalized: Record<string, ActivityAuditJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = normalizeAuditValueInternal(entry, seen);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}
