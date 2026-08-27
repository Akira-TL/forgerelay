import assert from "node:assert/strict";
import test from "node:test";
import { formatPrettyLogEntry, workspaceLogLabel } from "./logger.js";

const timestamp = new Date(2026, 7, 9, 20, 41, 3).toISOString();

test("workspace log labels preserve the complete workspaceId", () => {
  assert.equal(
    workspaceLogLabel("/home/Akira/Projects/forgerelay", "ws_ec05370e20"),
    "forgerelay/ws_ec05370e20",
  );
  assert.equal(
    workspaceLogLabel("/tmp/example", "custom-workspace-id"),
    "example/custom-workspace-id",
  );
});

test("pretty tool logs emphasize workspace, operation, target, and result", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "info",
    event: "tool_call",
    workspace: "devspace/ws_a20bade4",
    session: "7f7ce1d1",
    tool: "bash",
    commandPreview: "git push origin v0.2.0",
    success: true,
    exitCode: 0,
    durationMs: 21,
  }, { colorize: false });

  assert.match(line, /^08-09 20:41:03 \[INFO\] devspace\/ws_a20bade4 \| /);
  assert.doesNotMatch(line, /session:/);
  assert.match(line, /bash git push origin v0\.2\.0 -> exit=0$/);
  assert.doesNotMatch(line, /durationMs|event=|success=/);
});

test("pretty file logs use ok or error rather than fake process exit codes", () => {
  const success = formatPrettyLogEntry({
    ts: timestamp,
    level: "info",
    event: "tool_call",
    workspace: "devspace/ws_a20bade4",
    session: "7f7ce1d1",
    tool: "write",
    path: "src/hooks.ts",
    success: true,
  }, { colorize: false });
  const failure = formatPrettyLogEntry({
    ts: timestamp,
    level: "warn",
    event: "tool_call",
    workspace: "devspace/ws_a20bade4",
    tool: "edit",
    path: "src/hooks.ts",
    success: false,
    error: "replacement text did not match",
  }, { colorize: false });

  assert.match(success, /\| write src\/hooks\.ts -> ok$/);
  assert.match(failure, /\| edit src\/hooks\.ts -> error: replacement text did not match$/);
  assert.doesNotMatch(`${success}\n${failure}`, /exit=[01]/);
});

test("pretty hook logs remain compact and preserve process exit status", () => {
  const success = formatPrettyLogEntry({
    ts: timestamp,
    level: "info",
    event: "hook_call",
    workspace: "devspace/ws_a20bade4",
    hookName: "release-tag-local-ci",
    hookEvent: "BeforeTool",
    success: true,
  }, { colorize: false });
  const failure = formatPrettyLogEntry({
    ts: timestamp,
    level: "warn",
    event: "hook_call",
    workspace: "devspace/ws_a20bade4",
    hookName: "release-tag-local-ci",
    hookEvent: "BeforeTool",
    success: false,
    error: "Hook release-tag-local-ci exited with code 13",
  }, { colorize: false });

  assert.match(success, /\| hook release-tag-local-ci BeforeTool -> exit=0$/);
  assert.match(failure, /\| hook release-tag-local-ci BeforeTool -> exit=13$/);
});

test("pretty transport logs have a concise fallback when explicitly enabled", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "info",
    event: "http_request",
    method: "GET",
    path: "/healthz",
    status: 200,
  }, { colorize: false });

  assert.match(line, /\| http GET \/healthz -> 200$/);
  assert.doesNotMatch(line, /userAgent|requestId/);
});

test("debug MCP logs retain transport session details without polluting info tool logs", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "debug",
    event: "mcp_request",
    transportSessionIdPrefix: "7f7ce1d1",
    rpcMethod: "tools/call",
    rpcTarget: "read",
    rpcMetaKeys: ["openai/session", "openai/turn"],
  }, { colorize: false });

  assert.match(line, /transport:7f7ce1d1 \| mcp tools\/call read meta=\[openai\/session,openai\/turn\]$/);
});

test("debug app template logs distinguish current and compatibility reads", () => {
  const current = formatPrettyLogEntry({
    ts: timestamp,
    level: "debug",
    event: "mcp_app_template_read",
    transportSessionIdPrefix: "7f7ce1d1",
    requestedUri: "ui://forgerelay/workspace-app-a1b2c3d4e5f6.html",
    currentUri: "ui://forgerelay/workspace-app-a1b2c3d4e5f6.html",
    compatibility: "current",
  }, { colorize: false });
  assert.match(current, /transport:7f7ce1d1 \| app template current .* -> ok$/);

  const legacy = formatPrettyLogEntry({
    ts: timestamp,
    level: "debug",
    event: "mcp_app_template_read",
    requestedUri: "ui://forgerelay/workspace-app.html",
    currentUri: "ui://forgerelay/workspace-app-a1b2c3d4e5f6.html",
    compatibility: "legacy",
  }, { colorize: false });
  assert.match(legacy, /app template legacy .*workspace-app\.html => .*a1b2c3d4e5f6\.html -> ok$/);
});

test("failed app template reads stay visible as warnings", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "warn",
    event: "mcp_app_template_read_failed",
    requestedUri: "ui://forgerelay/workspace-app-old.html",
    compatibility: "historical",
    error: "Missing UI manifest",
  }, { colorize: false });

  assert.match(line, /app template historical .* -> error: Missing UI manifest$/);
});

test("pretty shutdown logs summarize closed MCP transport sessions", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "debug",
    event: "mcp_transport_sessions_closed",
    reason: "server_shutdown",
    count: 4,
  }, { colorize: false });

  assert.match(line, /\| 4 transport sessions closed$/);
  assert.doesNotMatch(line, /sessionIdPrefix/);
});

test("pretty workspace sources color project names while keeping workspace ids visible", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "info",
    event: "tool_call",
    workspace: "contextd/ws_86312a3b",
    tool: "read",
    path: "src/server.ts",
    success: true,
  }, { colorize: true, validateStream: false });

  assert.match(line, /contextd/);
  assert.match(line, /ws_86312a3b/);
  assert.match(line, /\u001b\[/);
});

test("pretty logs can emit ANSI styles without a third-party logger", () => {
  const line = formatPrettyLogEntry({
    ts: timestamp,
    level: "warn",
    event: "tool_call",
    workspace: "devspace/ws_a20bade4",
    tool: "edit",
    path: "src/hooks.ts",
    success: false,
  }, { colorize: true, validateStream: false });

  assert.match(line, /\u001b\[/);
});
