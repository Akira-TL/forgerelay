export const DEFAULT_EXEC_YIELD_MS = 10_000;
export const DEFAULT_INTERACTIVE_YIELD_MS = 250;
export const DEFAULT_POLL_YIELD_MS = 60_000;
export const MAX_START_YIELD_MS = 300_000;
export const MAX_COMMAND_YIELD_MS = 300_000;
export const MAX_POLL_YIELD_MS = 300_000;
const MAX_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export function boundedDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return Math.min(fallback, maximum);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

export function executionTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error(`Execution timeout must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_MS}ms.`);
  }
  return value;
}

export function minimumPollYield(value: number | undefined): number {
  const resolved = value ?? DEFAULT_POLL_YIELD_MS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_POLL_YIELD_MS) {
    throw new Error(`Minimum poll yield must be an integer between 1 and ${MAX_POLL_YIELD_MS}ms.`);
  }
  return resolved;
}

export function waitOnlyYieldMs(
  requested: number | undefined,
  minimum = DEFAULT_POLL_YIELD_MS,
): number {
  const resolvedMinimum = minimumPollYield(minimum);
  return Math.max(
    resolvedMinimum,
    boundedDuration(requested, resolvedMinimum, MAX_POLL_YIELD_MS),
  );
}
