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

const CAPABILITY_GUIDE_DEFINITIONS = [
  {
    name: "lifecycle-hooks",
    description: "ForgeRelay lifecycle Hook events, blocking semantics, reports, and configuration.",
    whenToRead: "Read when adding, changing, debugging, or explaining ForgeRelay Hooks.",
  },
  {
    name: "managed-worktrees",
    description: "Advanced managed-worktree lifecycle, close behavior, safety checks, and recovery.",
    whenToRead: "Read when using or troubleshooting mode=\"worktree\" beyond the basic open/close flow.",
  },
] as const;

function capabilityGuidesDir(): string {
  return fileURLToPath(new URL("../capabilities", import.meta.url));
}

export function loadCapabilityGuides(): CapabilityGuide[] {
  const root = capabilityGuidesDir();
  return CAPABILITY_GUIDE_DEFINITIONS.map((definition) => {
    const baseDir = join(root, definition.name);
    return {
      ...definition,
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
