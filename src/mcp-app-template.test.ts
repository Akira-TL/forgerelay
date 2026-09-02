import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  ACTIVITY_PANEL_APP_MANIFEST_ENTRY,
  activityPanelAppUriForRevision,
  readActivityPanelAppManifestEntry,
  resolveActivityPanelAppIdentity,
  workspaceAppBundleRevision,
} from "./mcp-app-template.js";

test("Activity Panel identity hashes built JavaScript, imported chunks, and CSS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-app-template-test-"));
  const buildDir = join(root, "ui");
  const manifestDir = join(buildDir, ".vite");
  await mkdir(join(buildDir, "assets"), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(buildDir, "assets", "activity.js"), "console.log('one');\n");
  await writeFile(join(buildDir, "assets", "shared.js"), "export const shared = 1;\n");
  await writeFile(join(buildDir, "assets", "panel.css"), ".panel { color: red; }\n");
  await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({
    [ACTIVITY_PANEL_APP_MANIFEST_ENTRY]: {
      file: "assets/activity.js",
      imports: ["shared.ts"],
      css: ["assets/panel.css"],
      isEntry: true,
    },
    "shared.ts": {
      file: "assets/shared.js",
    },
  }));

  const manifestUrl = pathToFileURL(join(manifestDir, "manifest.json"));
  const buildDirectoryUrl = pathToFileURL(`${buildDir}/`);
  const entry = readActivityPanelAppManifestEntry(manifestUrl);
  assert.deepEqual(entry.dependencies, ["assets/shared.js"]);
  const firstRevision = workspaceAppBundleRevision(entry, buildDirectoryUrl);
  const first = resolveActivityPanelAppIdentity({
    manifestUrl,
    buildDirectoryUrl,
    fallbackRevision: "0.8.9",
  });

  assert.equal(first.source, "bundle");
  assert.equal(first.revision, firstRevision);
  assert.match(first.uri, /^ui:\/\/forgerelay\/activity-panel-app-[0-9a-f]{12}\.html$/);

  await writeFile(join(buildDir, "assets", "shared.js"), "export const shared = 2;\n");
  const changed = resolveActivityPanelAppIdentity({
    manifestUrl,
    buildDirectoryUrl,
    fallbackRevision: "0.8.9",
  });
  assert.notEqual(changed.uri, first.uri);
});

test("Activity Panel identity changes when the resource contract revision changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-app-template-revision-test-"));
  const buildDir = join(root, "ui");
  const manifestDir = join(buildDir, ".vite");
  await mkdir(join(buildDir, "assets"), { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(buildDir, "assets", "activity.js"), "console.log('activity');\n");
  await writeFile(join(manifestDir, "manifest.json"), JSON.stringify({
    [ACTIVITY_PANEL_APP_MANIFEST_ENTRY]: {
      file: "assets/activity.js",
      isEntry: true,
    },
  }));

  const options = {
    manifestUrl: pathToFileURL(join(manifestDir, "manifest.json")),
    buildDirectoryUrl: pathToFileURL(`${buildDir}/`),
    fallbackRevision: "0.8.9",
  };
  const first = resolveActivityPanelAppIdentity({ ...options, resourceTemplateRevision: "one" });
  const second = resolveActivityPanelAppIdentity({ ...options, resourceTemplateRevision: "two" });
  assert.notEqual(first.uri, second.uri);
});

test("Activity Panel fallback identity remains stable without a built manifest", () => {
  const activity = resolveActivityPanelAppIdentity({
    manifestUrl: new URL("file:///missing/manifest.json"),
    buildDirectoryUrl: new URL("file:///missing/ui/"),
    fallbackRevision: "0.8.9",
  });

  assert.equal(activity.source, "fallback");
  assert.equal(activity.uri, activityPanelAppUriForRevision("0.8.9"));
});

test("Activity Panel exposes only revisioned resource URIs", () => {
  assert.equal(
    activityPanelAppUriForRevision("abc123"),
    "ui://forgerelay/activity-panel-app-abc123.html",
  );
});
