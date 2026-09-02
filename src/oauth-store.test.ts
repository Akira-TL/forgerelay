import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { databasePath, openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";

const root = await mkdtemp(join(tmpdir(), "forgerelay-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["forgerelay"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTransactionalTokenRotation(join(root, "rotation"));
  testRedirectUriSchemeValidation(join(root, "redirect-validation"));
  await testProviderPrunesExpiredAuthorizationCodes(join(root, "authorization-code-pruning"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testCliTokenIssueAndRefresh(join(root, "cli-provider"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from forgerelay_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "workspace-worktree-branches" },
      { version: 6, name: "local-agent-hook-reports" },
      { version: 7, name: "workspace-context-deliveries" },
      { version: 8, name: "activity-audit" },
      { version: 9, name: "bash-output-audit" },
      { version: 10, name: "activity-host-turns" },
      { version: 11, name: "activity-parent-child" },
      { version: 12, name: "bash-output-audit-columns" },
      { version: 13, name: "activity-host-turn-workspace" },
      { version: 14, name: "subagent-session-coordination" },
      { version: 15, name: "subagent-run-ownership" },
      { version: 16, name: "workspace-session-aliases" },
      { version: 17, name: "workspace-context-components" },
      { version: 18, name: "file-backed-activity-audit" },
      { version: 19, name: "file-backed-bash-metadata" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir);
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["forgerelay"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["forgerelay"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir);
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir);
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["forgerelay"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["forgerelay"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

function testRedirectUriSchemeValidation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir);
  const clients = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts);
  try {
    assert.throws(
      () => clients.registerClient({ redirect_uris: ["http://chatgpt.com/callback"] }),
      /redirect_uri is not allowed/i,
    );
    assert.throws(
      () => clients.registerClient({ redirect_uris: ["custom://chatgpt.com/callback"] }),
      /redirect_uri is not allowed/i,
    );
    assert.ok(clients.registerClient({ redirect_uris: ["https://chatgpt.com/callback"] }));
    assert.ok(clients.registerClient({ redirect_uris: ["http://127.0.0.1:3456/callback"] }));
    assert.ok(clients.registerClient({ redirect_uris: ["https://localhost/callback"] }));
  } finally {
    store.close();
  }
}

async function testProviderPrunesExpiredAuthorizationCodes(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await provider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const expiredCode = "code-expired";
  const activeCode = "code-active";
  provider["codes"].set(expiredCode, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "expired-challenge",
      scopes: ["forgerelay"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() - 1,
  });
  provider["codes"].set(activeCode, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "active-challenge",
      scopes: ["forgerelay"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });

  await provider.exchangeAuthorizationCode(
    client,
    activeCode,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.equal(provider["codes"].has(expiredCode), false);
  assert.equal(provider["codes"].has(activeCode), false);

  provider["codes"].set("code-close-cleanup", {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "close-challenge",
      scopes: ["forgerelay"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  provider.close();
  assert.equal(provider["codes"].size, 0);
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["forgerelay"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["forgerelay"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["forgerelay"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), InvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["forgerelay"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}


async function testCliTokenIssueAndRefresh(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    assert.equal(provider.issueCliTokens("wrong-owner-token"), undefined);

    const issued = provider.issueCliTokens(oauthConfig.ownerToken);
    assert.ok(issued);
    assert.ok(issued.refresh_token);

    const verified = await provider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, "forgerelay-cli");
    assert.deepEqual(verified.scopes, ["forgerelay"]);
    assert.equal(verified.resource?.href, mcpUrl.href);

    const refreshed = provider.exchangeCliRefreshToken(issued.refresh_token);
    assert.ok(refreshed);
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);
    assert.equal(provider.exchangeCliRefreshToken(issued.refresh_token), undefined);

    const refreshedVerified = await provider.verifyAccessToken(refreshed.access_token);
    assert.equal(refreshedVerified.clientId, "forgerelay-cli");
    assert.equal(refreshedVerified.resource?.href, mcpUrl.href);
  } finally {
    provider.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
