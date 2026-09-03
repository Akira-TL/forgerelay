import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { Response } from "express";
import type { ServerConfig } from "../../runtime/config/config.js";
import { logEvent, transportSessionIdPrefix } from "../../runtime/logging/logger.js";
import {
  MCP_APP_RESOURCE_TEMPLATE_REVISION,
  readActivityPanelAppManifestEntry,
  resolveActivityPanelAppIdentity,
  type WorkspaceAppManifestEntry,
} from "./mcp-app-template.js";

export interface ActivityPanelApp {
  uri: string;
  resourceMetadata: {
    description: string;
    _meta: {
      ui: {
        domain: string;
        csp: ActivityPanelCsp;
      };
    };
  };
  toolMeta: {
    _meta: Record<string, unknown> | {
      ui: {
        resourceUri: string;
        visibility: ["model", "app"];
      };
    };
  };
  readResource(requestedUri: string, transportSessionId?: string): Promise<{
    contents: Array<{
      uri: string;
      mimeType: string;
      text: string;
      _meta: {
        ui: { domain: string; csp: ActivityPanelCsp };
        domain: string;
        csp: ActivityPanelCsp;
      };
    }>;
  }>;
}

interface ActivityPanelCsp {
  resourceDomains: string[];
  connectDomains: string[];
}

const cachedIdentities = new Map<
  string,
  ReturnType<typeof resolveActivityPanelAppIdentity>
>();

/**
 * Build the complete Host-facing Activity Panel resource contract. Keeping URI
 * identity, CSP, bootstrap HTML, and tool metadata in one module prevents a UI
 * revision from changing on one surface while another surface keeps stale Host
 * cache metadata.
 */
export function createActivityPanelApp(
  config: ServerConfig,
  fallbackRevision: string,
): ActivityPanelApp {
  const identity = currentIdentity(config, fallbackRevision);
  const domain = new URL(config.publicBaseUrl).origin;
  const csp = activityPanelCsp(config);

  return {
    uri: identity.uri,
    resourceMetadata: {
      description: "ForgeRelay unified Workspace and Activity UI for one Host Turn.",
      _meta: { ui: { domain, csp } },
    },
    toolMeta: config.widgets === "off"
      ? { _meta: {} }
      : {
          _meta: {
            ui: {
              resourceUri: identity.uri,
              visibility: ["model", "app"],
            },
          },
        },
    readResource: (requestedUri, transportSessionId) =>
      readActivityPanelAppResource(
        config,
        fallbackRevision,
        requestedUri,
        transportSessionId,
      ),
  };
}

export function activityPanelAssetDirectory(): string {
  return fileURLToPath(new URL("../../../dist/ui", import.meta.url));
}

export function setActivityPanelAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function appResourceContractRevision(config: ServerConfig): string {
  return [
    MCP_APP_RESOURCE_TEMPLATE_REVISION,
    `publicBaseUrls=${JSON.stringify(config.publicBaseUrls)}`,
  ].join("\0");
}

function currentIdentity(
  config: ServerConfig,
  fallbackRevision: string,
): ReturnType<typeof resolveActivityPanelAppIdentity> {
  const contractRevision = appResourceContractRevision(config);
  const cacheKey = `${fallbackRevision}\0${contractRevision}`;
  let identity = cachedIdentities.get(cacheKey);
  if (!identity) {
    identity = resolveActivityPanelAppIdentity({
      manifestUrl: uiManifestUrl(),
      buildDirectoryUrl: uiBuildDirectoryUrl(),
      fallbackRevision,
      resourceTemplateRevision: contractRevision,
    });
    cachedIdentities.set(cacheKey, identity);
  }
  return identity;
}

function activityPanelCsp(config: ServerConfig): ActivityPanelCsp {
  return {
    resourceDomains: [...config.publicBaseUrls],
    connectDomains: [...config.publicBaseUrls],
  };
}

async function readActivityPanelAppResource(
  config: ServerConfig,
  fallbackRevision: string,
  requestedUri: string,
  transportSessionId?: string,
) {
  const identity = currentIdentity(config, fallbackRevision);
  const entry = readActivityPanelAppManifestEntry(uiManifestUrl());
  const domain = new URL(config.publicBaseUrl).origin;
  const csp = activityPanelCsp(config);

  try {
    await assertMcpAppAssets(entry);
    const result = {
      contents: [{
        uri: requestedUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: activityPanelAppHtml(config, entry),
        _meta: {
          ui: { domain, csp },
          // MCP Apps defines these values under `_meta.ui`. Inspector 2.3.0
          // still reads them directly from the content-item metadata, so mirror
          // them until that installed-host compatibility gap is retired.
          domain,
          csp,
        },
      }],
    };
    logEvent(config.logging, "debug", "mcp_app_template_read", {
      requestedUri,
      currentUri: identity.uri,
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
    });
    return result;
  } catch (error) {
    logEvent(config.logging, "warn", "mcp_app_template_read_failed", {
      requestedUri,
      currentUri: identity.uri,
      error: error instanceof Error ? error.message : String(error),
      transportSessionIdPrefix: transportSessionIdPrefix(transportSessionId),
    });
    throw error;
  }
}

function activityPanelAppHtml(
  config: ServerConfig,
  entry: WorkspaceAppManifestEntry,
): string {
  const baseUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
  const assetUrl = (assetPath: string) => `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
  const stylesheets = (entry.css ?? [])
    .map((stylesheet) =>
      `    <link rel="stylesheet" crossorigin href="${assetUrl(stylesheet)}" />`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ForgeRelay Activity Panel</title>
    <script type="module" crossorigin src="${assetUrl(entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for Activity Panel state.</section>
    </main>
  </body>
</html>`;
}

async function assertMcpAppAssets(entry: WorkspaceAppManifestEntry): Promise<void> {
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../../../dist/ui/${assetPath}`, import.meta.url),
  );
  for (const candidate of candidates) await access(candidate);
}

function uiManifestUrl(): URL {
  return new URL("../../../dist/ui/.vite/manifest.json", import.meta.url);
}

function uiBuildDirectoryUrl(): URL {
  return new URL("../../../dist/ui/", import.meta.url);
}
