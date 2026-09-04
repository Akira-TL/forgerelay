import express, { type RequestHandler } from "express";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthProtectedResourceMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  oauthAuthorizationServerMetadataPath,
  publicEndpointPaths,
  publicEndpointUrl,
} from "./public-url.js";

export interface CliAuthenticationProvider {
  issueCliTokens(ownerToken: string): OAuthTokens | undefined;
  exchangeCliRefreshToken(refreshToken: string): OAuthTokens | undefined;
}

export interface ForgeRelayAuthRouterOptions {
  provider: OAuthServerProvider;
  cliAuthenticationProvider?: CliAuthenticationProvider;
  instanceId?: string;
  issuerUrl: URL;
  resourceServerUrl: URL;
  routeBaseUrls?: readonly URL[];
  scopesSupported?: string[];
  resourceName?: string;
}

export function createForgeRelayAuthRouter(options: ForgeRelayAuthRouterOptions): RequestHandler {
  const {
    provider,
    cliAuthenticationProvider,
    instanceId,
    issuerUrl,
    resourceServerUrl,
    routeBaseUrls = [issuerUrl],
    scopesSupported,
    resourceName,
  } = options;
  const authorizationEndpoint = publicEndpointUrl(issuerUrl, "authorize");
  const tokenEndpoint = publicEndpointUrl(issuerUrl, "token");
  const registrationEndpoint = provider.clientsStore.registerClient
    ? publicEndpointUrl(issuerUrl, "register")
    : undefined;
  const revocationEndpoint = provider.revokeToken
    ? publicEndpointUrl(issuerUrl, "revoke")
    : undefined;

  const cliAuthenticationPaths = publicEndpointPaths(routeBaseUrls, "auth/cli");
  const authorizationPaths = publicEndpointPaths(routeBaseUrls, "authorize");
  const tokenPaths = publicEndpointPaths(routeBaseUrls, "token");
  const registrationPaths = publicEndpointPaths(routeBaseUrls, "register");
  const revocationPaths = publicEndpointPaths(routeBaseUrls, "revoke");

  const oauthMetadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      scopesSupported,
    }),
    authorization_endpoint: authorizationEndpoint.href,
    token_endpoint: tokenEndpoint.href,
    registration_endpoint: registrationEndpoint?.href,
    revocation_endpoint: revocationEndpoint?.href,
  };

  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: resourceServerUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: scopesSupported,
    resource_name: resourceName,
  };

  const router = express.Router();
  if (cliAuthenticationProvider) {
    router.post(cliAuthenticationPaths, express.json({ limit: "4kb" }), (req, res) => {
      const ownerToken = typeof req.body?.owner_token === "string" ? req.body.owner_token : undefined;
      const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : undefined;
      if ((ownerToken ? 1 : 0) + (refreshToken ? 1 : 0) !== 1) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }

      const tokens = ownerToken
        ? cliAuthenticationProvider.issueCliTokens(ownerToken)
        : cliAuthenticationProvider.exchangeCliRefreshToken(refreshToken!);
      if (!tokens) {
        res.status(401).json({ error: "invalid_grant" });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.status(200).json({ ...tokens, ...(instanceId ? { instance_id: instanceId } : {}) });
    });
  }
  router.use(authorizationPaths, authorizationHandler({ provider }));
  router.use(tokenPaths, tokenHandler({ provider }));

  if (provider.clientsStore.registerClient && registrationEndpoint) {
    router.use(registrationPaths, clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  }
  if (provider.revokeToken && revocationEndpoint) {
    router.use(revocationPaths, revocationHandler({ provider }));
  }

  router.use(
    oauthAuthorizationServerMetadataPath(issuerUrl),
    metadataHandler(oauthMetadata),
  );
  router.use(
    new URL(getOAuthProtectedResourceMetadataUrl(resourceServerUrl)).pathname,
    metadataHandler(protectedResourceMetadata),
  );

  return router;
}
