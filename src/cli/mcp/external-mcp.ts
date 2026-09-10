import { spawn } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stdin as input, stdout as output } from "node:process";
import * as prompts from "@clack/prompts";
import {
  computeScopeUnion,
  selectClientAuthMethod,
  type AuthorizationServerMetadata,
  type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import {
  ExternalMcpCredentialStore,
  externalMcpCredentialIdentity,
  type ExternalMcpOAuthCredentialRecord,
} from "../../runtime/config/external-mcp-auth-store.js";
import type { ExternalMcpConfigSource } from "../../runtime/config/external-mcp-registry.js";
import type { ExternalMcpHttpServerConfig } from "../../runtime/config/external-mcp-config.js";
import {
  ExternalMcpInteractiveOAuthProvider,
  beginExternalMcpInteractiveOAuth,
  finishExternalMcpInteractiveOAuth,
} from "../../mcp/operations/external-mcp/external-mcp-oauth.js";
import {
  ExternalMcpError,
  ExternalMcpGateway,
} from "../../mcp/operations/external-mcp/external-mcp.js";
import {
  findExternalMcpServerStatus,
  formatAuth,
  formatExternalMcpList,
  inspectExternalMcpStatus,
  resolveExternalMcpScope,
  type ExternalMcpResolvedScope,
  type ExternalMcpScopeRequest,
  type ExternalMcpServerStatus,
} from "./status.js";

interface McpCommandOptions extends ExternalMcpScopeRequest {
  server: string;
}

interface ExternalMcpCliTarget {
  store: ExternalMcpCredentialStore;
  projectRoot: string;
  server: string;
  source: ExternalMcpConfigSource;
  serverConfig: ExternalMcpHttpServerConfig;
}

interface LoopbackReceiver {
  redirectUrl: URL;
  waitForCallback(timeoutMs?: number): Promise<URL>;
  close(): Promise<void>;
}

export interface ExternalMcpCliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  isInteractive?: boolean;
  headless?: boolean;
  openBrowser?: (url: URL) => Promise<boolean>;
  promptCallbackUrl?: () => Promise<string>;
  createLoopbackReceiver?: (port?: number) => Promise<LoopbackReceiver>;
  observeAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

export async function runExternalMcpCommand(
  args: string[],
  dependencies: ExternalMcpCliDependencies = {},
): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
    case "ls":
      await runExternalMcpList(parseMcpScopeArgs("list", rest), dependencies);
      return;
    case "test":
      await runExternalMcpTest(parseMcpTargetArgs("test", rest), dependencies);
      return;
    case "auth":
      await runExternalMcpAuth(parseMcpTargetArgs("auth", rest), dependencies);
      return;
    case "logout":
      await runExternalMcpLogout(parseMcpTargetArgs("logout", rest), dependencies);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printMcpHelp();
      return;
    default:
      throw new Error(`Unknown mcp command: ${subcommand}`);
  }
}

function parseMcpScopeArgs(
  command: "list" | "test" | "auth" | "logout",
  args: string[],
): ExternalMcpScopeRequest & { rest: string[] } {
  let projectRoot: string | undefined;
  let global = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") {
      projectRoot = args[++index];
      if (!projectRoot) throw new Error("Missing value for --project.");
      continue;
    }
    if (arg === "--global") {
      global = true;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown mcp ${command} option: ${arg}`);
    rest.push(arg);
  }
  if (global && projectRoot) throw new Error("--global and --project cannot be used together.");
  return {
    ...(projectRoot ? { projectRoot } : {}),
    ...(global ? { global: true } : {}),
    rest,
  };
}

function parseMcpTargetArgs(
  command: "test" | "auth" | "logout",
  args: string[],
): McpCommandOptions {
  const parsed = parseMcpScopeArgs(command, args);
  if (parsed.rest.length !== 1) {
    throw new Error(`Usage: forgerelay mcp ${command} <server> [--project <path>|--global]`);
  }
  return {
    server: parsed.rest[0],
    ...(parsed.projectRoot ? { projectRoot: parsed.projectRoot } : {}),
    ...(parsed.global ? { global: true } : {}),
  };
}

async function runExternalMcpList(
  options: ExternalMcpScopeRequest & { rest: string[] },
  dependencies: ExternalMcpCliDependencies,
): Promise<void> {
  if (options.rest.length > 0) {
    throw new Error("Usage: forgerelay mcp list [--project <path>|--global]");
  }
  const scope = resolveExternalMcpScope(options, dependencies);
  const status = inspectExternalMcpStatus(scope);
  console.log(formatExternalMcpList(status));
  if (status.configIssues > 0) {
    throw new Error("External MCP configuration or credential status contains issues.");
  }
}

async function runExternalMcpTest(
  options: McpCommandOptions,
  dependencies: ExternalMcpCliDependencies,
): Promise<void> {
  const scope = resolveExternalMcpScope(options, dependencies);
  const initialStatus = inspectExternalMcpStatus(scope);
  const serverStatus = findExternalMcpServerStatus(initialStatus, options.server);
  if (!serverStatus) throw new Error(`Unknown configured External MCP server: ${options.server}.`);
  if (!serverStatus.enabled) {
    throw new Error(`External MCP ${options.server} is disabled by ${serverStatus.source} configuration.`);
  }
  const config = scope.snapshot.servers[options.server];
  if (!config) throw new Error(`Unknown configured External MCP server: ${options.server}.`);

  printTestTarget(scope, serverStatus);
  const gateway = new ExternalMcpGateway(scope.config.mediaMaxBytes, scope.store);
  try {
    const probe = await gateway.probe(
      scope.snapshot.servers,
      options.server,
      undefined,
      { workspaceRoot: scope.projectRoot, origins: scope.snapshot.origins },
    );
    console.log("Connection: ok");
    console.log(
      `Protocol: ${probe.protocolEra}` +
      (probe.protocolVersion ? ` · ${probe.protocolVersion}` : ""),
    );
    console.log(`Tools: ${probe.toolCount}${probe.truncated ? "+ · truncated" : ""}`);
    console.log(`${options.server} is ready.`);
  } catch (error) {
    if (!(error instanceof ExternalMcpError)) throw error;
    const latestStatus = inspectExternalMcpStatus(scope);
    const latestServer = findExternalMcpServerStatus(latestStatus, options.server) ?? serverStatus;
    if (error.code === "auth_required" || error.code === "reauthorization_required") {
      console.log(`Auth: ${formatAuth(latestServer)}`);
      console.log("Connection: blocked by authentication");
      console.log(`Reason: ${error.message}`);
      console.log(`Next: ${externalMcpAuthCommand(scope, options.server)}`);
    } else if (error.code === "tool_discovery_failed") {
      console.log("Connection: ok");
      console.log("Tools: failed");
      console.log(`Reason: ${error.detail ?? "MCP tools/list failed."}`);
      console.log("Next: check the MCP server logs and retry this test.");
    } else {
      console.log("Connection: failed");
      console.log(`Reason: ${error.detail ?? "MCP connection or protocol handshake failed."}`);
      console.log("Next: check the server configuration, process/network reachability, and retry this test.");
    }
    throw new Error(`External MCP ${options.server} test failed.`);
  }
}

function printTestTarget(
  scope: ExternalMcpResolvedScope,
  server: ExternalMcpServerStatus,
): void {
  console.log(`Testing External MCP ${server.name}`);
  if (scope.mode === "project") console.log(`Project: ${scope.projectRoot}`);
  console.log(`Source: ${server.source}`);
  console.log(`Transport: ${server.transport}`);
  console.log(`Auth: ${formatAuth(server)}`);
}

function externalMcpAuthCommand(scope: ExternalMcpResolvedScope, server: string): string {
  return scope.mode === "global"
    ? `forgerelay mcp auth ${cliArgument(server)} --global`
    : `forgerelay mcp auth ${cliArgument(server)} --project ${cliArgument(scope.projectRoot)}`;
}

function cliArgument(value: string): string {
  return /^[A-Za-z0-9_./:\\-]+$/.test(value) ? value : JSON.stringify(value);
}

function formatCredentialScope(source: ExternalMcpConfigSource, projectRoot: string): string {
  return source === "project" ? `project · ${projectRoot}` : "global";
}

async function runExternalMcpAuth(
  options: McpCommandOptions,
  dependencies: ExternalMcpCliDependencies,
): Promise<void> {
  assertInteractive(dependencies);
  const target = resolveExternalMcpCliTarget(options, dependencies);
  if (hasStaticAuthorizationHeader(target.serverConfig.headers)) {
    throw new Error(
      `External MCP ${target.server} uses a static Authorization header; remove that header before using OAuth authentication.`,
    );
  }

  console.log(`Authenticating External MCP ${target.server}`);
  console.log(`Source: ${target.source}`);
  console.log(`Transport: ${target.serverConfig.transport}`);
  console.log(`Credential scope: ${formatCredentialScope(target.source, target.projectRoot)}`);

  const identity = externalMcpCredentialIdentity(target.source, target.server, target.projectRoot);
  const existing = target.store.read(identity);
  const receiver = await (dependencies.createLoopbackReceiver ?? createLoopbackReceiver)(
    target.serverConfig.oauth?.callbackPort,
  );
  let authorizationUrl: URL | undefined;
  let authorizationServerPrinted = false;
  let needsPaste = dependencies.headless ?? isHeadlessEnvironment(dependencies.env ?? process.env);
  try {
    const provider = new ExternalMcpInteractiveOAuthProvider({
      serverUrl: target.serverConfig.url,
      redirectUrl: receiver.redirectUrl,
      ...(target.serverConfig.oauth?.clientMetadataUrl
        ? { clientMetadataUrl: target.serverConfig.oauth.clientMetadataUrl }
        : {}),
      existing,
      onAuthorizationUrl: async (url) => {
        authorizationUrl = new URL(url);
        await dependencies.observeAuthorizationUrl?.(url);
        const authorizationServer = provider.authorizationServerUrl();
        if (authorizationServer && !authorizationServerPrinted) {
          authorizationServerPrinted = true;
          console.log(`Authorization server: ${authorizationServer}`);
        }
        console.log(`Authorization URL: ${url.toString()}`);
        if (needsPaste) return;
        const opened = await (dependencies.openBrowser ?? openBrowser)(url);
        if (opened) {
          console.log("Opened the authorization URL in your browser.");
        } else {
          needsPaste = true;
          console.log("Could not open a browser automatically; open the authorization URL manually.");
        }
      },
    });

    await beginExternalMcpInteractiveOAuth(
      provider,
      target.serverConfig.url,
      computeScopeUnion(existing?.tokens?.scope, existing?.reauthorization?.scope),
    );
    if (!authorizationUrl) throw new Error("External MCP OAuth did not provide an authorization URL.");

    let callbackUrl: URL;
    if (needsPaste) {
      console.log("After authorization, paste the final callback URL below.");
      callbackUrl = parseCallbackUrl(await promptMaskedCallback(dependencies));
    } else {
      try {
        console.log("Waiting for the browser callback...");
        callbackUrl = await receiver.waitForCallback(CALLBACK_TIMEOUT_MS);
      } catch {
        console.log("Browser callback was not received. Paste the final callback URL below.");
        callbackUrl = parseCallbackUrl(await promptMaskedCallback(dependencies));
      }
    }

    const staged = await finishExternalMcpInteractiveOAuth(provider, target.serverConfig.url, callbackUrl);
    await target.store.withIdentityLock(identity, () =>
      target.store.replace(identity, target.serverConfig.url, staged));
    console.log(`Granted scopes: ${staged.tokens?.scope?.trim() || "not reported"}`);
    console.log(`Authenticated External MCP ${target.server} (${target.source}).`);
    console.log(`Credential store: ${target.store.filePath}`);
  } finally {
    await receiver.close().catch(() => undefined);
  }
}

async function runExternalMcpLogout(
  options: McpCommandOptions,
  dependencies: ExternalMcpCliDependencies,
): Promise<void> {
  const target = resolveExternalMcpCliTarget(options, dependencies);
  console.log(`Logging out External MCP ${target.server}`);
  console.log(`Source: ${target.source}`);
  console.log(`Credential scope: ${formatCredentialScope(target.source, target.projectRoot)}`);
  const identity = externalMcpCredentialIdentity(target.source, target.server, target.projectRoot);
  let existing: ExternalMcpOAuthCredentialRecord | undefined;
  await target.store.withIdentityLock(identity, async () => {
    existing = target.store.read(identity);
    if (existing) await target.store.remove(identity);
  });
  if (!existing) {
    console.log(`No stored OAuth credential for External MCP ${target.server} (${target.source}).`);
    return;
  }

  let revocation: "revoked" | "unsupported" | "failed" = "unsupported";
  try {
    revocation = await revokeCredential(existing);
  } catch {
    revocation = "failed";
  }

  console.log(`Removed local OAuth credential for External MCP ${target.server} (${target.source}).`);
  if (revocation === "revoked") console.log("Remote revocation: succeeded.");
  else if (revocation === "unsupported") console.log("Remote revocation: not advertised by the authorization server.");
  else console.log("Remote revocation: failed; the local credential was still removed.");
}

function resolveExternalMcpCliTarget(
  options: McpCommandOptions,
  dependencies: ExternalMcpCliDependencies,
): ExternalMcpCliTarget {
  const scope = resolveExternalMcpScope(options, dependencies);
  const serverConfig = scope.snapshot.servers[options.server];
  const source = scope.snapshot.origins[options.server];
  if (!serverConfig || !source) {
    const maskedBy = scope.snapshot.masked[options.server];
    if (maskedBy) {
      throw new Error(`External MCP ${options.server} is disabled by ${maskedBy} configuration.`);
    }
    throw new Error(`Unknown configured External MCP server: ${options.server}.`);
  }
  if (serverConfig.transport !== "streamable-http") {
    throw new Error(`External MCP ${options.server} uses stdio; interactive OAuth is only available for streamable-http servers.`);
  }
  return {
    store: scope.store,
    projectRoot: scope.projectRoot,
    server: options.server,
    source,
    serverConfig,
  };
}

async function revokeCredential(record: ExternalMcpOAuthCredentialRecord): Promise<"revoked" | "unsupported"> {
  const metadata = record.discoveryState?.authorizationServerMetadata;
  if (!metadata || !("revocation_endpoint" in metadata) || typeof metadata.revocation_endpoint !== "string") {
    return "unsupported";
  }
  const endpoint = metadata.revocation_endpoint;
  const token = record.tokens?.refresh_token ?? record.tokens?.access_token;
  if (!token || !record.clientInformation) return "unsupported";
  const url = new URL(endpoint);
  assertSecureOAuthEndpoint(url);

  const params = new URLSearchParams({
    token,
    token_type_hint: record.tokens?.refresh_token ? "refresh_token" : "access_token",
  });
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  applyClientAuthentication(
    record.clientInformation,
    metadata,
    headers,
    params,
  );
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: params,
    signal: AbortSignal.timeout(15_000),
  });
  await response.text().catch(() => "");
  if (!response.ok) throw new Error(`OAuth revocation failed with HTTP ${response.status}.`);
  return "revoked";
}

function applyClientAuthentication(
  client: StoredOAuthClientInformation,
  metadata: AuthorizationServerMetadata | undefined,
  headers: Headers,
  params: URLSearchParams,
): void {
  const supported = metadata
    && "revocation_endpoint_auth_methods_supported" in metadata
    && Array.isArray(metadata.revocation_endpoint_auth_methods_supported)
    ? metadata.revocation_endpoint_auth_methods_supported
    : metadata?.token_endpoint_auth_methods_supported ?? [];
  const method = selectClientAuthMethod(client, supported);
  if (method === "client_secret_basic") {
    if (!client.client_secret) throw new Error("OAuth revocation requires a client secret.");
    headers.set("authorization", `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`, "utf8").toString("base64")}`);
    return;
  }
  params.set("client_id", client.client_id);
  if (method === "client_secret_post" && client.client_secret) params.set("client_secret", client.client_secret);
}

function assertSecureOAuthEndpoint(url: URL): void {
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Refusing OAuth revocation over an insecure non-loopback endpoint.");
  }
}

function hasStaticAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function assertInteractive(dependencies: ExternalMcpCliDependencies): void {
  const interactive = dependencies.isInteractive ?? (Boolean(input.isTTY) && Boolean(output.isTTY));
  if (!interactive) {
    throw new Error("forgerelay mcp auth requires an interactive terminal for browser/callback authorization.");
  }
}

async function promptMaskedCallback(dependencies: ExternalMcpCliDependencies): Promise<string> {
  if (dependencies.promptCallbackUrl) return dependencies.promptCallbackUrl();
  const result = await prompts.password({
    message: "Final OAuth callback URL",
    mask: "*",
    validate: (value) => value?.trim() ? undefined : "Paste the final callback URL.",
  });
  if (prompts.isCancel(result)) throw new Error("External MCP authentication cancelled.");
  return String(result);
}

function parseCallbackUrl(value: string): URL {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error("The pasted OAuth callback URL is not a valid URL.");
  }
}

async function createLoopbackReceiver(port = 0): Promise<LoopbackReceiver> {
  let resolveCallback!: (url: URL) => void;
  let rejectCallback!: (error: Error) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const callbackPromise = new Promise<URL>((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise;
    rejectCallback = rejectPromise;
  });
  const server: HttpServer = createServer((request, response) => {
    if (!request.url || request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed.\n");
      return;
    }
    const address = server.address() as AddressInfo | null;
    const url = new URL(request.url, `http://127.0.0.1:${address?.port ?? 0}`);
    if (url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("ForgeRelay received the authorization response. You can return to the terminal.\n");
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      resolveCallback(url);
    }
  });
  server.on("error", (error) => {
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      rejectCallback(error);
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const listeningPort = (server.address() as AddressInfo).port;
  return {
    redirectUrl: new URL(`http://127.0.0.1:${listeningPort}/callback`),
    waitForCallback(timeoutMs = CALLBACK_TIMEOUT_MS) {
      if (!settled && !timer) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectCallback(new Error("Timed out waiting for OAuth callback."));
        }, timeoutMs);
        timer.unref?.();
      }
      return callbackPromise;
    },
    async close() {
      if (timer) clearTimeout(timer);
      if (!server.listening) return;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function openBrowser(url: URL): Promise<boolean> {
  const command = browserCommand(url.toString());
  if (!command) return false;
  return new Promise<boolean>((resolveOpen) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    let resolved = false;
    child.once("spawn", () => {
      resolved = true;
      child.unref();
      resolveOpen(true);
    });
    child.once("error", () => {
      if (!resolved) resolveOpen(false);
    });
  });
}

function browserCommand(url: string): { file: string; args: string[] } | undefined {
  if (process.platform === "darwin") return { file: "open", args: [url] };
  if (process.platform === "win32") return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { file: "xdg-open", args: [url] };
}

function isHeadlessEnvironment(env: NodeJS.ProcessEnv): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (process.platform !== "linux") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

function printMcpHelp(): void {
  console.log([
    "ForgeRelay mcp",
    "",
    "Usage:",
    "  forgerelay mcp list [--project <path>|--global]",
    "  forgerelay mcp test <server> [--project <path>|--global]",
    "  forgerelay mcp auth <server> [--project <path>|--global]",
    "  forgerelay mcp logout <server> [--project <path>|--global]",
  ].join("\n"));
}
