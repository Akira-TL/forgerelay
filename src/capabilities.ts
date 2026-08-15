import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  markAdvertisedFileSourceActivated,
  resolveAdvertisedFileReadPath,
} from "./advertised-files.js";
import type { ServerConfig } from "./config.js";

export interface CapabilityFingerprint {
  version: string;
  toolMode: ServerConfig["toolMode"];
  capabilities: string[];
}

export interface CapabilityGuide {
  name: string;
  description: string;
  whenToRead: string;
  filePath: string;
  baseDir: string;
}

export interface CapabilityGuideReadResolution {
  absolutePath: string;
  guide: CapabilityGuide;
  isGuideFile: boolean;
}

export interface CapabilityFingerprintContext {
  artifactDownloadSupported?: boolean;
}

type CapabilityGuideConfig = Pick<ServerConfig, "subagents" | "artifactsEnabled" | "widgets" | "toolMode">;

type CapabilityGuideDefinition = {
  name: string;
  description: string;
  whenToRead: string;
  enabled?: (config: CapabilityGuideConfig) => boolean;
};

const CAPABILITY_GUIDE_DEFINITIONS: readonly CapabilityGuideDefinition[] = [
  {
    name: "lifecycle-hooks",
    description: "Hook events, blocking, reports, and configuration.",
    whenToRead: "Read for ForgeRelay Hook setup or debugging.",
  },
  {
    name: "managed-worktrees",
    description: "Managed-worktree lifecycle, close safety, and recovery.",
    whenToRead: "Read for advanced mode=\"worktree\" flows.",
  },
  {
    name: "subagents",
    description: "Local subagent delegation and session follow-up.",
    whenToRead: "Read when the user asks to delegate or use another coding agent.",
    enabled: (config) => config.subagents,
  },
  {
    name: "artifacts-review",
    description: "Native artifact transfer and aggregate change review.",
    whenToRead: "Read for host-provided files or aggregate change review.",
    enabled: (config) => config.artifactsEnabled || config.widgets === "changes",
  },
  {
    name: "host-integration",
    description: "OAuth, public endpoint, stale Host metadata, and MCP App debugging.",
    whenToRead: "Read for MCP connection, OAuth, deployment, or UI failures.",
  },
  {
    name: "shell-processes",
    description: "Long-running bash processes, processId interaction, PTY, and platform edges.",
    whenToRead: "Read for running or interactive command issues.",
  },
  {
    name: "code-intelligence",
    description: "Read-only semantic code navigation backed by external Language servers.",
    whenToRead: "Read before using code.intelligence or configuring Language servers.",
  },
  {
    name: "batch-execution",
    description: "One-call execution of multiple independent ForgeRelay core operations.",
    whenToRead: "Read before using batch.execute for heterogeneous multi-operation work.",
    enabled: (config) => config.toolMode !== "codex",
  },
];

function capabilityGuidesDir(): string {
  return fileURLToPath(new URL("../capabilities", import.meta.url));
}

export function loadCapabilityGuides(config: CapabilityGuideConfig): CapabilityGuide[] {
  const root = capabilityGuidesDir();
  return CAPABILITY_GUIDE_DEFINITIONS
    .filter((definition) => definition.enabled?.(config) ?? true)
    .map((definition) => {
      const baseDir = join(root, definition.name);
      return {
        name: definition.name,
        description: definition.description,
        whenToRead: definition.whenToRead,
        baseDir,
        filePath: join(baseDir, "GUIDE.md"),
      };
    });
}

export function resolveCapabilityGuideReadPath(
  guides: CapabilityGuide[],
  activatedGuideDirs: Set<string>,
  inputPath: string,
): CapabilityGuideReadResolution | undefined {
  const resolution = resolveAdvertisedFileReadPath(guides, activatedGuideDirs, inputPath);
  if (!resolution) return undefined;

  return {
    absolutePath: resolution.absolutePath,
    guide: resolution.source,
    isGuideFile: resolution.isEntryFile,
  };
}

export function markCapabilityGuideActivated(
  activatedGuideDirs: Set<string>,
  guide: CapabilityGuide,
): void {
  markAdvertisedFileSourceActivated(activatedGuideDirs, guide);
}

export function buildCapabilityFingerprint(
  config: ServerConfig,
  version: string,
  context: CapabilityFingerprintContext = {},
): CapabilityFingerprint {
  const capabilities = [
    "workspace.close",
    "worktree.managed",
    "filesystem.rename-move",
    "filesystem.delete",
    "process.lifecycle",
    "hooks.lifecycle",
    "capability-guides.read",
    "code.intelligence",
  ];

  if (config.toolMode !== "codex") {
    capabilities.push("batch.execute");
  }

  if (config.subagents) {
    capabilities.push("subagent.profiles");
  }
  if (config.artifactsEnabled && context.artifactDownloadSupported) {
    capabilities.push("artifact.native-download");
  }
  if (config.widgets !== "off") {
    capabilities.push("ui.mcp-app");
  }
  if (config.widgets === "changes") {
    capabilities.push("review.changes");
  }

  return {
    version,
    toolMode: config.toolMode,
    capabilities,
  };
}
