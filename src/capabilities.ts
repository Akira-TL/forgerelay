import type { ServerConfig } from "./config.js";

export interface CapabilityFingerprint {
  version: string;
  toolMode: ServerConfig["toolMode"];
  capabilities: string[];
}

export function buildCapabilityFingerprint(
  config: ServerConfig,
  version: string,
): CapabilityFingerprint {
  const capabilities = [
    "workspace.close",
    "worktree.managed",
    "filesystem.rename-move",
    "filesystem.delete",
    "process.write-stdin",
  ];

  if (config.toolMode === "full") {
    capabilities.push("inspection.search-tools");
  }

  return {
    version,
    toolMode: config.toolMode,
    capabilities,
  };
}
