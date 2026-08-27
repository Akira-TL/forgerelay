import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createForgeRelayAuthRouter } from "./router.js";
import {
  oauthAuthorizationServerMetadataPath,
  publicEndpointUrl,
} from "./public-url.js";

test("public endpoint URLs preserve a configured deployment path", () => {
  assert.equal(
    publicEndpointUrl("https://babelbeast.com/forgerelay/main", "mcp").href,
    "https://babelbeast.com/forgerelay/main/mcp",
  );
  assert.equal(
    publicEndpointUrl("https://babelbeast.com/forgerelay/debug/", "/authorize").href,
    "https://babelbeast.com/forgerelay/debug/authorize",
  );
  assert.equal(
    oauthAuthorizationServerMetadataPath("https://babelbeast.com/forgerelay/main"),
    "/.well-known/oauth-authorization-server/forgerelay/main",
  );
});

test("public endpoint URLs preserve legacy root deployment URLs", () => {
  assert.equal(
    publicEndpointUrl("https://forge.example.com", "mcp").href,
    "https://forge.example.com/mcp",
  );
  assert.equal(
    oauthAuthorizationServerMetadataPath("https://forge.example.com"),
    "/.well-known/oauth-authorization-server",
  );
});

test("OAuth router preserves SDK HTTPS issuer validation", () => {
  const provider = {
    clientsStore: {
      getClient: async () => undefined,
    },
  } as unknown as OAuthServerProvider;

  assert.throws(
    () => createForgeRelayAuthRouter({
      provider,
      issuerUrl: new URL("http://forge.example.com/forgerelay/main"),
      resourceServerUrl: new URL("http://forge.example.com/forgerelay/main/mcp"),
      scopesSupported: ["devspace"],
      resourceName: "ForgeRelay",
    }),
    /Issuer URL must be HTTPS/,
  );
});

test("OAuth metadata preserves an instance path prefix", async (t) => {
  const provider = {
    clientsStore: {
      getClient: async () => undefined,
    },
  } as unknown as OAuthServerProvider;
  const issuerUrl = new URL("https://babelbeast.com/forgerelay/debug");
  const resourceServerUrl = publicEndpointUrl(issuerUrl, "mcp");
  const app = express();
  app.use(createForgeRelayAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ["devspace"],
    resourceName: "ForgeRelay",
  }));

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const authMetadataResponse = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-authorization-server/forgerelay/debug`,
  );
  assert.equal(authMetadataResponse.status, 200);
  const authMetadata = await authMetadataResponse.json() as Record<string, unknown>;
  assert.equal(authMetadata.issuer, "https://babelbeast.com/forgerelay/debug");
  assert.equal(authMetadata.authorization_endpoint, "https://babelbeast.com/forgerelay/debug/authorize");
  assert.equal(authMetadata.token_endpoint, "https://babelbeast.com/forgerelay/debug/token");

  const resourceMetadataResponse = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/forgerelay/debug/mcp`,
  );
  assert.equal(resourceMetadataResponse.status, 200);
  const resourceMetadata = await resourceMetadataResponse.json() as Record<string, unknown>;
  assert.equal(resourceMetadata.resource, "https://babelbeast.com/forgerelay/debug/mcp");
  assert.deepEqual(resourceMetadata.authorization_servers, ["https://babelbeast.com/forgerelay/debug"]);
});


test("CLI authentication route issues and refreshes tokens without OAuth browser flow", async (t) => {
  const provider = {
    clientsStore: {
      getClient: async () => undefined,
    },
  } as unknown as OAuthServerProvider;
  let ownerCalls = 0;
  let refreshCalls = 0;
  const cliAuthenticationProvider = {
    issueCliTokens(ownerToken: string) {
      ownerCalls += 1;
      if (ownerToken !== "owner-secret") return undefined;
      return {
        access_token: "access-one",
        token_type: "bearer" as const,
        expires_in: 3600,
        refresh_token: "refresh-one",
        scope: "devspace",
      };
    },
    exchangeCliRefreshToken(refreshToken: string) {
      refreshCalls += 1;
      if (refreshToken !== "refresh-one") return undefined;
      return {
        access_token: "access-two",
        token_type: "bearer" as const,
        expires_in: 3600,
        refresh_token: "refresh-two",
        scope: "devspace",
      };
    },
  };
  const issuerUrl = new URL("https://forge.example.com");
  const app = express();
  app.use(createForgeRelayAuthRouter({
    provider,
    cliAuthenticationProvider,
    issuerUrl,
    resourceServerUrl: publicEndpointUrl(issuerUrl, "mcp"),
    scopesSupported: ["devspace"],
  }));

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const invalidRequest = await fetch(`${baseUrl}/auth/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_token: "owner-secret", refresh_token: "refresh-one" }),
  });
  assert.equal(invalidRequest.status, 400);

  const denied = await fetch(`${baseUrl}/auth/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_token: "wrong" }),
  });
  assert.equal(denied.status, 401);
  assert.equal(ownerCalls, 1);

  const issued = await fetch(`${baseUrl}/auth/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_token: "owner-secret" }),
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  assert.equal(issued.headers.get("pragma"), "no-cache");
  assert.deepEqual(await issued.json(), {
    access_token: "access-one",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "refresh-one",
    scope: "devspace",
  });

  const refreshed = await fetch(`${baseUrl}/auth/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: "refresh-one" }),
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(await refreshed.json(), {
    access_token: "access-two",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "refresh-two",
    scope: "devspace",
  });
});
