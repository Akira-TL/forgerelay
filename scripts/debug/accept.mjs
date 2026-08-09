import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDebugEnvironment,
  debugBaseUrl,
  debugMcpUrl,
  debugRoot,
  repoRoot,
} from "./runtime.mjs";

const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const acceptanceRoot = resolve(debugRoot, "acceptance");
const stateDir = resolve(acceptanceRoot, "state");
const worktreeRoot = resolve(acceptanceRoot, "worktrees");
const hookLog = resolve(acceptanceRoot, "hooks.jsonl");
const checkoutWorkspace = resolve(acceptanceRoot, "workspace");
const gitProject = resolve(acceptanceRoot, "git-project");
const releaseProject = resolve(acceptanceRoot, "release-project");
const releaseRemote = resolve(acceptanceRoot, "release-remote.git");
const ownerToken = randomBytes(32).toString("base64url");
const tempAcceptanceRoot = resolve(tmpdir(), `forgerelay-debug-acceptance-${randomUUID()}`);

assertCurlAvailable();
await assertDebugPortFree();
rmSync(acceptanceRoot, { recursive: true, force: true });
mkdirSync(acceptanceRoot, { recursive: true });

const { env } = createDebugEnvironment({ ownerToken, stateDir, worktreeRoot, hookLog });
const server = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

try {
  const health = await waitForHealth(server);
  assert.deepEqual(health, { ok: true, name: "forgerelay" });
  pass("health", JSON.stringify(health));

  const protectedResource = jsonRequest(`${debugBaseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedResource.status, 200);
  assert.equal(protectedResource.json.resource, debugMcpUrl);
  assert.equal(protectedResource.json.resource_name, "ForgeRelay");
  pass("OAuth protected-resource discovery", protectedResource.json.resource);

  const authorizationServer = jsonRequest(`${debugBaseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationServer.status, 200);
  assert.equal(authorizationServer.json.authorization_endpoint, `${debugBaseUrl}/authorize`);
  assert.equal(authorizationServer.json.token_endpoint, `${debugBaseUrl}/token`);
  assert.equal(authorizationServer.json.registration_endpoint, `${debugBaseUrl}/register`);
  pass("OAuth authorization-server discovery", authorizationServer.json.token_endpoint);

  const unauthorized = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(),
    body: JSON.stringify(initializeRequest(1)),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.parse(unauthorized.body).error, "invalid_token");
  pass("unauthorized MCP is rejected", "HTTP 401 invalid_token");

  const oauth = authorizeDebugClient(authorizationServer.json);
  pass("OAuth owner-password flow", "registered client and issued access token");

  const initialized = mcpRequest(oauth.accessToken, undefined, initializeRequest(1));
  assert.equal(initialized.response.status, 200);
  const sessionId = initialized.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.equal(initialized.message.result.serverInfo.name, "forgerelay");
  assert.equal(initialized.message.result.serverInfo.title, "ForgeRelay");
  assert.equal(initialized.message.result.serverInfo.version, packageJson.version);
  pass(
    "MCP initialize",
    JSON.stringify(initialized.message.result.serverInfo),
  );

  const initializedNotification = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initializedNotification.status, 202);

  const tools = mcpRequest(oauth.accessToken, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }).message.result.tools;
  const toolNames = tools.map((tool) => tool.name);
  for (const expected of ["open_workspace", "close_worktree", "read", "write", "edit", "rename", "delete", "grep", "glob", "ls", "bash"]) {
    assert.ok(toolNames.includes(expected), `missing debug tool ${expected}`);
  }
  pass("MCP tools/list", `${toolNames.length} tools: ${toolNames.join(", ")}`);

  const opened = callTool(oauth.accessToken, sessionId, 3, "open_workspace", {
    path: checkoutWorkspace,
  });
  const workspaceId = opened.structuredContent.workspaceId;
  assert.match(workspaceId, /^ws_/);
  assert.equal(opened.structuredContent.root, checkoutWorkspace);
  assert.equal(opened.structuredContent.mode, "checkout");
  pass("open_workspace", `${workspaceId} -> ${opened.structuredContent.root}`);

  const written = callTool(oauth.accessToken, sessionId, 4, "write", {
    workspaceId,
    path: "acceptance.txt",
    content: "forgerelay 7677 acceptance\n",
  });
  assert.equal(written.isError, undefined);

  const read = callTool(oauth.accessToken, sessionId, 5, "read", {
    workspaceId,
    path: "acceptance.txt",
  });
  assert.match(read.structuredContent.result, /forgerelay 7677 acceptance/);
  pass("write + read", JSON.stringify(read.structuredContent));

  const shell = callTool(oauth.accessToken, sessionId, 6, "bash", {
    workspaceId,
    command: "printf debug-bash-ok",
  });
  assert.match(shell.structuredContent.result, /debug-bash-ok/);
  pass("bash", "debug-bash-ok");

  const failedEdit = callTool(oauth.accessToken, sessionId, 7, "edit", {
    workspaceId,
    path: "acceptance.txt",
    edits: [{ oldText: "text that is not present", newText: "unused" }],
  });
  assert.equal(failedEdit.isError, true);
  pass("failed tool path", "edit returned isError=true and triggered AfterToolFailure");

  const renamedWorkspaceFile = callTool(oauth.accessToken, sessionId, 74, "rename", {
    workspaceId,
    path: "acceptance.txt",
    newPath: "renamed-acceptance.txt",
  });
  assert.equal(renamedWorkspaceFile.isError, undefined);
  assert.equal(readFileSync(join(checkoutWorkspace, "renamed-acceptance.txt"), "utf8"), "forgerelay 7677 acceptance\n");
  const deletedWorkspaceFile = callTool(oauth.accessToken, sessionId, 75, "delete", {
    workspaceId,
    path: "renamed-acceptance.txt",
  });
  assert.equal(deletedWorkspaceFile.isError, undefined);
  assert.equal(existsSync(join(checkoutWorkspace, "renamed-acceptance.txt")), false);
  pass("rename + delete", "workspace file renamed and deleted through MCP");

  mkdirSync(tempAcceptanceRoot, { recursive: true });
  const tempFile = join(tempAcceptanceRoot, "mcp-temp.txt");
  const tempWritten = callTool(oauth.accessToken, sessionId, 70, "write", {
    workspaceId,
    path: tempFile,
    content: "forgerelay temp before edit\n",
  });
  assert.equal(tempWritten.isError, undefined);

  const tempRead = callTool(oauth.accessToken, sessionId, 71, "read", {
    workspaceId,
    path: tempFile,
  });
  assert.match(tempRead.structuredContent.result, /forgerelay temp before edit/);

  const tempEdited = callTool(oauth.accessToken, sessionId, 72, "edit", {
    workspaceId,
    path: tempFile,
    edits: [{ oldText: "before edit", newText: "after edit" }],
  });
  assert.equal(tempEdited.isError, undefined);
  assert.equal(readFileSync(tempFile, "utf8"), "forgerelay temp after edit\n");

  const renamedTempFile = join(tempAcceptanceRoot, "mcp-temp-renamed.txt");
  const tempRenamed = callTool(oauth.accessToken, sessionId, 76, "rename", {
    workspaceId,
    path: tempFile,
    newPath: renamedTempFile,
  });
  assert.equal(tempRenamed.isError, undefined);
  assert.equal(readFileSync(renamedTempFile, "utf8"), "forgerelay temp after edit\n");
  const tempDeleted = callTool(oauth.accessToken, sessionId, 77, "delete", {
    workspaceId,
    path: renamedTempFile,
  });
  assert.equal(tempDeleted.isError, undefined);
  assert.equal(existsSync(renamedTempFile), false);

  const outsideRoots = callTool(oauth.accessToken, sessionId, 73, "read", {
    workspaceId,
    path: join(homedir(), "forgerelay-debug-outside-roots.txt"),
  });
  assert.equal(outsideRoots.isError, true);
  assert.match(toolText(outsideRoots), /outside allowed roots/i);
  pass("OS temp file tools", "write + read + edit + rename + delete passed; arbitrary home path rejected");

  setupGitProject(gitProject);
  const worktreeOpened = callTool(oauth.accessToken, sessionId, 8, "open_workspace", {
    path: gitProject,
    mode: "worktree",
  });
  const worktreeWorkspaceId = worktreeOpened.structuredContent.workspaceId;
  const managedWorktreePath = worktreeOpened.structuredContent.worktree.path;
  assert.equal(worktreeOpened.structuredContent.mode, "worktree");
  assert.ok(existsSync(managedWorktreePath));

  callTool(oauth.accessToken, sessionId, 9, "write", {
    workspaceId: worktreeWorkspaceId,
    path: "feature.txt",
    content: "debug worktree acceptance\n",
  });
  const closed = callTool(oauth.accessToken, sessionId, 10, "close_worktree", {
    workspaceId: worktreeWorkspaceId,
    commitMessage: "test(debug): verify 7677 worktree lifecycle",
  });
  assert.equal(closed.structuredContent.committed, true);
  assert.equal(existsSync(managedWorktreePath), false);
  assert.equal(
    readFileSync(join(gitProject, "feature.txt"), "utf8").replace(/\r\n/g, "\n"),
    "debug worktree acceptance\n",
  );
  pass(
    "managed worktree close",
    `${closed.structuredContent.branch} -> ${closed.structuredContent.targetBranch}`,
  );

  exerciseReleaseTagHooks(oauth.accessToken, sessionId);
  exerciseSubagentHooks(env, stateDir, workspaceId, checkoutWorkspace);

  const hookEntries = readHookEntries(hookLog);
  const hookEvents = hookEntries.map((entry) => entry.event);
  for (const expected of [
    "WorkspaceOpen",
    "BeforeTool",
    "AfterTool",
    "AfterToolFailure",
    "AfterFileChange",
    "BeforeWorktreeClose",
    "AfterWorktreeClose",
    "SubagentStart",
    "SubagentStop",
  ]) {
    assert.ok(hookEvents.includes(expected), `debug hook log did not contain ${expected}`);
  }
  assert.ok(
    hookEvents.indexOf("BeforeWorktreeClose") < hookEvents.indexOf("AfterWorktreeClose"),
    "worktree close hooks were recorded out of order",
  );
  pass("Hooks v1 dogfood", Array.from(new Set(hookEvents)).join(", "));

  const deleteSession = curlRequest({
    method: "DELETE",
    url: debugMcpUrl,
    headers: mcpHeaders(oauth.accessToken, sessionId),
  });
  assert.ok([200, 202, 204].includes(deleteSession.status));

  console.log("\nForgeRelay 7677 acceptance passed.");
  console.log(`Artifacts: ${acceptanceRoot}`);
} catch (error) {
  console.error("\nForgeRelay 7677 acceptance failed.");
  throw error;
} finally {
  rmSync(tempAcceptanceRoot, { recursive: true, force: true });
  await stopServer(server);
}

function authorizeDebugClient(metadata) {
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
    scope: "devspace",
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
  assert.equal(token.json.scope, "devspace");
  assert.ok(token.json.access_token);
  return { accessToken: token.json.access_token };
}

function initializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "forgerelay-debug-acceptance", version: "1.0.0" },
    },
  };
}

function mcpRequest(accessToken, sessionId, request) {
  const response = curlRequest({
    method: "POST",
    url: debugMcpUrl,
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200, response.body);
  return { response, message: parseMcpMessage(response.body, request.id) };
}

function callTool(accessToken, sessionId, id, name, args) {
  const message = mcpRequest(accessToken, sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }).message;
  assert.equal(message.id, id);
  assert.ok(message.result, `tool ${name} did not return a result`);
  return message.result;
}

function mcpHeaders(accessToken, sessionId) {
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function parseMcpMessage(body, expectedId) {
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

function jsonRequest(url, options = {}) {
  const response = curlRequest({
    method: options.method ?? "GET",
    url,
    headers: options.headers,
    body: options.body,
  });
  return { ...response, json: JSON.parse(response.body) };
}

function curlRequest({ method = "GET", url, headers = {}, body }) {
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

async function waitForHealth(child) {
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

async function stopServer(child) {
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

function setupGitProject(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "debug git project\n", "utf8");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "forgerelay-debug@example.com"]);
  runGit(root, ["config", "user.name", "ForgeRelay Debug"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial debug commit"]);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function gitOutput(cwd, args, options = {}) {
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

function exerciseReleaseTagHooks(accessToken, sessionId) {
  setupGitProject(releaseProject);
  runGit(acceptanceRoot, ["init", "--bare", releaseRemote]);
  runGit(releaseProject, ["remote", "add", "origin", releaseRemote]);
  mkdirSync(join(releaseProject, ".forgerelay", "hooks"), { recursive: true });
  writeFileSync(
    join(releaseProject, ".forgerelay", "release-check.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'const payload = process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}";',
      'writeFileSync("release-ci-ran.txt", payload);',
      'if (JSON.parse(payload).command === "git push origin v0.2.1") process.exit(17);',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(releaseProject, ".forgerelay", "hooks", "release-tag-local-ci.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "^git push origin v0\\.2\\.[01]$" },
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
    command: "git push origin v0.2.0",
  });
  assert.equal(pushed.isError, undefined);
  assert.match(toolText(pushed), /release-tag-local-ci \(BeforeTool, project\) passed/);
  assert.ok(existsSync(join(releaseProject, "release-ci-ran.txt")));
  assert.equal(
    gitOutput(releaseRemote, ["rev-parse", "refs/tags/v0.2.0"], { gitDir: true }),
    gitOutput(releaseProject, ["rev-parse", "v0.2.0"]),
  );

  const blocked = callTool(accessToken, sessionId, 13, "bash", {
    workspaceId: releaseWorkspaceId,
    command: "git push origin v0.2.1",
  });
  assert.equal(blocked.isError, true);
  assert.match(toolText(blocked), /release-tag-local-ci.*failed/);
  const missingTag = spawnSync("git", ["--git-dir", releaseRemote, "show-ref", "--verify", "--quiet", "refs/tags/v0.2.1"]);
  assert.notEqual(missingTag.status, 0, "blocked release tag unexpectedly reached the remote");
  pass("release tag hook gate", "local Hook passed before v0.2.0 push and blocked v0.2.1 before remote mutation");
}

function exerciseSubagentHooks(runtimeEnv, debugStateDir, workspaceId, workspaceRoot) {
  const seedScript = [
    'import { LocalAgentStore } from "./src/local-agent-store.js";',
    'const store = new LocalAgentStore(process.env.FORGERELAY_STATE_DIR);',
    'const record = store.create({',
    `  workspaceId: ${JSON.stringify(workspaceId)},`,
    `  workspaceRoot: ${JSON.stringify(workspaceRoot)},`,
    '  profileName: "debug-missing-profile",',
    '  provider: "codex",',
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
    'import { LocalAgentStore } from "./src/local-agent-store.js";',
    'const store = new LocalAgentStore(process.env.FORGERELAY_STATE_DIR);',
    `const record = store.get(${JSON.stringify(agentId)});`,
    'store.close();',
    'process.stdout.write(JSON.stringify({ status: record?.status, error: record?.error }));',
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
  assert.equal(record.status, "error");
  assert.match(record.error, /Subagent profile not found/);
  pass("subagent hook path", `${agentId} stopped in deterministic error path without calling a provider`);
}

function toolText(result) {
  return (result.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function readHookEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function assertDebugPortFree() {
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

function assertCurlAvailable() {
  const result = spawnSync("curl", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("npm run debug:accept requires curl on PATH.");
  }
}

function pass(label, detail) {
  console.log(`✓ ${label}: ${detail}`);
}
