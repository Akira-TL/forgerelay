import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ACTIVITY_PANEL_APP_MANIFEST_ENTRY = "activity-panel-app.html";

// Host caches are keyed by the ui:// resource URI, so the revision must cover
// both bundle assets and the HTML/resource contract that serves them. Bump this
// whenever either side changes so a Host never reuses stale UI bytes.
export const MCP_APP_RESOURCE_TEMPLATE_REVISION = "5";

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  dependencies?: string[];
  isEntry?: boolean;
}

interface RawWorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, RawWorkspaceAppManifestEntry>;

interface AppIdentityOptions {
  manifestUrl: URL;
  buildDirectoryUrl: URL;
  manifestEntry: string;
  fallbackRevision: string;
  resourceTemplateRevision?: string;
  uriForRevision: (revision: string) => string;
}

export interface WorkspaceAppIdentityOptions {
  manifestUrl: URL;
  buildDirectoryUrl: URL;
  fallbackRevision: string;
  resourceTemplateRevision?: string;
}

export interface WorkspaceAppIdentity {
  revision: string;
  uri: string;
  source: "bundle" | "fallback";
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

  const css: string[] = [];
  const dependencies: string[] = [];
  const seenCss = new Set<string>();
  const seenDependencies = new Set<string>();
  const visitedEntries = new Set<string>();

  const visit = (key: string, root = false): void => {
    if (visitedEntries.has(key)) return;
    visitedEntries.add(key);

    const current = manifest[key];
    if (!current?.file) {
      throw new Error(`Missing imported UI manifest entry ${key}.`);
    }

    if (!root && !seenDependencies.has(current.file)) {
      dependencies.push(current.file);
      seenDependencies.add(current.file);
    }
    for (const stylesheet of current.css ?? []) {
      if (seenCss.has(stylesheet)) continue;
      css.push(stylesheet);
      seenCss.add(stylesheet);
    }
    for (const imported of current.imports ?? []) visit(imported);
  };

  visit(manifestEntry, true);

  return {
    file: entry.file,
    ...(css.length > 0 ? { css } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(entry.isEntry !== undefined ? { isEntry: entry.isEntry } : {}),
  };
}

export function readActivityPanelAppManifestEntry(manifestUrl: URL): WorkspaceAppManifestEntry {
  return readMcpAppManifestEntry(manifestUrl, ACTIVITY_PANEL_APP_MANIFEST_ENTRY);
}

export function workspaceAppBundleRevision(
  entry: WorkspaceAppManifestEntry,
  buildDirectoryUrl: URL,
  resourceTemplateRevision = MCP_APP_RESOURCE_TEMPLATE_REVISION,
): string {
  const hash = createHash("sha256");
  hash.update("resource-template\0");
  hash.update(resourceTemplateRevision);
  hash.update("\0");
  const assetPaths = [
    entry.file,
    ...(entry.dependencies ?? []),
    ...(entry.css ?? []),
  ];

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
    const revision = workspaceAppBundleRevision(
      entry,
      options.buildDirectoryUrl,
      options.resourceTemplateRevision,
    );
    return {
      revision,
      uri: options.uriForRevision(revision),
      source: "bundle",
    };
  } catch {
    const revision = options.resourceTemplateRevision
      ? createHash("sha256")
        .update("fallback\0")
        .update(options.fallbackRevision)
        .update("\0resource-template\0")
        .update(options.resourceTemplateRevision)
        .digest("hex")
        .slice(0, 12)
      : options.fallbackRevision;
    return {
      revision,
      uri: options.uriForRevision(revision),
      source: "fallback",
    };
  }
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
