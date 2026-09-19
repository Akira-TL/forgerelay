import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/client";

const REMOTE_WAIT_HEADROOM_MS = 5_000;
const DEFAULT_WAIT_ONLY_YIELD_MS = 60_000;
const DEFAULT_RUN_YIELD_MS = 10_000;
const DEFAULT_INTERACTION_YIELD_MS = 250;

export function remoteToolCallTimeoutMs(
  name: string,
  args: Record<string, unknown>,
): number | undefined {
  const waitMs = remoteToolWaitMs(name, args);
  if (waitMs === undefined || waitMs < DEFAULT_REQUEST_TIMEOUT_MSEC) return undefined;
  return waitMs + REMOTE_WAIT_HEADROOM_MS;
}

function remoteToolWaitMs(
  name: string,
  args: Record<string, unknown>,
): number | undefined {
  const requested = numberField(args.yieldTimeMs);
  if (name === "bash") {
    const action = typeof args.action === "string" ? args.action : "run";
    if (action === "output") return undefined;
    if (action === "run") return requested ?? DEFAULT_RUN_YIELD_MS;
    if (action !== "process") return undefined;
    return processControlWaitMs(
      requested,
      typeof args.input === "string" && args.input.length > 0 ||
        args.interrupt === true ||
        args.columns !== undefined ||
        args.rows !== undefined,
    );
  }
  if (name === "exec_command") return requested ?? DEFAULT_RUN_YIELD_MS;
  if (name !== "write_stdin" || args.outputId !== undefined) return undefined;
  return processControlWaitMs(
    requested,
    typeof args.chars === "string" && args.chars.length > 0 ||
      args.columns !== undefined ||
      args.rows !== undefined,
  );
}

function processControlWaitMs(
  requested: number | undefined,
  interactionRequested: boolean,
): number {
  if (interactionRequested) return requested ?? DEFAULT_INTERACTION_YIELD_MS;
  if (requested === 0) return 0;
  return Math.max(DEFAULT_WAIT_ONLY_YIELD_MS, requested ?? DEFAULT_WAIT_ONLY_YIELD_MS);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
