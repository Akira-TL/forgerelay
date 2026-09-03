import { isIP } from "node:net";
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

export type ClientFacingUrlSecurity = "secure" | "insecure-lan";

export function classifyClientFacingBaseUrl(value: string): ClientFacingUrlSecurity {
  const parsed = new URL(normalizePublicBaseUrl(value));
  if (parsed.protocol === "https:") return "secure";
  if (parsed.protocol !== "http:") {
    throw new Error("Client-facing base URLs must use http:// or https://.");
  }
  if (!isPrivateNetworkHost(parsed.hostname)) {
    throw new Error("Plain HTTP is allowed only for local/LAN addresses. Use HTTPS for public addresses.");
  }
  return "insecure-lan";
}

export function validateClientFacingBaseUrls(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter at least one client-facing base URL.";
  try {
    for (const baseUrl of normalizePublicBaseUrlsInput(trimmed)) classifyClientFacingBaseUrl(baseUrl);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function hasInsecureLanBaseUrl(baseUrls: readonly string[]): boolean {
  return baseUrls.some((baseUrl) => classifyClientFacingBaseUrl(baseUrl) === "insecure-lan");
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || !host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) {
    return true;
  }
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    return host === "::1"
      || host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
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

export function isLoopbackBindAddress(value: string): boolean {
  const host = value.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function validateBindAddress(value: string | undefined): string | undefined {
  const host = value?.trim() ?? "";
  if (!host) return "Enter a bind address.";
  if (/\s|:\/\//.test(host) || host.includes("/")) {
    return "Enter only a host or IP address, not a URL.";
  }
  return undefined;
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
