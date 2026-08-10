import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
export const WORKSPACE_APP_LEGACY_URI = "ui://forgerelay/workspace-app.html";
export const WORKSPACE_APP_URI_TEMPLATE = "ui://forgerelay/workspace-app-{revision}.html";

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export interface WorkspaceAppIdentityOptions {
  manifestUrl: URL;
  buildDirectoryUrl: URL;
  fallbackRevision: string;
}

export interface WorkspaceAppIdentity {
  revision: string;
  uri: string;
  source: "bundle" | "fallback";
}

export function workspaceAppUriForRevision(revision: string): string {
  return `ui://forgerelay/workspace-app-${encodeURIComponent(revision)}.html`;
}

export function readWorkspaceAppManifestEntry(manifestUrl: URL): WorkspaceAppManifestEntry {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as WorkspaceAppManifest;
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

export function workspaceAppBundleRevision(
  entry: WorkspaceAppManifestEntry,
  buildDirectoryUrl: URL,
): string {
  const hash = createHash("sha256");
  const assetPaths = [entry.file, ...(entry.css ?? [])];

  for (const assetPath of assetPaths) {
    hash.update(assetPath);
    hash.update("\0");
    hash.update(readFileSync(new URL(assetPath, buildDirectoryUrl)));
    hash.update("\0");
  }

  return hash.digest("hex").slice(0, 12);
}

export function resolveWorkspaceAppIdentity(
  options: WorkspaceAppIdentityOptions,
): WorkspaceAppIdentity {
  try {
    const entry = readWorkspaceAppManifestEntry(options.manifestUrl);
    const revision = workspaceAppBundleRevision(entry, options.buildDirectoryUrl);
    return {
      revision,
      uri: workspaceAppUriForRevision(revision),
      source: "bundle",
    };
  } catch {
    return {
      revision: options.fallbackRevision,
      uri: workspaceAppUriForRevision(options.fallbackRevision),
      source: "fallback",
    };
  }
}
