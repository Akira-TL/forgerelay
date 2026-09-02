import type { ActivityAuditStore } from "../audit-store.js";
import type { BashOutputStore } from "../bash-output-store.js";
import type { HostTurnStore } from "../host-turn-store.js";
import { removeWorkspaceActivityStorage } from "./paths.js";

/**
 * User-requested Workspace deletion is the retention boundary for durable
 * Activity history by default. Index rows are removed before the backing files
 * so a crash cannot leave SQLite pointing at already-deleted payload shards.
 */
export function deleteWorkspaceActivityHistory(input: {
  stateDir: string;
  workspaceId: string;
  audit: ActivityAuditStore;
  outputs: BashOutputStore;
  turns: HostTurnStore;
}): void {
  input.outputs.deleteWorkspace(input.workspaceId);
  input.audit.deleteWorkspace(input.workspaceId);
  input.turns.deleteWorkspace(input.workspaceId);
  removeWorkspaceActivityStorage(input.stateDir, input.workspaceId);
}
