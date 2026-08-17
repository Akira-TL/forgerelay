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
