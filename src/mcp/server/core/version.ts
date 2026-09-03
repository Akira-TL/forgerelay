import { readFileSync } from "node:fs";

export const FORGERELAY_VERSION = readForgeRelayVersion();

function readForgeRelayVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read ForgeRelay package version.");
  }
  return packageJson.version;
}
