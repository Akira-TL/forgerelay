import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function resolveAcceptancePrefix(repoRoot) {
  const configuredPrefix = process.env.FORGERELAY_ACCEPTANCE_PREFIX?.trim();
  return configuredPrefix ? resolve(repoRoot, configuredPrefix) : undefined;
}

export function resolveAcceptanceTarball({ repoRoot, artifactDir, npmCli }) {
  const configuredTarball = process.env.FORGERELAY_ACCEPTANCE_TARBALL?.trim();
  const configuredDir = process.env.FORGERELAY_ACCEPTANCE_ARTIFACT_DIR?.trim();
  if (configuredTarball && configuredDir) {
    throw new Error("Set only one of FORGERELAY_ACCEPTANCE_TARBALL or FORGERELAY_ACCEPTANCE_ARTIFACT_DIR.");
  }

  if (configuredTarball) {
    const tarball = resolve(repoRoot, configuredTarball);
    assertTarball(tarball, "configured acceptance tarball");
    console.log(`Using prebuilt npm artifact: ${tarball}`);
    return tarball;
  }

  if (configuredDir) {
    const directory = resolve(repoRoot, configuredDir);
    const packages = existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".tgz"))
      : [];
    if (packages.length !== 1) {
      throw new Error(
        `Acceptance artifact directory must contain exactly one .tgz package; found ${packages.length}: ${directory}`,
      );
    }
    const tarball = resolve(directory, packages[0]);
    assertTarball(tarball, "downloaded acceptance tarball");
    console.log(`Using prebuilt npm artifact: ${tarball}`);
    return tarball;
  }

  const result = spawnSync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", artifactDir],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`npm pack failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`);
  }
  const report = JSON.parse(result.stdout);
  const filename = report?.[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a package filename: ${result.stdout}`);
  const tarball = resolve(artifactDir, filename);
  assertTarball(tarball, "locally packed acceptance tarball");
  return tarball;
}

function assertTarball(tarball, label) {
  if (!tarball.endsWith(".tgz") || !existsSync(tarball)) {
    throw new Error(`${label} is missing or is not an npm .tgz artifact: ${tarball}`);
  }
}
