import type { CapabilityRunOperationInput } from "../../../operations/core-operation-executor.js";

export function capabilityActivityAuditRequest(input: CapabilityRunOperationInput): unknown {
  if (input.name !== "subagent.session") {
    return {
      workspaceId: input.workspaceId,
      name: input.name,
      action: "run",
      arguments: input.arguments,
      file: input.file,
    };
  }
  const argumentsValue = isAuditRecord(input.arguments) ? input.arguments : {};
  return {
    workspaceId: input.workspaceId,
    name: input.name,
    action: "run",
    arguments: {
      operation: argumentsValue.operation,
      ...(typeof argumentsValue.target === "string" ? { target: argumentsValue.target } : {}),
      ...(typeof argumentsValue.sessionId === "string" ? { sessionId: argumentsValue.sessionId } : {}),
      ...(typeof argumentsValue.model === "string" ? { model: argumentsValue.model } : {}),
      ...(typeof argumentsValue.thinking === "string" ? { thinking: argumentsValue.thinking } : {}),
      ...(typeof argumentsValue.prompt === "string" ? { promptLength: argumentsValue.prompt.length } : {}),
    },
  };
}

export function capabilityActivityAuditResult(name: string, result: unknown): unknown {
  if (name !== "subagent.session" || !isAuditRecord(result)) return result;
  const structuredContent = isAuditRecord(result.structuredContent) ? result.structuredContent : undefined;
  const capabilityResult = structuredContent && isAuditRecord(structuredContent.result)
    ? structuredContent.result
    : undefined;
  const error = structuredContent && isAuditRecord(structuredContent.error)
    ? structuredContent.error
    : undefined;
  return {
    name,
    action: "run",
    ...(capabilityResult ? { result: summarizeSubagentCapabilityResult(capabilityResult) } : {}),
    ...(error
      ? {
          error: {
            code: error.code,
            message: error.message,
          },
        }
      : {}),
  };
}

function isAuditRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeSubagentCapabilityResult(result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = { operation: result.operation };
  const session = isAuditRecord(result.session) ? result.session : undefined;
  if (session) {
    summary.session = {
      id: session.id,
      status: session.status,
      profileName: session.profileName,
      provider: session.provider,
      model: session.model,
      thinking: session.thinking,
    };
  }
  for (const key of ["run", "activeRun", "latestRun"] as const) {
    const run = isAuditRecord(result[key]) ? result[key] : undefined;
    if (run) summary[key] = { id: run.id, status: run.status };
  }
  if (Array.isArray(result.sessions)) {
    summary.sessions = result.sessions.flatMap((entry) => {
      if (!isAuditRecord(entry)) return [];
      return [{
        id: entry.id,
        status: entry.status,
        profileName: entry.profileName,
        provider: entry.provider,
        activeRunId: entry.activeRunId,
      }];
    });
  }
  return summary;
}
