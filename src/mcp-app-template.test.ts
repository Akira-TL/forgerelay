import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  readWorkspaceAppManifestEntry,
  resolveWorkspaceAppIdentity,
  WORKSPACE_APP_LEGACY_URI,
  WORKSPACE_APP_MANIFEST_ENTRY,
  WORKSPACE_APP_URI_TEMPLATE,
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

test("workspace app compatibility URIs remain stable", () => {
  assert.equal(WORKSPACE_APP_LEGACY_URI, "ui://forgerelay/workspace-app.html");
  assert.equal(
    WORKSPACE_APP_URI_TEMPLATE,
    "ui://forgerelay/workspace-app-{revision}.html",
  );
});
