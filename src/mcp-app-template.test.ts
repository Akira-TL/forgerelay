import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ACTIVITY_PANEL_APP_LEGACY_URI,
  ACTIVITY_PANEL_APP_URI_TEMPLATE,
  activityPanelAppUriForRevision,
  readWorkspaceAppManifestEntry,
  resolveActivityPanelAppIdentity,
  resolveWorkspaceAppIdentity,
  resolveWorkspaceLifecycleAppIdentity,
  WORKSPACE_APP_LEGACY_URI,
  WORKSPACE_APP_MANIFEST_ENTRY,
  WORKSPACE_APP_URI_TEMPLATE,
  WORKSPACE_LIFECYCLE_APP_LEGACY_URI,
  WORKSPACE_LIFECYCLE_APP_URI_TEMPLATE,
  workspaceLifecycleAppUriForRevision,
  workspaceAppBundleRevision,
  workspaceAppUriForRevision,
} from "./mcp-app-template.js";

test("workspace app identity hashes the built JavaScript and CSS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-app-template-test-"));
  const buildDir = join(root, "ui");
  const manifestDir = join(buildDir, ".vite");
  await mkdir(join(buildDir, "assets"), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(buildDir, "assets", "workspace-app.js"), "console.log('one');\n");
  await writeFile(join(buildDir, "assets", "workspace-app.css"), ".app { color: red; }\n");
  await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({
    [WORKSPACE_APP_MANIFEST_ENTRY]: {
      file: "assets/workspace-app.js",
      css: ["assets/workspace-app.css"],
      isEntry: true,
    },
  }));

  const manifestUrl = pathToFileURL(join(manifestDir, "manifest.json"));
  const buildDirectoryUrl = pathToFileURL(`${buildDir}/`);
  const entry = readWorkspaceAppManifestEntry(manifestUrl);
  const firstRevision = workspaceAppBundleRevision(entry, buildDirectoryUrl);
  const first = resolveWorkspaceAppIdentity({
    manifestUrl,
    buildDirectoryUrl,
    fallbackRevision: "0.2.5",
  });

  assert.equal(first.source, "bundle");
  assert.equal(first.revision, firstRevision);
  assert.match(first.revision, /^[0-9a-f]{12}$/);
  assert.equal(first.uri, workspaceAppUriForRevision(first.revision));

  await writeFile(join(buildDir, "assets", "workspace-app.css"), ".app { color: blue; }\n");
  const cssChanged = resolveWorkspaceAppIdentity({
    manifestUrl,
    buildDirectoryUrl,
    fallbackRevision: "0.2.5",
  });
  assert.notEqual(cssChanged.uri, first.uri);

  await writeFile(join(buildDir, "assets", "workspace-app.js"), "console.log('two');\n");
  const jsChanged = resolveWorkspaceAppIdentity({
    manifestUrl,
    buildDirectoryUrl,
    fallbackRevision: "0.2.5",
  });
  assert.notEqual(jsChanged.uri, cssChanged.uri);
});

test("workspace app identity falls back when build artifacts are unavailable", () => {
  const identity = resolveWorkspaceAppIdentity({
    manifestUrl: new URL("file:///missing/manifest.json"),
    buildDirectoryUrl: new URL("file:///missing/ui/"),
    fallbackRevision: "0.2.5",
  });

  assert.deepEqual(identity, {
    revision: "0.2.5",
    uri: "ui://forgerelay/workspace-app-0.2.5.html",
    source: "fallback",
  });
});

test("split MCP App identities fall back to separate stable URIs", () => {
  const options = {
    manifestUrl: new URL("file:///missing/manifest.json"),
    buildDirectoryUrl: new URL("file:///missing/ui/"),
    fallbackRevision: "0.5.6",
  };
  const lifecycle = resolveWorkspaceLifecycleAppIdentity(options);
  const activity = resolveActivityPanelAppIdentity(options);

  assert.equal(lifecycle.uri, workspaceLifecycleAppUriForRevision("0.5.6"));
  assert.equal(activity.uri, activityPanelAppUriForRevision("0.5.6"));
  assert.notEqual(lifecycle.uri, activity.uri);
});

test("MCP App compatibility URIs remain stable", () => {
  assert.equal(WORKSPACE_APP_LEGACY_URI, "ui://forgerelay/workspace-app.html");
  assert.equal(WORKSPACE_APP_URI_TEMPLATE, "ui://forgerelay/workspace-app-{revision}.html");
  assert.equal(
    WORKSPACE_LIFECYCLE_APP_LEGACY_URI,
    "ui://forgerelay/workspace-lifecycle-app.html",
  );
  assert.equal(
    WORKSPACE_LIFECYCLE_APP_URI_TEMPLATE,
    "ui://forgerelay/workspace-lifecycle-app-{revision}.html",
  );
  assert.equal(ACTIVITY_PANEL_APP_LEGACY_URI, "ui://forgerelay/activity-panel-app.html");
  assert.equal(
    ACTIVITY_PANEL_APP_URI_TEMPLATE,
    "ui://forgerelay/activity-panel-app-{revision}.html",
  );
});
