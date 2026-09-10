import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import express, { type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import {
  OAuthClientMetadataSchema,
  OAuthTokenRevocationRequestSchema,
} from "@modelcontextprotocol/core";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthClientInformationFull,
  type OAuthMetadata,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from "@modelcontextprotocol/server";

export interface OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined | Promise<OAuthClientInformationFull | undefined>;
  registerClient?(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull | Promise<OAuthClientInformationFull>;
}

export interface AuthorizationParams {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
  issuer?: string;
}

export interface OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void>;
  challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string>;
  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens>;
  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens>;
  verifyAccessToken(token: string): Promise<AuthInfo>;
  revokeToken?(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void>;
  authorizationResponseIssParameterSupported?: boolean;
  skipLocalPkceValidation?: boolean;
}

interface AuthMetadataOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl?: URL;
  scopesSupported?: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function oauthError(code: OAuthErrorCode | string, message: string): OAuthError {
  return new OAuthError(code, message);
}

function statusForOAuthError(error: OAuthError): number {
  if (error.code === OAuthErrorCode.ServerError) return 500;
  if (error.code === OAuthErrorCode.TooManyRequests) return 429;
  if (error.code === OAuthErrorCode.MethodNotAllowed) return 405;
  return 400;
}

function sendOAuthError(res: Response, error: unknown): void {
  const normalized = error instanceof OAuthError
    ? error
    : oauthError(OAuthErrorCode.ServerError, "Internal Server Error");
  res.status(statusForOAuthError(normalized)).json(normalized.toResponseObject());
}

function applyCors(res: Response, methods: readonly string[]): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(", "));
}

function allowMethods(methods: readonly string[]): RequestHandler {
  return (req, res, next) => {
    applyCors(res, methods);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (!methods.includes(req.method)) {
      res.setHeader("Allow", methods.join(", "));
      sendOAuthError(res, oauthError(OAuthErrorCode.MethodNotAllowed, "Method not allowed"));
      return;
    }
    next();
  };
}

function endpointRateLimit(max: number, message: string): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: oauthError(OAuthErrorCode.TooManyRequests, message).toResponseObject(),
  });
}

function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return req.protocol === reg.protocol
    && req.hostname === reg.hostname
    && req.pathname === reg.pathname
    && req.search === reg.search;
}

function withIssuerOnCallbackRedirect(res: Response, redirectUri: string, issuer: string): Response {
  const callback = new URL(redirectUri);
  const appendIssuer = (value: string): string => {
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      return value;
    }
    if (
      target.origin === callback.origin
      && target.pathname === callback.pathname
      && !target.searchParams.has("iss")
    ) {
      target.searchParams.set("iss", issuer);
      return target.href;
    }
    return value;
  };
  const originalRedirect = res.redirect.bind(res) as unknown as (...args: unknown[]) => void;
  res.redirect = ((statusOrUrl: number | string, maybeUrl?: string | number) => {
    if (typeof statusOrUrl === "number") {
      originalRedirect(statusOrUrl, appendIssuer(String(maybeUrl)));
    } else if (typeof maybeUrl === "number") {
      originalRedirect(appendIssuer(statusOrUrl), maybeUrl);
    } else {
      originalRedirect(appendIssuer(statusOrUrl));
    }
  }) as Response["redirect"];
  return res;
}

function errorRedirect(redirectUri: string, error: OAuthError, state?: string, issuer?: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", String(error.code));
  target.searchParams.set("error_description", error.message);
  if (error.errorUri) target.searchParams.set("error_uri", error.errorUri);
  if (state) target.searchParams.set("state", state);
  if (issuer) target.searchParams.set("iss", issuer);
  return target.href;
}

async function authenticateClient(
  provider: OAuthServerProvider,
  body: unknown,
): Promise<OAuthClientInformationFull> {
  if (typeof body !== "object" || body === null) {
    throw oauthError(OAuthErrorCode.InvalidRequest, "OAuth request body is required");
  }
  const record = body as Record<string, unknown>;
  const clientId = typeof record.client_id === "string" ? record.client_id : undefined;
  const clientSecret = typeof record.client_secret === "string" ? record.client_secret : undefined;
  if (!clientId) throw oauthError(OAuthErrorCode.InvalidRequest, "client_id is required");
  const client = await provider.clientsStore.getClient(clientId);
  if (!client) throw oauthError(OAuthErrorCode.InvalidClient, "Invalid client_id");
  if (client.client_secret) {
    if (!clientSecret || client.client_secret !== clientSecret) {
      throw oauthError(OAuthErrorCode.InvalidClient, "Invalid client_secret");
    }
    if (
      client.client_secret_expires_at
      && client.client_secret_expires_at < Math.floor(Date.now() / 1000)
    ) {
      throw oauthError(OAuthErrorCode.InvalidClient, "Client secret has expired");
    }
  }
  return client;
}

function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

export function authorizationHandler(options: {
  provider: OAuthServerProvider;
  issuerUrl?: URL;
}): RequestHandler {
  const { provider, issuerUrl } = options;
  const issuer = issuerUrl?.href;
  const router = express.Router();
  router.use(allowMethods(["GET", "POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(100, "You have exceeded the rate limit for authorization requests"));
  router.all("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const raw = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
    let redirectUri: string | undefined;
    let client: OAuthClientInformationFull | undefined;
    try {
      const clientId = typeof raw.client_id === "string" ? raw.client_id : undefined;
      redirectUri = typeof raw.redirect_uri === "string" ? raw.redirect_uri : undefined;
      if (!clientId) throw oauthError(OAuthErrorCode.InvalidRequest, "client_id is required");
      if (redirectUri !== undefined && !URL.canParse(redirectUri)) {
        throw oauthError(OAuthErrorCode.InvalidRequest, "redirect_uri must be a valid URL");
      }
      client = await provider.clientsStore.getClient(clientId);
      if (!client) throw oauthError(OAuthErrorCode.InvalidClient, "Invalid client_id");
      if (redirectUri !== undefined) {
        if (!client.redirect_uris.some((registered) => redirectUriMatches(redirectUri!, String(registered)))) {
          throw oauthError(OAuthErrorCode.InvalidRequest, "Unregistered redirect_uri");
        }
      } else if (client.redirect_uris.length === 1) {
        redirectUri = String(client.redirect_uris[0]);
      } else {
        throw oauthError(
          OAuthErrorCode.InvalidRequest,
          "redirect_uri must be specified when client has multiple registered URIs",
        );
      }
    } catch (error) {
      sendOAuthError(res, error);
      return;
    }

    const state = typeof raw.state === "string" ? raw.state : undefined;
    try {
      if (raw.response_type !== "code") {
        throw oauthError(OAuthErrorCode.UnsupportedResponseType, "response_type must be code");
      }
      const codeChallenge = typeof raw.code_challenge === "string" ? raw.code_challenge : undefined;
      if (!codeChallenge || raw.code_challenge_method !== "S256") {
        throw oauthError(OAuthErrorCode.InvalidRequest, "S256 PKCE code_challenge is required");
      }
      const scope = typeof raw.scope === "string" ? raw.scope : undefined;
      const resource = typeof raw.resource === "string" ? raw.resource : undefined;
      if (resource !== undefined && !URL.canParse(resource)) {
        throw oauthError(OAuthErrorCode.InvalidRequest, "resource must be a valid URL");
      }
      await provider.authorize(client!, {
        state,
        scopes: scope === undefined ? [] : scope.split(" ").filter(Boolean),
        redirectUri: redirectUri!,
        codeChallenge,
        resource: resource ? new URL(resource) : undefined,
        issuer,
      }, issuer ? withIssuerOnCallbackRedirect(res, redirectUri!, issuer) : res);
    } catch (error) {
      const normalized = error instanceof OAuthError
        ? error
        : oauthError(OAuthErrorCode.ServerError, "Internal Server Error");
      res.redirect(302, errorRedirect(redirectUri!, normalized, state, issuer));
    }
  });
  return router;
}

export function tokenHandler(options: { provider: OAuthServerProvider }): RequestHandler {
  const { provider } = options;
  const router = express.Router();
  router.use(allowMethods(["POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(50, "You have exceeded the rate limit for token requests"));
  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const client = await authenticateClient(provider, req.body);
      const body = req.body as Record<string, unknown>;
      const grantType = typeof body.grant_type === "string" ? body.grant_type : undefined;
      if (!grantType) throw oauthError(OAuthErrorCode.InvalidRequest, "grant_type is required");
      if (grantType === "authorization_code") {
        const code = typeof body.code === "string" ? body.code : undefined;
        const verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;
        const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : undefined;
        const resource = typeof body.resource === "string" ? body.resource : undefined;
        if (!code || !verifier) {
          throw oauthError(OAuthErrorCode.InvalidRequest, "code and code_verifier are required");
        }
        if (resource !== undefined && !URL.canParse(resource)) {
          throw oauthError(OAuthErrorCode.InvalidRequest, "resource must be a valid URL");
        }
        if (!provider.skipLocalPkceValidation) {
          const challenge = await provider.challengeForAuthorizationCode(client, code);
          if (!verifyPkce(verifier, challenge)) {
            throw oauthError(OAuthErrorCode.InvalidGrant, "code_verifier does not match the challenge");
          }
        }
        const tokens = await provider.exchangeAuthorizationCode(
          client,
          code,
          provider.skipLocalPkceValidation ? verifier : undefined,
          redirectUri,
          resource ? new URL(resource) : undefined,
        );
        res.status(200).json(tokens);
        return;
      }
      if (grantType === "refresh_token") {
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
        const scope = typeof body.scope === "string" ? body.scope : undefined;
        const resource = typeof body.resource === "string" ? body.resource : undefined;
        if (!refreshToken) throw oauthError(OAuthErrorCode.InvalidRequest, "refresh_token is required");
        if (resource !== undefined && !URL.canParse(resource)) {
          throw oauthError(OAuthErrorCode.InvalidRequest, "resource must be a valid URL");
        }
        const tokens = await provider.exchangeRefreshToken(
          client,
          refreshToken,
          scope?.split(" ").filter(Boolean),
          resource ? new URL(resource) : undefined,
        );
        res.status(200).json(tokens);
        return;
      }
      throw oauthError(
        OAuthErrorCode.UnsupportedGrantType,
        "The grant type is not supported by this authorization server.",
      );
    } catch (error) {
      sendOAuthError(res, error);
    }
  });
  return router;
}

export function clientRegistrationHandler(options: {
  clientsStore: OAuthRegisteredClientsStore;
}): RequestHandler {
  const { clientsStore } = options;
  if (!clientsStore.registerClient) {
    throw new Error("Client registration store does not support registering clients");
  }
  const router = express.Router();
  router.use(allowMethods(["POST"]));
  router.use(express.json({ limit: "16kb" }));
  router.use(endpointRateLimit(20, "You have exceeded the rate limit for client registration requests"));
  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const parsed = OAuthClientMetadataSchema.safeParse(req.body);
      if (!parsed.success) {
        throw oauthError(OAuthErrorCode.InvalidClientMetadata, parsed.error.message);
      }
      const metadata = parsed.data;
      const publicClient = metadata.token_endpoint_auth_method === "none";
      const issuedAt = Math.floor(Date.now() / 1000);
      const registered = await clientsStore.registerClient!({
        ...metadata,
        ...(publicClient
          ? {}
          : {
              client_secret: randomBytes(32).toString("hex"),
              client_secret_expires_at: issuedAt + (720 * 60 * 60),
            }),
      });
      res.status(201).json(registered);
    } catch (error) {
      sendOAuthError(res, error);
    }
  });
  return router;
}

export function revocationHandler(options: { provider: OAuthServerProvider }): RequestHandler {
  const { provider } = options;
  if (!provider.revokeToken) throw new Error("Auth provider does not support revoking tokens");
  const router = express.Router();
  router.use(allowMethods(["POST"]));
  router.use(express.urlencoded({ extended: false }));
  router.use(endpointRateLimit(50, "You have exceeded the rate limit for token revocation requests"));
  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const client = await authenticateClient(provider, req.body);
      const parsed = OAuthTokenRevocationRequestSchema.safeParse(req.body);
      if (!parsed.success) throw oauthError(OAuthErrorCode.InvalidRequest, parsed.error.message);
      await provider.revokeToken!(client, parsed.data);
      res.status(200).json({});
    } catch (error) {
      sendOAuthError(res, error);
    }
  });
  return router;
}

export function metadataHandler(metadata: unknown): RequestHandler {
  const router = express.Router();
  router.use(allowMethods(["GET"]));
  router.get("/", (_req, res) => {
    res.status(200).json(metadata);
  });
  return router;
}

function insecureIssuerAllowed(): boolean {
  return process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true"
    || process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "1";
}

function validateIssuerUrl(issuer: URL): void {
  if (
    issuer.protocol !== "https:"
    && issuer.hostname !== "localhost"
    && issuer.hostname !== "127.0.0.1"
    && !insecureIssuerAllowed()
  ) {
    throw new Error("Issuer URL must be HTTPS");
  }
  if (issuer.hash) throw new Error(`Issuer URL must not have a fragment: ${issuer}`);
  if (issuer.search) throw new Error(`Issuer URL must not have a query string: ${issuer}`);
}

export function createOAuthMetadata(options: AuthMetadataOptions): OAuthMetadata {
  const { provider, issuerUrl, baseUrl = issuerUrl, scopesSupported } = options;
  validateIssuerUrl(issuerUrl);
  return {
    issuer: issuerUrl.href,
    authorization_endpoint: new URL("authorize", baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`)).href,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint: new URL("token", baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`)).href,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: scopesSupported,
    revocation_endpoint: provider.revokeToken
      ? new URL("revoke", baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`)).href
      : undefined,
    revocation_endpoint_auth_methods_supported: provider.revokeToken ? ["client_secret_post"] : undefined,
    registration_endpoint: provider.clientsStore.registerClient
      ? new URL("register", baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`)).href
      : undefined,
    authorization_response_iss_parameter_supported: provider.authorizationResponseIssParameterSupported ?? true,
  };
}
