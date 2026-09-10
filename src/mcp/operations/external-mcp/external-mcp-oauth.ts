import { randomBytes } from "node:crypto";
import {
  AuthorizationServerMismatchError,
  InsufficientScopeError,
  OAuthError,
  OAuthErrorCode,
  SdkHttpError,
  UnauthorizedError,
  auth,
  computeScopeUnion,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
  refreshAuthorization,
  resourceUrlFromServerUrl,
  type AuthProvider,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  ExternalMcpCredentialStore,
  type ExternalMcpCredentialIdentity,
  type ExternalMcpOAuthCredentialRecord,
} from "../../../runtime/config/external-mcp-auth-store.js";
export class ExternalMcpOAuthError extends Error {
  constructor(readonly code: "auth_required" | "reauthorization_required", message: string) {
    super(message);
    this.name = "ExternalMcpOAuthError";
  }
}

export interface ExternalMcpRuntimeAuth {
  authProvider?: AuthProvider;
  bindingMismatch: boolean;
  identity: ExternalMcpCredentialIdentity;
  serverUrl: string;
}

export interface ExternalMcpInteractiveOAuthSnapshot {
  tokens?: StoredOAuthTokens;
  clientInformation?: StoredOAuthClientInformation;
  discoveryState?: OAuthDiscoveryState;
  authorizationServerUrl?: string;
  resourceUrl?: string;
}

export interface ExternalMcpInteractiveOAuthOptions {
  serverUrl: string;
  redirectUrl: URL;
  clientMetadataUrl?: string;
  existing?: ExternalMcpOAuthCredentialRecord;
  onAuthorizationUrl: (url: URL) => void | Promise<void>;
}

const CLIENT_NAME = "ForgeRelay External MCP";
const CLIENT_URI = "https://github.com/Akira-TL/forgerelay";

export function createExternalMcpRuntimeAuth(
  store: ExternalMcpCredentialStore,
  identity: ExternalMcpCredentialIdentity,
  serverUrl: string,
): ExternalMcpRuntimeAuth {
  const record = store.read(identity);
  if (!record) return { identity, serverUrl, bindingMismatch: false };
  if (!sameServerUrl(record.serverUrl, serverUrl)) {
    return { identity, serverUrl, bindingMismatch: true };
  }
  try {
    assertStoredBinding(record);
  } catch (error) {
    if (error instanceof AuthorizationServerMismatchError) {
      return { identity, serverUrl, bindingMismatch: true };
    }
    throw error;
  }

  const state = { revision: record.revision };
  const authProvider: AuthProvider = {
    token: async () => {
      const latest = store.read(identity);
      if (!latest || !sameServerUrl(latest.serverUrl, serverUrl)) return undefined;
      state.revision = latest.revision;
      return latest.tokens?.access_token;
    },
    onUnauthorized: async () => {
      await store.withIdentityLock(identity, async () => {
        const latest = store.read(identity);
        if (!latest) throw authRequired(identity.server);
        if (!sameServerUrl(latest.serverUrl, serverUrl)) {
          await markReauthorization(store, identity, latest, "binding_changed");
          throw reauthorizationRequired(identity.server, "OAuth resource binding changed.");
        }

        if (latest.revision !== state.revision) {
          state.revision = latest.revision;
          return;
        }
        if (!latest.tokens?.refresh_token || !latest.clientInformation) {
          await markReauthorization(store, identity, latest, "authorization_required");
          throw reauthorizationRequired(identity.server, "Stored OAuth credentials cannot be refreshed.");
        }

        assertStoredBinding(latest);
        const authorizationServerUrl = latest.discoveryState?.authorizationServerUrl
          ?? latest.authorizationServerUrl;
        if (!authorizationServerUrl) {
          await markReauthorization(store, identity, latest, "binding_changed");
          throw reauthorizationRequired(identity.server, "Stored OAuth authorization-server binding is incomplete.");
        }

        try {
          const refreshed = await refreshAuthorization(authorizationServerUrl, {
            metadata: latest.discoveryState?.authorizationServerMetadata,
            clientInformation: latest.clientInformation,
            refreshToken: latest.tokens.refresh_token,
            resource: latest.resourceUrl ? new URL(latest.resourceUrl) : resourceUrlFromServerUrl(serverUrl),
          });
          const expectedIssuer = storedIssuer(latest, authorizationServerUrl);
          const next = await store.replace(identity, serverUrl, {
            tokens: { ...refreshed, issuer: expectedIssuer },
            clientInformation: latest.clientInformation,
            ...(latest.discoveryState ? { discoveryState: latest.discoveryState } : {}),
            authorizationServerUrl: expectedIssuer,
            ...(latest.resourceUrl ? { resourceUrl: latest.resourceUrl } : {}),
          });
          state.revision = next.revision;
        } catch (error) {
          if (isCredentialReauthorizationError(error)) {
            await markReauthorization(store, identity, latest, "invalid_grant");
            throw reauthorizationRequired(identity.server, "Stored OAuth credentials require fresh authorization.");
          }
          throw error;
        }
      });
    },
  };

  return { authProvider, bindingMismatch: false, identity, serverUrl };
}

export async function markExternalMcpReauthorization(
  store: ExternalMcpCredentialStore,
  runtimeAuth: ExternalMcpRuntimeAuth | undefined,
  reason: NonNullable<ExternalMcpOAuthCredentialRecord["reauthorization"]>["reason"],
  details: { scope?: string } = {},
): Promise<void> {
  if (!runtimeAuth) return;
  await store.withIdentityLock(runtimeAuth.identity, async () => {
    const latest = store.read(runtimeAuth.identity);
    if (!latest) return;
    if (reason !== "binding_changed" && !sameServerUrl(latest.serverUrl, runtimeAuth.serverUrl)) return;
    await markReauthorization(store, runtimeAuth.identity, latest, reason, details);
  });
}

export function externalMcpAuthError(
  server: string,
  error: unknown,
  runtimeAuth: ExternalMcpRuntimeAuth | undefined,
): ExternalMcpOAuthError | undefined {
  if (error instanceof ExternalMcpOAuthError) return error;
  if (runtimeAuth?.bindingMismatch) {
    return reauthorizationRequired(server, "OAuth resource binding changed.");
  }
  if (error instanceof InsufficientScopeError) {
    return reauthorizationRequired(server, "External MCP requires additional OAuth scope.");
  }
  if (error instanceof AuthorizationServerMismatchError) {
    return reauthorizationRequired(server, "OAuth authorization-server binding changed.");
  }
  if (error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401)) {
    return runtimeAuth?.authProvider
      ? reauthorizationRequired(server, "Stored OAuth credentials were rejected.")
      : authRequired(server);
  }
  if (isCredentialReauthorizationError(error)) {
    return reauthorizationRequired(server, "Stored OAuth credentials require fresh authorization.");
  }
  return undefined;
}

export class ExternalMcpInteractiveOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;
  private readonly stateValue = randomBytes(32).toString("base64url");
  private codeVerifierValue?: string;
  private clientInformationValue?: StoredOAuthClientInformation;
  private tokensValue?: StoredOAuthTokens;
  private discoveryStateValue?: OAuthDiscoveryState;
  private authorizationServerUrlValue?: string;
  private resourceUrlValue?: string;

  constructor(private readonly options: ExternalMcpInteractiveOAuthOptions) {
    this.redirectUrl = options.redirectUrl;
    this.clientMetadataUrl = options.clientMetadataUrl;
    this.clientMetadata = {
      client_name: CLIENT_NAME,
      client_uri: CLIENT_URI,
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    if (options.existing && sameServerUrl(options.existing.serverUrl, options.serverUrl)) {
      this.clientInformationValue = clone(options.existing.clientInformation);
      this.tokensValue = clone(options.existing.tokens);
      this.discoveryStateValue = clone(options.existing.discoveryState);
      this.authorizationServerUrlValue = options.existing.authorizationServerUrl;
      this.resourceUrlValue = options.existing.resourceUrl;
    }
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(_ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    return clone(this.clientInformationValue);
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.clientInformationValue = clone(clientInformation);
  }

  tokens(_ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return clone(this.tokensValue);
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.tokensValue = clone(tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.options.onAuthorizationUrl(new URL(authorizationUrl));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("OAuth PKCE verifier is not available for this authorization session.");
    return this.codeVerifierValue;
  }

  saveAuthorizationServerUrl(authorizationServerUrl: string): void {
    this.authorizationServerUrlValue = authorizationServerUrl;
  }

  authorizationServerUrl(): string | undefined {
    return this.authorizationServerUrlValue;
  }

  saveResourceUrl(resourceUrl: string): void {
    this.resourceUrlValue = resourceUrl;
  }

  resourceUrl(): string | undefined {
    return this.resourceUrlValue;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discoveryStateValue = clone(state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return clone(this.discoveryStateValue);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.clientInformationValue = undefined;
    if (scope === "all" || scope === "tokens") this.tokensValue = undefined;
    if (scope === "all" || scope === "verifier") this.codeVerifierValue = undefined;
    if (scope === "all" || scope === "discovery") {
      this.discoveryStateValue = undefined;
      this.authorizationServerUrlValue = undefined;
      this.resourceUrlValue = undefined;
    }
  }

  validateCallback(callbackUrl: URL): { code: string; iss?: string } {
    if (callbackUrl.origin !== this.redirectUrl.origin || callbackUrl.pathname !== this.redirectUrl.pathname) {
      throw new Error("OAuth callback URL does not match the ForgeRelay redirect URL.");
    }
    const state = callbackUrl.searchParams.get("state");
    if (!state || state !== this.stateValue) throw new Error("OAuth callback state did not match the authorization request.");
    const error = callbackUrl.searchParams.get("error");
    if (error) throw new Error(`OAuth authorization failed: ${safeOAuthErrorCode(error)}.`);
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new Error("OAuth callback did not contain an authorization code.");
    const iss = callbackUrl.searchParams.get("iss") ?? undefined;
    return { code, ...(iss ? { iss } : {}) };
  }

  snapshot(): ExternalMcpInteractiveOAuthSnapshot {
    return {
      ...(this.tokensValue ? { tokens: clone(this.tokensValue) } : {}),
      ...(this.clientInformationValue ? { clientInformation: clone(this.clientInformationValue) } : {}),
      ...(this.discoveryStateValue ? { discoveryState: clone(this.discoveryStateValue) } : {}),
      ...(this.authorizationServerUrlValue ? { authorizationServerUrl: this.authorizationServerUrlValue } : {}),
      ...(this.resourceUrlValue ? { resourceUrl: this.resourceUrlValue } : {}),
    };
  }
}

export async function beginExternalMcpInteractiveOAuth(
  provider: ExternalMcpInteractiveOAuthProvider,
  serverUrl: string,
  requestedScope?: string,
): Promise<void> {
  // A manual auth command must rediscover the current authorization server instead of
  // trusting discovery state captured by an older credential for the same MCP URL.
  provider.invalidateCredentials("discovery");
  const challenge = await probeExternalMcpOAuthChallenge(serverUrl);
  const scope = computeScopeUnion(requestedScope, challenge.scope);
  const result = await auth(provider, {
    serverUrl,
    ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
    ...(scope ? { scope } : {}),
    forceReauthorization: true,
  });
  if (result !== "REDIRECT") throw new Error("External MCP OAuth did not start an interactive authorization redirect.");
}

async function probeExternalMcpOAuthChallenge(serverUrl: string): Promise<{
  resourceMetadataUrl?: URL;
  scope?: string;
}> {
  const response = await fetch(serverUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "forgerelay-oauth-probe",
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": LATEST_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "forgerelay", version: "1.0.0" },
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  try {
    if (response.status !== 401) return {};
    const challenge = extractWWWAuthenticateParams(response);
    return {
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      ...(challenge.scope ? { scope: challenge.scope } : {}),
    };
  } finally {
    await response.text().catch(() => "");
  }
}

export async function finishExternalMcpInteractiveOAuth(
  provider: ExternalMcpInteractiveOAuthProvider,
  serverUrl: string,
  callbackUrl: URL,
): Promise<ExternalMcpInteractiveOAuthSnapshot> {
  const callback = provider.validateCallback(callbackUrl);
  const result = await auth(provider, {
    serverUrl,
    authorizationCode: callback.code,
    ...(callback.iss ? { iss: callback.iss } : {}),
  });
  if (result !== "AUTHORIZED") throw new Error("External MCP OAuth token exchange did not complete.");
  const snapshot = provider.snapshot();
  if (!snapshot.tokens?.access_token || !snapshot.clientInformation) {
    throw new Error("External MCP OAuth completed without usable credentials.");
  }
  return snapshot;
}

function assertStoredBinding(record: ExternalMcpOAuthCredentialRecord): void {
  const authorizationServerUrl = record.discoveryState?.authorizationServerUrl ?? record.authorizationServerUrl;
  if (!authorizationServerUrl) return;
  const expectedIssuer = storedIssuer(record, authorizationServerUrl);
  for (const candidate of [record.tokens?.issuer, record.clientInformation?.issuer]) {
    if (candidate && !sameIssuer(candidate, expectedIssuer)) {
      throw new AuthorizationServerMismatchError(candidate, expectedIssuer);
    }
  }
}

function storedIssuer(record: ExternalMcpOAuthCredentialRecord, authorizationServerUrl: string): string {
  return record.discoveryState?.authorizationServerMetadata?.issuer
    ?? record.authorizationServerUrl
    ?? authorizationServerUrl;
}

async function markReauthorization(
  store: ExternalMcpCredentialStore,
  identity: ExternalMcpCredentialIdentity,
  current: ExternalMcpOAuthCredentialRecord,
  reason: NonNullable<ExternalMcpOAuthCredentialRecord["reauthorization"]>["reason"],
  details: { scope?: string } = {},
): Promise<void> {
  await store.replace(identity, current.serverUrl, {
    ...(current.tokens ? { tokens: current.tokens } : {}),
    ...(current.clientInformation ? { clientInformation: current.clientInformation } : {}),
    ...(current.discoveryState ? { discoveryState: current.discoveryState } : {}),
    ...(current.authorizationServerUrl ? { authorizationServerUrl: current.authorizationServerUrl } : {}),
    ...(current.resourceUrl ? { resourceUrl: current.resourceUrl } : {}),
    reauthorization: {
      reason,
      observedAt: new Date().toISOString(),
      ...(details.scope?.trim() ? { scope: details.scope.trim() } : {}),
    },
  });
}

function isCredentialReauthorizationError(error: unknown): boolean {
  return error instanceof OAuthError && [
    OAuthErrorCode.InvalidGrant,
    OAuthErrorCode.InvalidClient,
    OAuthErrorCode.UnauthorizedClient,
  ].includes(error.code as OAuthErrorCode);
}

function authRequired(server: string): ExternalMcpOAuthError {
  return new ExternalMcpOAuthError(
    "auth_required",
    `External MCP ${server} requires OAuth authorization. Run: forgerelay mcp auth ${server}`,
  );
}

function reauthorizationRequired(server: string, reason: string): ExternalMcpOAuthError {
  return new ExternalMcpOAuthError(
    "reauthorization_required",
    `${reason} Run: forgerelay mcp auth ${server}`,
  );
}

function sameServerUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function sameIssuer(left: string, right: string): boolean {
  // RFC 9207 issuer validation uses simple string comparison; URL normalization
  // would incorrectly treat distinct issuer identifiers as equivalent.
  return left === right;
}

function safeOAuthErrorCode(value: string): string {
  return /^[a-z0-9._-]{1,80}$/i.test(value) ? value : "authorization_error";
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
