import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAcceptancePrefix } from "./acceptance-artifact.mjs";

const PACKAGE_PATH = ["@akira-tl", "forgerelay"];

export function resolveAcceptanceRuntimeRoot(repoRoot) {
  const configuredRoot = process.env.FORGERELAY_ACCEPTANCE_RUNTIME_ROOT?.trim();
  if (configuredRoot) {
    const runtimeRoot = resolve(repoRoot, configuredRoot);
    if (existsSync(join(runtimeRoot, "dist", "cli.js"))) return runtimeRoot;
  }

  const prefix = resolveAcceptancePrefix(repoRoot);
  if (!prefix) {
    if (configuredRoot) {
      throw new Error(
        `Prepared acceptance runtime is missing dist/cli.js: ${resolve(repoRoot, configuredRoot)}. Run ci:prepare-windows-shell-runtime before shell acceptance.`,
      );
    }
    return resolve(repoRoot);
  }

  const candidates = [
    join(prefix, "node_modules", ...PACKAGE_PATH),
    join(prefix, "lib", "node_modules", ...PACKAGE_PATH),
  ];
  const installedRoot = candidates.find((candidate) => existsSync(join(candidate, "dist", "cli.js")));
  if (!installedRoot) {
    throw new Error(
      `Prepared acceptance install is missing dist/cli.js under npm prefix: ${prefix}. Run ci:prepare-windows-product before shell acceptance.`,
    );
  }
  return installedRoot;
}

export function acceptanceRuntimeModuleUrl(repoRoot, relativePath) {
  const runtimeRoot = resolveAcceptanceRuntimeRoot(repoRoot);
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Acceptance runtime module is missing: ${path}`);
  }
  return pathToFileURL(path).href;
}
