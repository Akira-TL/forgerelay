import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { debugBaseUrl, debugMcpUrl, debugRoot, repoRoot } from "../runtime.mjs";
import {
  assertDebugPortFree,
  authorizeDebugClient,
  callTool,
  curlRequest,
  initializeRequest,
  jsonRequest,
  mcpHeaders,
  mcpRequest,
  pass,
  stopServer,
  toolText,
  waitForHealth,
} from "./support.mjs";

const acceptanceRoot = resolve(debugRoot, "media-acceptance");
const configDir = join(acceptanceRoot, "config");
const stateDir = join(acceptanceRoot, "state");
const workspaceRoot = join(acceptanceRoot, "workspace");
const outsideRoot = resolve(tmpdir(), `forgerelay-media-outside-${randomUUID()}`);
const ownerToken = randomBytes(32).toString("base64url");
const credentialSentinel = "MEDIA_ACCEPTANCE_EXTERNAL_MCP_CREDENTIAL_SECRET";
const directImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcXcAAAAASUVORK5CYII=";
const externalFixture = fileURLToPath(
  new URL("../../../src/mcp/operations/external-mcp/test-fixtures/external-mcp-server.mjs", import.meta.url),
);
const transformScriptPath = join(workspaceRoot, ".forgerelay", "path-image-transform.mjs");
const transformHookPath = join(workspaceRoot, ".forgerelay", "hooks", "20-render-path-image.json");

await assertDebugPortFree();
rmSync(acceptanceRoot, { recursive: true, force: true });
rmSync(outsideRoot, { recursive: true, force: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(workspaceRoot, "renders"), { recursive: true });
mkdirSync(join(workspaceRoot, ".forgerelay", "hooks"), { recursive: true });
mkdirSync(outsideRoot, { recursive: true });

const visualSentinel = createVisualSentinelPng();
const visualSentinelBase64 = visualSentinel.toString("base64");
writeFileSync(join(workspaceRoot, "visual-sentinel.png"), visualSentinel);
writeFileSync(join(workspaceRoot, "renders", "output.png"), visualSentinel);
writeFileSync(join(outsideRoot, "outside.txt"), "outside allowed root\n");
writeFileSync(join(workspaceRoot, "README.md"), "media acceptance workspace\n");

const mediaMaxBytes = visualSentinel.byteLength + Math.max(32, Math.floor(visualSentinel.byteLength / 2));
assert.ok(mediaMaxBytes >= visualSentinel.byteLength);
assert.ok(mediaMaxBytes < visualSentinel.byteLength * 2);

writeFileSync(join(configDir, "config.json"), `${JSON.stringify({
  host: "127.0.0.1",
  port: 7677,
  allowedRoots: [workspaceRoot],
  publicBaseUrl: debugBaseUrl,
  allowedHosts: ["localhost", "127.0.0.1", "::1"],
  stateDir,
  worktreeRoot: join(acceptanceRoot, "worktrees"),
  mediaMaxBytes,
  mcpServers: {
    blender: {
      transport: "stdio",
      command: process.execPath,
      args: [externalFixture],
      env: { FORGERELAY_MEDIA_ACCEPTANCE_SECRET: credentialSentinel },
    },
  },
}, null, 2)}\n`);
writeFileSync(join(configDir, "auth.json"), `${JSON.stringify({
  ownerToken,
  instanceId: "media-acceptance-7677",
}, null, 2)}\n`, { mode: 0o600 });

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    name !== "HOST" && name !== "PORT" && !name.startsWith("FORGERELAY_")
  ),
);
const env = {
  ...cleanEnv,
  HOST: "127.0.0.1",
  PORT: "7677",
  FORGERELAY_CONFIG_DIR: configDir,
  FORGERELAY_OAUTH_OWNER_TOKEN: ownerToken,
  FORGERELAY_PUBLIC_BASE_URL: debugBaseUrl,
  FORGERELAY_TOOL_MODE: "full",
  FORGERELAY_WIDGETS: "off",
  FORGERELAY_LOG_LEVEL: "info",
  FORGERELAY_LOG_FORMAT: "json",
};

let serverLogs = "";
const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout?.on("data", (chunk) => { serverLogs += chunk.toString(); });
server.stderr?.on("data", (chunk) => { serverLogs += chunk.toString(); });

let completed = false;
try {
  await waitForHealth(server);
  pass("media acceptance health", debugBaseUrl);

  const authorizationServer = jsonRequest(`${debugBaseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationServer.status, 200);
  const oauth = authorizeDebugClient(authorizationServer.json, ownerToken);
  const initialized = mcpRequest(oauth.accessToken, undefined, initializeRequest(1));
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  const initializedNotification = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initializedNotification.status, 202);
  pass("media acceptance OAuth/MCP", "real HTTP MCP session initialized on 7677");

  let requestId = 10;
  const nextId = () => requestId++;
  const conversation = { "openai/session": "media-acceptance-7677" };
  const opened = callTool(oauth.accessToken, sessionId, nextId(), "open_workspace", {
    path: workspaceRoot,
    context: "none",
  }, conversation);
  assert.equal(opened.isError, undefined, toolText(opened));
  const workspaceId = opened.structuredContent.workspaceId;
  assert.match(workspaceId, /^ws_/);

  const readImage = callTool(oauth.accessToken, sessionId, nextId(), "read", {
    workspaceId,
    path: "visual-sentinel.png",
  }, conversation);
  assert.equal(readImage.isError, undefined, toolText(readImage));
  const readImageContent = readImage.content.find((entry) => entry.type === "image");
  assert.ok(readImageContent);
  assert.equal(readImageContent.mimeType, "image/png");
  assert.equal(readImageContent.data, visualSentinelBase64);
  assert.deepEqual(readImage.structuredContent.media, {
    type: "image",
    mimeType: "image/png",
    bytes: visualSentinel.byteLength,
  });
  assert.equal(JSON.stringify(readImage.structuredContent).includes(visualSentinelBase64), false);
  assert.equal(JSON.stringify(readImage._meta ?? {}).includes(visualSentinelBase64), false);
  pass(
    "real 7677 image Read",
    `${visualSentinel.byteLength} PNG bytes reached the Host-facing MCP result unchanged`,
  );

  const outsideRead = callTool(oauth.accessToken, sessionId, nextId(), "read", {
    path: join(outsideRoot, "outside.txt"),
  }, conversation);
  assert.equal(outsideRead.isError, true);
  pass("real 7677 allowed-root containment", "unscoped Read outside the configured root was rejected");

  const externalCall = (tool) => callTool(oauth.accessToken, sessionId, nextId(), "capability", {
    workspaceId,
    name: "mcp.external",
    action: "run",
    arguments: { operation: "call", server: "blender", tool },
  }, conversation);

  const directImage = externalCall("direct_image");
  assert.equal(directImage.isError, undefined, toolText(directImage));
  const externalImage = directImage.content.find((entry) => entry.type === "image");
  assert.ok(externalImage);
  assert.equal(externalImage.mimeType, "image/png");
  assert.equal(externalImage.data, directImageBase64);
  assert.equal(JSON.stringify(directImage.structuredContent).includes(directImageBase64), false);
  pass("real 7677 external MCP ImageContent", "published mcp.external Capability forwarded direct image content");

  const pathOnly = externalCall("path_only");
  assert.equal(pathOnly.isError, undefined, toolText(pathOnly));
  assert.equal(pathOnly.content.some((entry) => entry.type === "image"), false);
  assert.equal(toolText(pathOnly), "renders/output.png");
  pass("external MCP default reference pass-through", "path-only result stayed path-only without a transform Hook");

  installPathTransform({ duplicate: false });
  const transformed = externalCall("path_only");
  assert.equal(transformed.isError, undefined, toolText(transformed));
  const transformedImage = transformed.content.find((entry) => entry.type === "image");
  assert.ok(transformedImage);
  assert.equal(transformedImage.mimeType, "image/png");
  assert.equal(transformedImage.data, visualSentinelBase64);
  assert.equal(JSON.stringify(transformed.structuredContent).includes(visualSentinelBase64), false);
  pass("external MCP explicit transform", "the same path-only result became ImageContent only after the matching Hook was installed");

  installPathTransform({ duplicate: true });
  const transformedOversize = externalCall("path_only");
  assert.equal(transformedOversize.isError, true);
  assert.match(toolText(transformedOversize), /mcp\.media_too_large/i);
  assert.equal(transformedOversize.content.some((entry) => entry.type === "image"), false);
  assert.equal(JSON.stringify(transformedOversize).includes(visualSentinelBase64), false);
  pass("transformed media budget", "post-transform media was revalidated against the configured aggregate limit");

  const malformed = externalCall("malformed_image");
  assert.equal(malformed.isError, true);
  assert.match(toolText(malformed), /mcp\.media_malformed/i);
  const upstreamFailure = externalCall("fail");
  assert.equal(upstreamFailure.isError, true);
  assert.equal(JSON.stringify(upstreamFailure).includes(credentialSentinel), false);
  pass("external MCP negative boundaries", "malformed media and upstream failure stayed bounded and credential-safe");

  completed = true;
} finally {
  await stopServer(server).catch(() => undefined);
  if (completed) {
    assertDirectoryDoesNotContain(stateDir, visualSentinelBase64);
    assertDirectoryDoesNotContain(stateDir, directImageBase64);
    assert.equal(serverLogs.includes(visualSentinelBase64), false, "server logs persisted transformed/read image base64");
    assert.equal(serverLogs.includes(directImageBase64), false, "server logs persisted external image base64");
    assert.equal(serverLogs.includes(credentialSentinel), false, "server logs leaked external MCP credentials");
    pass("media persistence boundary", "image base64 stayed out of ForgeRelay state and logs");
  }
  rmSync(outsideRoot, { recursive: true, force: true });
}

if (completed) {
  console.log("Media acceptance passed.");
}

function installPathTransform({ duplicate }) {
  writeFileSync(transformScriptPath, [
    'import { readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'let input = "";',
    'for await (const chunk of process.stdin) input += chunk;',
    'const envelope = JSON.parse(input);',
    'const path = envelope.result?.content?.find((entry) => entry.type === "text")?.text;',
    'if (typeof path !== "string") throw new Error("expected path-only upstream result");',
    'const data = readFileSync(resolve(process.cwd(), path)).toString("base64");',
    `const images = Array.from({ length: ${duplicate ? 2 : 1} }, () => ({ type: "image", data, mimeType: "image/png" }));`,
    'process.stdout.write(JSON.stringify({ version: 1, result: { content: images } }));',
    '',
  ].join("\n"));
  writeFileSync(transformHookPath, `${JSON.stringify({
    event: "ExternalMcpAfterForward",
    matcher: {
      capability: "mcp.external",
      externalServer: "blender",
      externalTool: "path_only",
    },
    command: 'node ".forgerelay/path-image-transform.mjs"',
    timeoutSeconds: 10,
    report: true,
  }, null, 2)}\n`);
}

function assertDirectoryDoesNotContain(root, needle) {
  if (!existsSync(root)) return;
  const target = Buffer.from(needle, "utf8");
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        assert.equal(readFileSync(path).includes(target), false, `ForgeRelay persisted media base64 in ${path}`);
      }
    }
  }
}

function createVisualSentinelPng() {
  const width = 180;
  const height = 100;
  const stride = (width * 4) + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + (x * 4);
      let pixel = [246, 246, 246, 255];
      if (x >= 14 && x < 64 && y >= 20 && y < 80) pixel = [220, 36, 48, 255];
      if (x >= 116 && x < 166 && y >= 20 && y < 80) pixel = [36, 86, 220, 255];
      if (x >= 84 && x < 96 && y >= 10 && y < 90) pixel = [18, 18, 18, 255];
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
