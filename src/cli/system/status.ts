import { loadConfig } from "../../runtime/config/config.js";
import { loadForgeRelayFiles } from "../../runtime/config/user-config.js";
import { inspectRuntimeLease, type RuntimeLeaseInspection } from "../../runtime/state/runtime-lease.js";

export interface SystemStatusSnapshot {
  instanceId?: string;
  stateDir: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  lease: RuntimeLeaseInspection;
}

export function inspectSystemStatus(env: NodeJS.ProcessEnv = process.env): SystemStatusSnapshot {
  const files = loadForgeRelayFiles(env);
  const config = loadConfig(env);
  return {
    ...(files.auth.instanceId?.trim() ? { instanceId: files.auth.instanceId.trim() } : {}),
    stateDir: config.stateDir,
    host: config.host,
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    lease: inspectRuntimeLease(config.stateDir),
  };
}

export function runSystemStatus(env: NodeJS.ProcessEnv = process.env): void {
  const status = inspectSystemStatus(env);
  console.log([
    "ForgeRelay system status",
    "",
    `Instance: ${status.instanceId ?? "not initialized"}`,
    `Runtime: ${formatRuntimeState(status.lease)}`,
    ...(status.lease.pid === undefined ? [] : [`PID: ${status.lease.pid}`]),
    `State dir: ${status.stateDir}`,
    `Configured bind: ${status.host}:${status.port}`,
    `Configured public URL: ${status.publicBaseUrl}`,
  ].join("\n"));
}

function formatRuntimeState(lease: RuntimeLeaseInspection): string {
  if (lease.malformed) return "unknown (malformed runtime lease)";
  if (lease.active) return "running";
  if (lease.stale) return "not running (stale runtime lease present)";
  return "not running";
}
