import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { debugBaseUrl, debugMcpUrl, repoRoot } from "../runtime.mjs";

export function authorizeDebugClient(metadata, ownerToken) {
  const redirectUri = `${debugBaseUrl}/debug/callback`;
  const registration = jsonRequest(metadata.registration_endpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ForgeRelay 7677 acceptance",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(registration.status, 201);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationBody = new URLSearchParams({
    response_type: "code",
    client_id: registration.json.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "forgerelay",
    resource: debugMcpUrl,
    state: "forgerelay-debug-acceptance",
    owner_token: ownerToken,
  }).toString();
  const authorization = curlRequest({
    method: "POST",
    url: metadata.authorization_endpoint,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationBody,
  });
  assert.equal(authorization.status, 302);
  const redirect = new URL(authorization.headers.get("location"));
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "forgerelay-debug-acceptance");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const token = jsonRequest(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.json.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: debugMcpUrl,
    }).toString(),
  });
  assert.equal(token.status, 200);
  assert.equal(token.json.token_type, "bearer");
  assert.equal(token.json.scope, "forgerelay");
  assert.ok(token.json.access_token);
  return { accessToken: token.json.access_token };
}

export function initializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
      clientInfo: { name: "forgerelay-debug-acceptance", version: "1.0.0" },
    },
  };
}

export function mcpRequest(accessToken, sessionId, request) {
  const response = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, response.body);
  return { response, message: parseMcpMessage(response.body, request.id) };
}

export function callTool(accessToken, sessionId, id, name, args, meta) {
  const message = mcpRequest(accessToken, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    },
  }).message;
  assert.equal(message.id, id);
  assert.ok(message.result, `tool ${name} did not return a result`);
  return message.result;
}

export function mcpHeaders(accessToken, sessionId) {
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

export function parseMcpMessage(body, expectedId) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const messages = dataLines.length > 0
    ? dataLines.map((line) => JSON.parse(line))
    : [JSON.parse(body)];
  return messages.find((message) => message.id === expectedId) ?? messages[0];
}

export function jsonRequest(url, options = {}) {
  const response = curlRequest({
    method: options.method ?? "GET",
    url,
    headers: options.headers,
    body: options.body,
  });
  return { ...response, json: JSON.parse(response.body) };
}

export function curlRequest({ method = "GET", url, headers = {}, body }) {
  const marker = `__FORGERELAY_DEBUG_STATUS_${randomUUID()}__`;
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--request",
    method,
    "--dump-header",
    "-",
    "--output",
    "-",
    "--write-out",
    `\n${marker}%{http_code}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }
  if (body !== undefined) {
    args.push("--data-binary", "@-");
  }
  args.push(url);

  const result = spawnSync("curl", args, {
    cwd: repoRoot,
    input: body,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`curl ${method} ${url} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }

  const statusMarker = `\n${marker}`;
  const markerIndex = result.stdout.lastIndexOf(statusMarker);
  assert.notEqual(markerIndex, -1, `curl response did not contain status marker for ${url}`);
  const rawResponse = result.stdout.slice(0, markerIndex);
  const status = Number(result.stdout.slice(markerIndex + statusMarker.length).trim());
  const separator = rawResponse.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const headerEnd = rawResponse.indexOf(separator);
  assert.notEqual(headerEnd, -1, `curl response did not contain headers for ${url}`);
  const headerBlock = rawResponse.slice(0, headerEnd);
  const responseBody = rawResponse.slice(headerEnd + separator.length);
  const responseHeaders = new Map();
  for (const line of headerBlock.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    responseHeaders.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers: responseHeaders, body: responseBody };
}

export async function waitForHealth(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`debug server exited before health check: ${child.exitCode}`);
    }
    try {
      const response = jsonRequest(`${debugBaseUrl}/healthz`);
      if (response.status === 200) return response.json;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error("debug server did not become healthy on 127.0.0.1:7677");
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([
    exited,
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

export function setupGitProject(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "debug git project\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "forgerelay-debug@example.com"]);
  runGit(root, ["config", "user.name", "ForgeRelay Debug"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial debug commit"]);
}

export function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function gitOutput(cwd, args, options = {}) {
  const gitArgs = options.gitDir ? ["--git-dir", cwd, ...args] : args;
  const result = spawnSync("git", gitArgs, {
    ...(options.gitDir ? {} : { cwd }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

export function exerciseReleaseTagHooks(accessToken, sessionId, { acceptanceRoot, releaseProject, releaseRemote }) {
  setupGitProject(releaseProject);
  runGit(acceptanceRoot, ["init", "--bare", releaseRemote]);
  runGit(releaseProject, ["remote", "add", "origin", releaseRemote]);
  mkdirSync(join(releaseProject, ".forgerelay", "hooks"), { recursive: true });
  writeFileSync(
    join(releaseProject, ".forgerelay", "release-check.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'const payload = process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}";',
      'const parsed = JSON.parse(payload);',
      'writeFileSync("release-ci-ran.txt", payload);',
      'if (parsed.command === "git push origin v0.2.1") process.exit(17);',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(releaseProject, ".forgerelay", "hooks", "release-tag-local-ci.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "git push origin v0\\.2\\.[01]" },
      command: "node .forgerelay/release-check.mjs",
      timeoutSeconds: 30,
      report: true,
    }, null, 2) + "\n",
  );
  runGit(releaseProject, ["add", ".forgerelay"]);
  runGit(releaseProject, ["commit", "-m", "Add release hook fixture"]);
  runGit(releaseProject, ["tag", "v0.2.0"]);
  runGit(releaseProject, ["tag", "v0.2.1"]);

  const opened = callTool(accessToken, sessionId, 11, "open_workspace", {
    path: releaseProject,
  });
  const releaseWorkspaceId = opened.structuredContent.workspaceId;

  const pushed = callTool(accessToken, sessionId, 12, "bash", {
    workspaceId: releaseWorkspaceId,
    command: "git status --short && git push origin v0.2.0 && echo release-pushed",
  });
  assert.equal(pushed.isError, undefined);
  assert.match(toolText(pushed), /release-tag-local-ci \(BeforeTool, project\) passed/);
  assert.ok(existsSync(join(releaseProject, "release-ci-ran.txt")));
  assert.deepEqual(JSON.parse(readFileSync(join(releaseProject, "release-ci-ran.txt"), "utf8")), {
    tool: "bash",
    action: "run",
    command: "git push origin v0.2.0",
    workingDirectory: ".",
    originalCommand: "git status --short && git push origin v0.2.0 && echo release-pushed",
  });
  assert.equal(
    gitOutput(releaseRemote, ["rev-parse", "refs/tags/v0.2.0"], { gitDir: true }),
    gitOutput(releaseProject, ["rev-parse", "v0.2.0"]),
  );

  const blocked = callTool(accessToken, sessionId, 13, "bash", {
    workspaceId: releaseWorkspaceId,
    command: "git status --short && git push origin v0.2.1 && echo should-not-run",
  });
  assert.equal(blocked.isError, true);
  assert.match(toolText(blocked), /release-tag-local-ci.*failed/);
  const missingTag = spawnSync("git", ["--git-dir", releaseRemote, "show-ref", "--verify", "--quiet", "refs/tags/v0.2.1"]);
  assert.notEqual(missingTag.status, 0, "blocked release tag unexpectedly reached the remote");
  pass("release tag hook gate", "local Hook passed before v0.2.0 push and blocked v0.2.1 before remote mutation");
}

export function exerciseSubagentHooks(runtimeEnv, debugStateDir, workspaceId, workspaceRoot, acceptanceRoot) {
  const seedScript = [
    'import { SubagentSessionStore } from "./src/subagents/sessions/store.js";',
    'const store = new SubagentSessionStore(process.env.FORGERELAY_STATE_DIR);',
    'const record = store.create({',
    `  workspaceId: ${JSON.stringify(workspaceId)},`,
    `  workspaceRoot: ${JSON.stringify(workspaceRoot)},`,
    '  profileName: "debug-missing-profile",',
    '  provider: "codex",',
    '  activeRun: { id: "run_debug_acceptance", startedAt: new Date().toISOString() },',
    '});',
    'store.close();',
    'process.stdout.write(record.id);',
  ].join("\n");
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", seedScript], {
    cwd: repoRoot,
    env: { ...runtimeEnv, FORGERELAY_STATE_DIR: debugStateDir },
    encoding: "utf8",
  });
  if (seeded.status !== 0) {
    throw new Error(`unable to seed debug subagent: ${seeded.stderr.trim()}`);
  }
  const agentId = seeded.stdout.trim();
  assert.match(agentId, /^agt_/);

  const promptFile = join(acceptanceRoot, "subagent-prompt.txt");
  writeFileSync(promptFile, "debug acceptance prompt that must not reach a provider\n", "utf8");
  const worker = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "agents", "__worker", agentId, "--prompt-file", promptFile],
    { cwd: repoRoot, env: runtimeEnv, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (worker.status !== 0) {
    throw new Error(`debug subagent worker failed to execute: ${worker.stderr.trim()}`);
  }

  const inspectScript = [
    'import { SubagentSessionStore } from "./src/subagents/sessions/store.js";',
    'import { SubagentDeliveryMailbox } from "./src/subagents/sessions/delivery-mailbox.js";',
    'const store = new SubagentSessionStore(process.env.FORGERELAY_STATE_DIR);',
    `const record = store.get(${JSON.stringify(agentId)});`,
    `const deliveries = new SubagentDeliveryMailbox(process.env.FORGERELAY_STATE_DIR).claimSession(${JSON.stringify(workspaceId)}, ${JSON.stringify(agentId)});`,
    'store.close();',
    'process.stdout.write(JSON.stringify({ status: record?.status, latestRun: record?.latestRun, delivery: deliveries[0] }));',
  ].join("\n");
  const inspected = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", inspectScript], {
    cwd: repoRoot,
    env: runtimeEnv,
    encoding: "utf8",
  });
  if (inspected.status !== 0) {
    throw new Error(`unable to inspect debug subagent: ${inspected.stderr.trim()}`);
  }
  const record = JSON.parse(inspected.stdout);
  assert.equal(record.status, "idle");
  assert.equal(record.latestRun?.status, "failed");
  assert.equal(record.delivery?.outcome, "failed");
  assert.match(record.delivery?.error ?? "", /Subagent profile not found/);
  pass("subagent hook path", `${agentId} stopped in deterministic failed Run without calling a provider`);
}

export function toolText(result) {
  return (result.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

export function readHookEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function assertDebugPortFree() {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: "127.0.0.1", port: 7677 });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      rejectPromise(new Error("debug port 7677 is already in use; stop the existing debug server first"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") {
        resolvePromise();
        return;
      }
      rejectPromise(error);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolvePromise();
    });
  });
}

export function assertCurlAvailable() {
  const result = spawnSync("curl", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("npm run debug:accept requires curl on PATH.");
  }
}

export function pass(label, detail) {
  console.log(`✓ ${label}: ${detail}`);
}
