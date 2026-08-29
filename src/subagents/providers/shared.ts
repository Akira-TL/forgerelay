import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function directString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertPipedChild(
  child: ReturnType<typeof spawn>,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

export function unwrapProviderPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  return record.data ?? record.result ?? value;
}

export function readArray(record: unknown, key: string): unknown[] | undefined {
  const value = asRecord(record)?.[key];
  return Array.isArray(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function readNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireFinalResponse(provider: string, response: string): string {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new Error(`${provider} did not return a final assistant response.`);
  }
  return trimmed;
}
