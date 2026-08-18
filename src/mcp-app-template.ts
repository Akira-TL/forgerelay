import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
export const WORKSPACE_LIFECYCLE_APP_MANIFEST_ENTRY = "workspace-lifecycle-app.html";
export const ACTIVITY_PANEL_APP_MANIFEST_ENTRY = "activity-panel-app.html";

// Historical mixed-widget resource. Keep serving it so existing ChatGPT Web
// conversations can still render cards created before the UI split.
export const WORKSPACE_APP_LEGACY_URI = "ui://forgerelay/workspace-app.html";
export const WORKSPACE_APP_URI_TEMPLATE = "ui://forgerelay/workspace-app-{revision}.html";

export const WORKSPACE_LIFECYCLE_APP_LEGACY_URI =
  "ui://forgerelay/workspace-lifecycle-app.html";
export const WORKSPACE_LIFECYCLE_APP_URI_TEMPLATE =
  "ui://forgerelay/workspace-lifecycle-app-{revision}.html";
export const ACTIVITY_PANEL_APP_LEGACY_URI = "ui://forgerelay/activity-panel-app.html";
export const ACTIVITY_PANEL_APP_URI_TEMPLATE =
  "ui://forgerelay/activity-panel-app-{revision}.html";

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface AppIdentityOptions {
  manifestUrl: URL;
  buildDirectoryUrl: URL;
  manifestEntry: string;
  fallbackRevision: string;
  uriForRevision: (revision: string) => string;
}

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

export function workspaceLifecycleAppUriForRevision(revision: string): string {
  return `ui://forgerelay/workspace-lifecycle-app-${encodeURIComponent(revision)}.html`;
}

export function activityPanelAppUriForRevision(revision: string): string {
  return `ui://forgerelay/activity-panel-app-${encodeURIComponent(revision)}.html`;
}

export function readMcpAppManifestEntry(
  manifestUrl: URL,
  manifestEntry: string,
): WorkspaceAppManifestEntry {
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as WorkspaceAppManifest;
  const entry = manifest[manifestEntry];

  if (!entry?.file) {
    throw new Error(`Missing ${manifestEntry} in UI manifest.`);
  }

  return entry;
}

export function readWorkspaceAppManifestEntry(manifestUrl: URL): WorkspaceAppManifestEntry {
  return readMcpAppManifestEntry(manifestUrl, WORKSPACE_APP_MANIFEST_ENTRY);
}

export function readWorkspaceLifecycleAppManifestEntry(manifestUrl: URL): WorkspaceAppManifestEntry {
  return readMcpAppManifestEntry(manifestUrl, WORKSPACE_LIFECYCLE_APP_MANIFEST_ENTRY);
}

export function readActivityPanelAppManifestEntry(manifestUrl: URL): WorkspaceAppManifestEntry {
  return readMcpAppManifestEntry(manifestUrl, ACTIVITY_PANEL_APP_MANIFEST_ENTRY);
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

function resolveAppIdentity(options: AppIdentityOptions): WorkspaceAppIdentity {
  try {
    const entry = readMcpAppManifestEntry(options.manifestUrl, options.manifestEntry);
    const revision = workspaceAppBundleRevision(entry, options.buildDirectoryUrl);
    return {
      revision,
      uri: options.uriForRevision(revision),
      source: "bundle",
    };
  } catch {
    return {
      revision: options.fallbackRevision,
      uri: options.uriForRevision(options.fallbackRevision),
      source: "fallback",
    };
  }
}

export function resolveWorkspaceAppIdentity(
  options: WorkspaceAppIdentityOptions,
): WorkspaceAppIdentity {
  return resolveAppIdentity({
    ...options,
    manifestEntry: WORKSPACE_APP_MANIFEST_ENTRY,
    uriForRevision: workspaceAppUriForRevision,
  });
}

export function resolveWorkspaceLifecycleAppIdentity(
  options: WorkspaceAppIdentityOptions,
): WorkspaceAppIdentity {
  return resolveAppIdentity({
    ...options,
    manifestEntry: WORKSPACE_LIFECYCLE_APP_MANIFEST_ENTRY,
    uriForRevision: workspaceLifecycleAppUriForRevision,
  });
}

export function resolveActivityPanelAppIdentity(
  options: WorkspaceAppIdentityOptions,
): WorkspaceAppIdentity {
  return resolveAppIdentity({
    ...options,
    manifestEntry: ACTIVITY_PANEL_APP_MANIFEST_ENTRY,
    uriForRevision: activityPanelAppUriForRevision,
  });
}
