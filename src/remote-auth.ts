import { readFileSync } from "node:fs";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { publicEndpointUrl } from "./oauth/public-url.js";
import type { ForgeRelayRemoteRecord } from "./user-config.js";

export type RemoteAuthenticationResult = ForgeRelayRemoteRecord;

interface CliTokenResponse extends OAuthTokens {
  instance_id?: unknown;
}

const REMOTE_AUTH_TIMEOUT_MS = 15_000;
const packageVersion = readForgeRelayVersion();

export function normalizeRemoteServiceTarget(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Missing remote service target.");
  const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported remote service protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Remote service target must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Remote service target must not contain a query or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function defaultRemoteAlias(target: string): string {
  const hostname = new URL(target).hostname;
  return hostname.replace(/^\[|\]$/g, "");
}

export async function authenticateRemote(
  targetInput: string,
  ownerToken: string,
): Promise<RemoteAuthenticationResult> {
  const target = normalizeRemoteServiceTarget(targetInput);
  return exchangeCliCredential(target, { owner_token: ownerToken });
}

export async function refreshRemoteAuthentication(
  remote: ForgeRelayRemoteRecord,
): Promise<ForgeRelayRemoteRecord> {
  const refreshed = await exchangeCliCredential(
    normalizeRemoteServiceTarget(remote.target),
    { refresh_token: remote.refreshToken },
  );
  if (refreshed.instanceId !== remote.instanceId) {
    throw new Error(
      `Remote instance changed from ${remote.instanceId} to ${refreshed.instanceId}; refusing to update stored credentials.`,
    );
  }
  return {
    ...remote,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    scope: refreshed.scope,
  };
}

export function isRemoteMcpUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

export async function verifyRemoteMcp(remote: ForgeRelayRemoteRecord): Promise<void> {
  const client = new Client({ name: "forgerelay-cli", version: packageVersion });
  const transport = new StreamableHTTPClientTransport(publicEndpointUrl(remote.target, "mcp"), {
    requestInit: {
      headers: { Authorization: `Bearer ${remote.accessToken}` },
    },
  });
  try {
    await client.connect(transport);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function exchangeCliCredential(
  target: string,
  credential: { owner_token: string } | { refresh_token: string },
): Promise<RemoteAuthenticationResult> {
  const response = await fetch(publicEndpointUrl(target, "auth/cli"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(credential),
    signal: AbortSignal.timeout(REMOTE_AUTH_TIMEOUT_MS),
  });

  if (!response.ok) {
    let reason = response.statusText || `HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error) reason = body.error;
    } catch {
      // Keep the status-derived error without exposing the submitted secret.
    }
    throw new Error(`Remote authentication failed: ${reason}`);
  }

  const body = await response.json() as CliTokenResponse;
  if (typeof body.instance_id !== "string" || !body.instance_id.trim()) {
    throw new Error("Remote authentication response did not include an instance id.");
  }
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new Error("Remote authentication response did not include the required tokens.");
  }

  return {
    instanceId: body.instance_id,
    target,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 0),
    ...(body.scope ? { scope: body.scope } : {}),
  };
}

function readForgeRelayVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Unable to read ForgeRelay package version.");
  }
  return packageJson.version;
}
