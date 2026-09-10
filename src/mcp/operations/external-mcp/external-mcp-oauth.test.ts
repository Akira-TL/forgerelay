import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import {
  ExternalMcpCredentialStore,
  externalMcpCredentialIdentity,
} from "../../../runtime/config/external-mcp-auth-store.js";
import {
  ExternalMcpOAuthError,
  createExternalMcpRuntimeAuth,
} from "./external-mcp-oauth.js";

void test("External MCP runtime auth hot-reads token and silently refreshes after 401", async (t) => {
  let refreshes = 0;
  const tokenServer = createServer(async (request, response) => {
    const body = await readBody(request);
    const params = new URLSearchParams(body);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("refresh_token"), "refresh-old");
    refreshes += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: `access-${refreshes}`,
      refresh_token: `refresh-${refreshes}`,
      token_type: "bearer",
      expires_in: 3600,
    }));
  });
  await listen(tokenServer);
  t.after(() => close(tokenServer));
  const issuer = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-auth-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  await seedRefreshableCredential(store, identity, "https://mcp.example.test/", issuer);

  const runtime = createExternalMcpRuntimeAuth(store, identity, "https://mcp.example.test/");
  assert.ok(runtime.authProvider);
  assert.equal(await runtime.authProvider.token(), "access-old");
  await runtime.authProvider.onUnauthorized?.({
    serverUrl: new URL("https://mcp.example.test/"),
    response: new Response(null, { status: 401 }),
    fetchFn: fetch,
  });

  assert.equal(refreshes, 1);
  assert.equal(store.read(identity)?.tokens?.access_token, "access-1");
  assert.equal(store.read(identity)?.tokens?.refresh_token, "refresh-1");
  assert.equal(store.read(identity)?.reauthorization, undefined);
});

void test("concurrent External MCP 401 refreshes serialize by credential identity", async (t) => {
  let refreshes = 0;
  const tokenServer = createServer(async (_request, response) => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      token_type: "bearer",
    }));
  });
  await listen(tokenServer);
  t.after(() => close(tokenServer));
  const issuer = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-race-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const storeA = new ExternalMcpCredentialStore({ configDir });
  const storeB = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  await seedRefreshableCredential(storeA, identity, "https://mcp.example.test/", issuer);
  const runtimeA = createExternalMcpRuntimeAuth(storeA, identity, "https://mcp.example.test/");
  const runtimeB = createExternalMcpRuntimeAuth(storeB, identity, "https://mcp.example.test/");
  assert.ok(runtimeA.authProvider && runtimeB.authProvider);
  await Promise.all([runtimeA.authProvider.token(), runtimeB.authProvider.token()]);

  const context = {
    serverUrl: new URL("https://mcp.example.test/"),
    response: new Response(null, { status: 401 }),
    fetchFn: fetch,
  };
  await Promise.all([
    runtimeA.authProvider.onUnauthorized?.(context),
    runtimeB.authProvider.onUnauthorized?.(context),
  ]);

  assert.equal(refreshes, 1);
  assert.equal(storeA.read(identity)?.tokens?.access_token, "access-new");
});

void test("invalid_grant preserves prior External MCP credential and marks reauthorization", async (t) => {
  const tokenServer = createServer(async (_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_grant" }));
  });
  await listen(tokenServer);
  t.after(() => close(tokenServer));
  const issuer = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-invalid-grant-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  await seedRefreshableCredential(store, identity, "https://mcp.example.test/", issuer);
  const runtime = createExternalMcpRuntimeAuth(store, identity, "https://mcp.example.test/");
  assert.ok(runtime.authProvider);
  await runtime.authProvider.token();

  const onUnauthorized = runtime.authProvider.onUnauthorized;
  assert.ok(onUnauthorized);
  await assert.rejects(
    onUnauthorized({
      serverUrl: new URL("https://mcp.example.test/"),
      response: new Response(null, { status: 401 }),
      fetchFn: fetch,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExternalMcpOAuthError);
      assert.equal(error.code, "reauthorization_required");
      return true;
    },
  );
  const retained = store.read(identity);
  assert.equal(retained?.tokens?.access_token, "access-old");
  assert.equal(retained?.tokens?.refresh_token, "refresh-old");
  assert.equal(retained?.reauthorization?.reason, "invalid_grant");
});

void test("External MCP runtime uses exact string comparison for stored issuer binding", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-issuer-string-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  const serverUrl = "https://mcp.example.test/mcp";
  await store.replace(identity, serverUrl, {
    tokens: {
      access_token: "must-not-be-sent",
      token_type: "bearer",
      issuer: "https://issuer.example.test/",
    },
    clientInformation: {
      client_id: "client",
      issuer: "https://issuer.example.test",
    },
    authorizationServerUrl: "https://issuer.example.test",
  });

  const runtime = createExternalMcpRuntimeAuth(store, identity, serverUrl);
  assert.equal(runtime.bindingMismatch, true);
  assert.equal(runtime.authProvider, undefined);
});

void test("External MCP runtime refuses an issuer-mismatched stored credential before sending a bearer token", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-issuer-binding-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  const serverUrl = "https://mcp.example.test/mcp";
  await store.replace(identity, serverUrl, {
    tokens: {
      access_token: "must-not-be-sent",
      token_type: "bearer",
      issuer: "https://issuer-a.example.test/",
    },
    clientInformation: {
      client_id: "client",
      issuer: "https://issuer-b.example.test/",
    },
    discoveryState: {
      authorizationServerUrl: "https://issuer-a.example.test/",
      authorizationServerMetadata: {
        issuer: "https://issuer-a.example.test/",
        authorization_endpoint: "https://issuer-a.example.test/authorize",
        token_endpoint: "https://issuer-a.example.test/token",
        response_types_supported: ["code"],
      },
    },
    authorizationServerUrl: "https://issuer-a.example.test/",
    resourceUrl: serverUrl,
  });

  const runtime = createExternalMcpRuntimeAuth(store, identity, serverUrl);
  assert.equal(runtime.bindingMismatch, true);
  assert.equal(runtime.authProvider, undefined);
});

void test("External MCP runtime never sends credentials after configured resource URL changes", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-runtime-binding-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const store = new ExternalMcpCredentialStore({ configDir });
  const identity = externalMcpCredentialIdentity("global", "example", "/unused");
  await store.replace(identity, "https://old.example.test/mcp", {
    tokens: { access_token: "must-not-be-sent", token_type: "bearer" },
  });

  const runtime = createExternalMcpRuntimeAuth(store, identity, "https://new.example.test/mcp");
  assert.equal(runtime.bindingMismatch, true);
  assert.equal(runtime.authProvider, undefined);
});

async function seedRefreshableCredential(
  store: ExternalMcpCredentialStore,
  identity: ReturnType<typeof externalMcpCredentialIdentity>,
  serverUrl: string,
  issuer: string,
): Promise<void> {
  const discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl: issuer,
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
  };
  await store.replace(identity, serverUrl, {
    tokens: {
      access_token: "access-old",
      refresh_token: "refresh-old",
      token_type: "bearer",
      issuer,
    },
    clientInformation: {
      client_id: "forgerelay-test-client",
      issuer,
    },
    discoveryState,
    authorizationServerUrl: issuer,
    resourceUrl: serverUrl,
  });
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function close(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
