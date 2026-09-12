import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { runExternalMcpCommand, type ExternalMcpCliDependencies } from "./external-mcp.js";
import {
  ExternalMcpCredentialStore,
  externalMcpCredentialIdentity,
} from "../../runtime/config/external-mcp-auth-store.js";
import { ExternalMcpError, ExternalMcpGateway } from "../../mcp/operations/external-mcp/external-mcp.js";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";

void test("mcp auth completes OAuth and the running External MCP gateway hot-consumes the stored credential", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  let callbackUrl: URL | undefined;
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async () => ({
      redirectUrl: new URL("http://127.0.0.1:45123/callback"),
      waitForCallback: async () => {
        assert.ok(callbackUrl);
        return callbackUrl;
      },
      close: async () => undefined,
    }),
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };

  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  const gateway = new ExternalMcpGateway(1024 * 1024, store);
  await assert.rejects(
    gateway.run(
      { secure: { transport: "streamable-http", url: fixture.mcpUrl } },
      { operation: "tools", server: "secure" },
      undefined,
      undefined,
      { origins: { secure: "global" } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExternalMcpError);
      assert.equal(error.code, "auth_required");
      return true;
    },
  );

  await runExternalMcpCommand(["auth", "secure"], dependencies);
  const stored = store.read(identity);
  assert.equal(stored?.tokens?.access_token, "access-1");
  assert.equal(stored?.tokens?.refresh_token, "refresh-1");
  assert.equal(stored?.reauthorization, undefined);

  const called = await gateway.run(
    { secure: { transport: "streamable-http", url: fixture.mcpUrl } },
    { operation: "call", server: "secure", tool: "secure_echo", arguments: { message: "hot" } },
    undefined,
    undefined,
    { origins: { secure: "global" } },
  );
  assert.deepEqual(called.value.content, [{ type: "text", text: "secure:hot" }]);
  assert.equal(fixture.lastMcpAuthorization(), "Bearer access-1");

  await runExternalMcpCommand(["logout", "secure"], dependencies);
  assert.equal(store.read(identity), undefined);
  assert.equal(fixture.revocations(), 1);
});

void test("desktop mcp auth receives the OAuth callback through the production loopback listener", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    openBrowser: async (url) => {
      const callback = await authorizeInFakeBrowser(url);
      const response = await fetch(callback, { redirect: "manual" });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /ForgeRelay received the authorization response/i);
      return true;
    },
  };

  await runExternalMcpCommand(["auth", "secure"], dependencies);
  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  assert.equal(store.read(identity)?.tokens?.access_token, "access-1");
});

void test("mcp auth uses configured CIMD client identity without Dynamic Client Registration", async (t) => {
  const fixture = await startOAuthMcpFixture(t, { cimd: true, omitRegistration: true });
  const context = createCliContext(t, fixture.mcpUrl);
  const clientMetadataUrl = "https://client.example/forgerelay.json";
  const callbackPort = 45123;
  writeFileSync(join(context.configDir, "mcp.json"), JSON.stringify({
    servers: {
      secure: {
        transport: "streamable-http",
        url: fixture.mcpUrl,
        oauth: { clientMetadataUrl, callbackPort },
      },
    },
  }));
  let callbackUrl: URL | undefined;
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async (requestedPort) => {
      assert.equal(requestedPort, callbackPort);
      return fakeReceiver(() => callbackUrl);
    },
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };

  await runExternalMcpCommand(["auth", "secure"], dependencies);
  assert.equal(fixture.registrations(), 0);
  assert.equal(fixture.lastAuthorizeClientId(), clientMetadataUrl);
  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  assert.equal(store.read(identity)?.clientInformation?.client_id, clientMetadataUrl);
});

void test("Project External MCP OAuth credentials do not follow copied Project configuration", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  const projectMcpDir = join(context.projectRoot, ".forgerelay");
  mkdirSync(projectMcpDir, { recursive: true });
  const projectConfig = JSON.stringify({
    servers: { secure: { transport: "streamable-http", url: fixture.mcpUrl } },
  });
  writeFileSync(join(projectMcpDir, "mcp.json"), projectConfig);
  let callbackUrl: URL | undefined;
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async () => fakeReceiver(() => callbackUrl),
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };
  await runExternalMcpCommand(["auth", "secure", "--project", context.projectRoot], dependencies);

  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const projectResolver = new ProjectContextResolver(context.configDir);
  const projectAContext = await projectResolver.resolve(context.projectRoot);
  const projectIdentity = externalMcpCredentialIdentity("project", "secure", {
    id: projectAContext.id,
    projectRoot: projectAContext.projectRoot,
  });
  const globalIdentity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  assert.equal(store.read(projectIdentity)?.tokens?.access_token, "access-1");
  assert.equal(store.read(globalIdentity), undefined);

  const projectB = join(context.projectRoot, "..", "project-b");
  mkdirSync(join(projectB, ".forgerelay"), { recursive: true });
  writeFileSync(join(projectB, ".forgerelay", "mcp.json"), projectConfig);
  const projectBContext = await projectResolver.resolve(projectB);
  const projectBIdentity = externalMcpCredentialIdentity("project", "secure", {
    id: projectBContext.id,
    projectRoot: projectBContext.projectRoot,
  });
  assert.notEqual(projectBContext.id, projectAContext.id);
  assert.equal(store.read(projectBIdentity), undefined);

  const gateway = new ExternalMcpGateway(1024 * 1024, store);
  await assert.rejects(
    gateway.run(
      { secure: { transport: "streamable-http", url: fixture.mcpUrl } },
      { operation: "tools", server: "secure" },
      undefined,
      undefined,
      {
        project: { id: projectBContext.id, projectRoot: projectBContext.projectRoot },
        origins: { secure: "project" },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExternalMcpError);
      assert.equal(error.code, "auth_required");
      return true;
    },
  );
});

void test("headless pasted callback failure preserves the previous valid External MCP credential", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  let callbackUrl: URL | undefined;
  const desktopDependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async () => fakeReceiver(() => callbackUrl),
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };
  await runExternalMcpCommand(["auth", "secure"], desktopDependencies);
  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  const before = store.read(identity);
  assert.ok(before);

  fixture.rejectAuthorizationCodeExchange(true);
  callbackUrl = undefined;
  const headlessDependencies: ExternalMcpCliDependencies = {
    ...desktopDependencies,
    headless: true,
    openBrowser: async () => false,
    observeAuthorizationUrl: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
    },
    promptCallbackUrl: async () => {
      assert.ok(callbackUrl);
      return callbackUrl.toString();
    },
    createLoopbackReceiver: async () => ({
      redirectUrl: new URL("http://127.0.0.1:45124/callback"),
      waitForCallback: async () => {
        throw new Error("headless flow must use pasted callback");
      },
      close: async () => undefined,
    }),
  };
  await assert.rejects(
    runExternalMcpCommand(["auth", "secure"], headlessDependencies),
    /invalid_grant|authorization/i,
  );
  const after = store.read(identity);
  assert.equal(after?.revision, before.revision);
  assert.equal(after?.tokens?.access_token, before.tokens?.access_token);
  assert.equal(after?.tokens?.refresh_token, before.tokens?.refresh_token);
});

void test("headless mcp auth masks the pasted callback URL in a real pseudo-terminal", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  const result = await runHeadlessCliWithPseudoTerminal(context.env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Authenticating External MCP secure/);
  assert.match(result.output, /Source: global/);
  assert.match(result.output, /Credential scope: global/);
  assert.match(result.output, /Authorization server: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.output, /Granted scopes: mcp offline_access/);
  assert.match(result.output, /Authenticated External MCP secure \(global\)\./);
  assert.match(result.output, /\*/);
  assert.doesNotMatch(result.output, /code-1/);
  assert.doesNotMatch(result.output, /127\.0\.0\.1:\d+\/callback\?code=/);
});

void test("External MCP insufficient_scope requires human reauthorization and persists the reason", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  let callbackUrl: URL | undefined;
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async () => fakeReceiver(() => callbackUrl),
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };
  await runExternalMcpCommand(["auth", "secure"], dependencies);

  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  const before = store.read(identity);
  assert.ok(before?.tokens?.access_token);
  fixture.requireAdditionalScope(true);

  const gateway = new ExternalMcpGateway(1024 * 1024, store);
  await assert.rejects(
    gateway.run(
      { secure: { transport: "streamable-http", url: fixture.mcpUrl } },
      { operation: "tools", server: "secure" },
      undefined,
      undefined,
      { origins: { secure: "global" } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExternalMcpError);
      assert.equal(error.code, "reauthorization_required");
      assert.match(error.message, /additional OAuth scope/i);
      return true;
    },
  );

  const after = store.read(identity);
  assert.equal(after?.tokens?.access_token, before.tokens?.access_token);
  assert.equal(after?.tokens?.refresh_token, before.tokens?.refresh_token);
  assert.equal(after?.reauthorization?.reason, "insufficient_scope");
});

void test("mcp logout removes local credentials even when remote revocation fails", async (t) => {
  const fixture = await startOAuthMcpFixture(t);
  const context = createCliContext(t, fixture.mcpUrl);
  let callbackUrl: URL | undefined;
  const dependencies: ExternalMcpCliDependencies = {
    env: context.env,
    cwd: context.projectRoot,
    isInteractive: true,
    headless: false,
    createLoopbackReceiver: async () => fakeReceiver(() => callbackUrl),
    openBrowser: async (url) => {
      callbackUrl = await authorizeInFakeBrowser(url);
      return true;
    },
  };
  await runExternalMcpCommand(["auth", "secure"], dependencies);
  const store = new ExternalMcpCredentialStore({ configDir: context.configDir });
  const identity = externalMcpCredentialIdentity("global", "secure", context.projectRoot);
  assert.ok(store.read(identity));
  fixture.rejectRevocation(true);

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };
  try {
    await runExternalMcpCommand(["logout", "secure"], dependencies);
  } finally {
    console.log = originalLog;
  }
  assert.equal(store.read(identity), undefined);
  assert.equal(fixture.revocations(), 1);
  const text = output.join("\n");
  assert.match(text, /Logging out External MCP secure/);
  assert.match(text, /Source: global/);
  assert.match(text, /Credential scope: global/);
  assert.match(text, /Removed local OAuth credential/);
  assert.match(text, /Remote revocation: failed; the local credential was still removed\./);
});

interface OAuthMcpFixture {
  mcpUrl: string;
  lastMcpAuthorization(): string | undefined;
  lastAuthorizeClientId(): string | undefined;
  lastAuthorizeScope(): string | undefined;
  registrations(): number;
  revocations(): number;
  rejectAuthorizationCodeExchange(value: boolean): void;
  rejectRevocation(value: boolean): void;
  requireAdditionalScope(value: boolean): void;
}

interface OAuthMcpFixtureOptions {
  cimd?: boolean;
  omitRegistration?: boolean;
}

async function startOAuthMcpFixture(
  t: TestContext,
  options: OAuthMcpFixtureOptions = {},
): Promise<OAuthMcpFixture> {
  let issuer = "";
  let mcpUrl = "";
  let authorizationCodeCounter = 0;
  let tokenCounter = 0;
  let lastMcpAuth: string | undefined;
  let lastAuthorizeClientId: string | undefined;
  let lastAuthorizeScope: string | undefined;
  let registrationCount = 0;
  let revocationCount = 0;
  let rejectCodeExchange = false;
  let rejectRevoke = false;
  let additionalScopeRequired = false;
  const authorizationCodes = new Map<string, { challenge: string; redirectUri: string }>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const mcpServers = new Set<McpServer>();

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "server_error" }));
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource")) {
      json(response, 200, {
        resource: mcpUrl,
        authorization_servers: [issuer],
        scopes_supported: ["mcp"],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(!options.omitRegistration ? { registration_endpoint: `${issuer}/register` } : {}),
        ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp", "offline_access"],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/register") {
      registrationCount += 1;
      if (options.omitRegistration) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      json(response, 201, { ...body, client_id: "client-1", token_endpoint_auth_method: "none" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      lastAuthorizeClientId = url.searchParams.get("client_id") ?? undefined;
      lastAuthorizeScope = url.searchParams.get("scope") ?? undefined;
      const challenge = url.searchParams.get("code_challenge");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      assert.ok(challenge && redirectUri && state);
      const code = `code-${++authorizationCodeCounter}`;
      authorizationCodes.set(code, { challenge, redirectUri });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      callback.searchParams.set("iss", issuer);
      response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const params = new URLSearchParams(await readBody(request));
      if (params.get("grant_type") === "authorization_code") {
        const code = params.get("code") ?? "";
        const record = authorizationCodes.get(code);
        if (!record || rejectCodeExchange) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        const verifier = params.get("code_verifier") ?? "";
        assert.equal(pkceChallenge(verifier), record.challenge);
        assert.equal(params.get("redirect_uri"), record.redirectUri);
        authorizationCodes.delete(code);
        tokenCounter += 1;
        json(response, 200, {
          access_token: `access-${tokenCounter}`,
          refresh_token: `refresh-${tokenCounter}`,
          token_type: "bearer",
          expires_in: 3600,
          scope: "mcp offline_access",
        });
        return;
      }
      if (params.get("grant_type") === "refresh_token") {
        tokenCounter += 1;
        json(response, 200, {
          access_token: `access-${tokenCounter}`,
          refresh_token: `refresh-${tokenCounter}`,
          token_type: "bearer",
          expires_in: 3600,
          scope: "mcp offline_access",
        });
        return;
      }
      json(response, 400, { error: "unsupported_grant_type" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      revocationCount += 1;
      await readBody(request);
      if (rejectRevoke) {
        json(response, 500, { error: "server_error" });
        return;
      }
      response.writeHead(200, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/mcp") {
      lastMcpAuth = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      if (lastMcpAuth !== `Bearer access-${tokenCounter}`) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
        });
        response.end();
        return;
      }
      if (additionalScopeRequired) {
        response.writeHead(403, {
          "www-authenticate": `Bearer error="insufficient_scope", scope="mcp admin", resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
        });
        response.end();
        return;
      }
      await handleMcpRequest(request, response, sessions, mcpServers);
      return;
    }
    response.writeHead(404).end();
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;
  mcpUrl = `${issuer}/mcp`;
  t.after(async () => {
    await Promise.all([...mcpServers].map((mcp) => mcp.close().catch(() => undefined)));
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  return {
    mcpUrl,
    lastMcpAuthorization: () => lastMcpAuth,
    lastAuthorizeClientId: () => lastAuthorizeClientId,
    lastAuthorizeScope: () => lastAuthorizeScope,
    registrations: () => registrationCount,
    revocations: () => revocationCount,
    rejectAuthorizationCodeExchange: (value) => { rejectCodeExchange = value; },
    rejectRevocation: (value) => { rejectRevoke = value; },
    requireAdditionalScope: (value) => { additionalScopeRequired = value; },
  };
}

function createCliContext(t: TestContext, mcpUrl: string): {
  configDir: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-mcp-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ allowedRoots: [projectRoot] }));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({ ownerToken: "test-owner-token-0123456789" }));
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
    servers: {
      secure: { transport: "streamable-http", url: mcpUrl },
    },
  }));
  return {
    configDir,
    projectRoot,
    env: {
      ...process.env,
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_ALLOWED_ROOTS: projectRoot,
      PORT: "17677",
    },
  };
}

function fakeReceiver(callback: () => URL | undefined) {
  return {
    redirectUrl: new URL("http://127.0.0.1:45123/callback"),
    waitForCallback: async () => {
      const url = callback();
      assert.ok(url);
      return url;
    },
    close: async () => undefined,
  };
}

async function authorizeInFakeBrowser(url: URL): Promise<URL> {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location);
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  servers: Set<McpServer>,
): Promise<void> {
  const sessionHeader = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(request, response);
    return;
  }
  if (sessionId) {
    response.writeHead(404).end();
    return;
  }
  const body = JSON.parse(await readBody(request)) as { method?: unknown };
  if (body.method !== "initialize") {
    response.writeHead(400).end();
    return;
  }
  const mcpServer = new McpServer({ name: "oauth-mcp-fixture", version: "1.0.0" });
  mcpServer.registerTool(
    "secure_echo",
    { inputSchema: { message: z.string() } },
    async ({ message }) => ({ content: [{ type: "text", text: `secure:${message}` }] }),
  );
  servers.add(mcpServer);
  let transport: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      sessions.set(newSessionId, transport);
    },
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(request, response, body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function runHeadlessCliWithPseudoTerminal(
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  const nodePty = await import("node-pty");
  const ptyEnv = Object.fromEntries(
    Object.entries({ ...env, SSH_CONNECTION: "test-headless" })
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const child = nodePty.spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "mcp", "auth", "secure"],
    {
      cwd: process.cwd(),
      env: ptyEnv,
      name: "xterm-256color",
      cols: 100,
      rows: 30,
    },
  );
  let terminalOutput = "";
  let authorizationStarted = false;
  let callbackUrl: URL | undefined;
  let promptVisible = false;
  let sent = false;

  const maybeSend = () => {
    if (sent || !callbackUrl || !promptVisible) return;
    sent = true;
    child.write(`${callbackUrl.toString()}\r`);
  };
  const dataDisposable = child.onData((chunk) => {
    terminalOutput += chunk;
    const visible = stripAnsi(terminalOutput);
    promptVisible = visible.includes("Final OAuth callback URL");
    const match = /Authorization URL: (http[^\r\n]+)/.exec(visible);
    if (match?.[1] && !authorizationStarted) {
      authorizationStarted = true;
      void authorizeInFakeBrowser(new URL(match[1].trim())).then((callback) => {
        callbackUrl = callback;
        maybeSend();
      });
    }
    maybeSend();
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  let exitDisposable: { dispose(): void } | undefined;
  try {
    const status = await new Promise<number | null>((resolveExit) => {
      exitDisposable = child.onExit(({ exitCode }) => resolveExit(exitCode));
    });
    return { status, output: stripAnsi(terminalOutput) };
  } finally {
    clearTimeout(timer);
    dataDisposable.dispose();
    exitDisposable?.dispose();
    // On Windows/ConPTY, a child that exits by itself can leave node-pty
    // resources referenced until the PTY is explicitly killed.
    try {
      child.kill();
    } catch {
      // The PTY may already be fully torn down on non-Windows platforms.
    }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}
