import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceScript = fileURLToPath(new URL("../release-version.mjs", import.meta.url));

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-release-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(sourceScript, join(root, "scripts", "release-version.mjs"));

  const pkg = {
    name: "@akira-tl/forgerelay",
    version: "0.5.7",
    repository: { type: "git", url: "git+https://github.com/Akira-TL/forgerelay.git" },
    homepage: "https://github.com/Akira-TL/forgerelay#readme",
    bugs: { url: "https://github.com/Akira-TL/forgerelay/issues" },
    publishConfig: { access: "public", tag: "latest" },
    bin: { forgerelay: "dist/cli.js" },
    files: ["NOTICE.md"],
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: pkg.name,
        version: pkg.version,
      },
    },
  };

  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`),
    writeFile(join(root, "CHANGELOG.md"), [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- Release candidate behavior.",
      "",
      "## [0.5.7] - 2026-08-19",
      "",
      "### Fixed",
      "",
      "- Previous release.",
      "",
    ].join("\n")),
    writeFile(join(root, "NOTICE.md"), "https://github.com/Waishnav/devspace\nindependently maintained by Akira-TL\n"),
    writeFile(join(root, "LICENSE"), "Copyright (c) 2026 Waishnav\nCopyright (c) 2026 Akira-TL, modifications\n"),
  ]);

  return root;
}

async function runRelease(root, ...args) {
  return execFileAsync(process.execPath, [join(root, "scripts", "release-version.mjs"), ...args], {
    cwd: root,
  });
}

test("release version tooling prepares and validates an rc release", async (t) => {
  const root = await createFixture(t);

  const prepared = await runRelease(root, "prepare", "0.6.0-rc.1");
  assert.match(prepared.stdout, /0\.5\.7 -> 0\.6\.0-rc\.1/);

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  assert.equal(pkg.version, "0.6.0-rc.1");
  assert.equal(lock.version, "0.6.0-rc.1");
  assert.equal(lock.packages[""].version, "0.6.0-rc.1");
  assert.match(changelog, /## \[0\.6\.0-rc\.1\] - \d{4}-\d{2}-\d{2}/);
  assert.match(changelog, /### Added\n\n- Release candidate behavior\./);

  const checked = await runRelease(root, "check");
  assert.match(checked.stdout, /release metadata is consistent at 0\.6\.0-rc\.1/);

  const tagged = await runRelease(root, "tag", "v0.6.0-rc.1");
  assert.match(tagged.stdout, /release tag v0\.6\.0-rc\.1 matches package version and changelog/);

  const notes = await runRelease(root, "notes", "v0.6.0-rc.1");
  assert.match(notes.stdout, /Release candidate behavior/);
});

test("release version tooling rejects unsupported prerelease identifiers", async (t) => {
  const root = await createFixture(t);
  await assert.rejects(
    () => runRelease(root, "prepare", "0.6.0-beta.1"),
    (error) => {
      assert.match(String(error.stderr ?? error), /prepare X\.Y\.Z\[-rc\.N\]/);
      return true;
    },
  );
});
