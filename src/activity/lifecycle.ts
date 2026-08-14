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

export interface ActivityRunOptions<T> {
  activityId?: string;
  turnId?: string;
  conversationScopeId?: string;
  tool: string;
  workspace: ActivityWorkspaceSnapshot;
  request?: unknown;
  operation: () => Promise<T>;
  outcome?: (result: T) => ActivityOutcome;
}

export interface ActivityLifecycleOptions {
  activityId?: () => string;
  turnId?: () => string;
}

export class ActivityLifecycle {
  private readonly activityId: () => string;
  private readonly turnId: () => string;

  constructor(
    private readonly auditStore: ActivityAuditStore,
    options: ActivityLifecycleOptions = {},
  ) {
    this.activityId = options.activityId ?? newActivityId;
    this.turnId = options.turnId ?? newTurnId;
  }

  async run<T>(options: ActivityRunOptions<T>): Promise<T> {
    const activityId = options.activityId ?? this.activityId();
    const turnId = options.turnId ?? this.turnId();
    const request = normalizeAuditValue(options.request);

    this.auditStore.append({
      type: "started",
      activityId,
      turnId,
      ...(options.conversationScopeId ? { conversationScopeId: options.conversationScopeId } : {}),
      tool: options.tool,
      workspace: options.workspace,
      ...(request !== undefined ? { request } : {}),
    });

    try {
      const result = await options.operation();
      const normalizedResult = normalizeAuditValue(result);
      const outcome = options.outcome?.(result) ?? { type: "succeeded" as const };
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
