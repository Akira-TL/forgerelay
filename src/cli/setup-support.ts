import { createRequire } from "node:module";
import * as prompts from "@clack/prompts";
import { satisfies } from "semver";

const SUPPORTED_NODE_RANGE = ">=20.12 <27";
const require = createRequire(import.meta.url);

export function isNullConfigValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "null" || normalized === "none";
}

export function normalizeOptionalPublicBaseUrl(value: string): string | string[] | null {
  const trimmed = value.trim();
  if (isNullConfigValue(trimmed)) return null;
  return compactPublicBaseUrlConfig(normalizePublicBaseUrlsInput(trimmed));
}

export function normalizePublicBaseUrlsInput(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("Enter at least one public base URL.");
  return Array.from(new Set(entries.map((entry) => normalizePublicBaseUrl(entry))));
}

export function compactPublicBaseUrlConfig(baseUrls: string[]): string | string[] {
  return baseUrls.length === 1 ? baseUrls[0] : baseUrls;
}

export function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

export async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

export function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

export function validateRequiredPublicBaseUrls(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter at least one public base URL from your tunnel or reverse proxy.";
  try {
    normalizePublicBaseUrlsInput(trimmed);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `ForgeRelay requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

export function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

export class SetupCancelledError extends Error {}

export function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

export function checkBashShell(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const command = process.env.BASH?.trim() || "bash";
    const version = execFileSync(command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).split(/\r?\n/, 1)[0]?.trim();
    return version ? `${command} (${version})` : command;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}
