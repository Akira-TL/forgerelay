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
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  oauthAuthorizationServerMetadataPath,
  publicEndpointUrl,
} from "./public-url.js";

export interface ForgeRelayAuthRouterOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  resourceServerUrl: URL;
  scopesSupported?: string[];
  resourceName?: string;
}

export function createForgeRelayAuthRouter(options: ForgeRelayAuthRouterOptions): RequestHandler {
  const { provider, issuerUrl, resourceServerUrl, scopesSupported, resourceName } = options;
  const authorizationEndpoint = publicEndpointUrl(issuerUrl, "authorize");
  const tokenEndpoint = publicEndpointUrl(issuerUrl, "token");
  const registrationEndpoint = provider.clientsStore.registerClient
    ? publicEndpointUrl(issuerUrl, "register")
    : undefined;
  const revocationEndpoint = provider.revokeToken
    ? publicEndpointUrl(issuerUrl, "revoke")
    : undefined;

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
  router.use("/authorize", authorizationHandler({ provider }));
  router.use("/token", tokenHandler({ provider }));

  if (provider.clientsStore.registerClient) {
    router.use("/register", clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  }
  if (provider.revokeToken) {
    router.use("/revoke", revocationHandler({ provider }));
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
