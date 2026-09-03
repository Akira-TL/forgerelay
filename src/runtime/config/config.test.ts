import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { forgerelayConfigDir, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "forgerelay-empty-config-test-"));
const baseEnv = {
  FORGERELAY_CONFIG_DIR: emptyConfigDir,
  FORGERELAY_ALLOWED_ROOTS: process.cwd(),
  FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig(baseEnv).activityPanelExpanded, false);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_ACTIVITY_PANEL_EXPANDED: "1" }).activityPanelExpanded, true);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).systemInstructionsPath, join(homedir(), ".agents", "AGENTS.md"));
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_SYSTEM_INSTRUCTIONS_PATH: "~/custom-system.md" })
    .systemInstructionsPath,
  join(homedir(), "custom-system.md"),
);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_MINIMAL_TOOLS: "1" }).toolMode, "minimal");

const forgeRelayConfigDir = mkdtempSync(join(tmpdir(), "forgerelay-config-test-"));
writeFileSync(
  join(forgeRelayConfigDir, "hooks.json"),
  JSON.stringify({
    BeforeTool: [
      {
        matcher: { tool: "bash" },
        handlers: [{ name: "Global hooks file", command: "echo global" }],
      },
    ],
  }),
);
mkdirSync(join(forgeRelayConfigDir, "hooks"));
writeFileSync(
  join(forgeRelayConfigDir, "hooks", "20-package-inspection.json"),
  JSON.stringify({
    event: "BeforeTool",
    matcher: { tool: "bash" },
    command: "npm pack --dry-run",
    report: false,
  }),
);
writeFileSync(
  join(forgeRelayConfigDir, "hooks", "10-release-verify.json"),
  JSON.stringify({
    event: "BeforeTool",
    matcher: { tool: "bash" },
    command: "npm run release:verify",
    timeoutSeconds: 300,
  }),
);
writeFileSync(
  join(forgeRelayConfigDir, "config.json"),
  JSON.stringify({
    activityPanelExpanded: true,
    hooks: {
      BeforeTool: [{ name: "Legacy inline hook", command: "echo inline" }],
    },
  }),
);
const forgeRelayConfig = loadConfig({
  ...baseEnv,
  FORGERELAY_CONFIG_DIR: forgeRelayConfigDir,
  FORGERELAY_WIDGETS: "changes",
  FORGERELAY_TOOL_MODE: "full",
  FORGERELAY_SUBAGENTS: "1",
});
assert.equal(forgeRelayConfig.widgets, "changes");
assert.equal(forgeRelayConfig.activityPanelExpanded, true);
assert.equal(loadConfig({
  ...baseEnv,
  FORGERELAY_CONFIG_DIR: forgeRelayConfigDir,
  FORGERELAY_ACTIVITY_PANEL_EXPANDED: "0",
}).activityPanelExpanded, false);
assert.equal(forgeRelayConfig.toolMode, "full");
assert.equal(forgeRelayConfig.subagents, true);
assert.deepEqual(
  forgeRelayConfig.hooks.BeforeTool?.flatMap((rule) => rule.handlers.map((handler) => handler.name)),
  ["Legacy inline hook", "Global hooks file", "10-release-verify", "20-package-inspection"],
);
assert.equal(forgeRelayConfig.configSkillsDir, join(forgeRelayConfigDir, "skills"));
assert.equal(forgeRelayConfig.configAgentsDir, join(forgeRelayConfigDir, "agents"));
assert.equal(resolveSubagentsFlag({}, { FORGERELAY_SUBAGENTS: "1" }), true);
assert.equal(loadConfig(baseEnv).workflowInstructions, undefined);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_WORKFLOW_INSTRUCTIONS: "Use repository-defined Git workflows." })
    .workflowInstructions,
  "Use repository-defined Git workflows.",
);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_WORKFLOW_INSTRUCTIONS: "" }).workflowInstructions,
  false,
);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_APPEND_INSTRUCTIONS: "Keep command output concise." })
    .appendInstructions,
  "Keep command output concise.",
);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).configSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).configAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig(baseEnv).artifactsEnabled, false);
assert.equal(loadConfig(baseEnv).artifactMaxFileBytes, 100 * 1024 * 1024);
assert.equal(loadConfig(baseEnv).taskReminderInterval, 30);
assert.equal(loadConfig(baseEnv).stateDir, join(homedir(), ".local", "share", "forgerelay"));
assert.equal(loadConfig(baseEnv).worktreeRoot, join(homedir(), ".forgerelay", "worktrees"));
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TASK_REMINDER_INTERVAL: "0" }).taskReminderInterval, 0);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TASK_REMINDER_INTERVAL: "45" }).taskReminderInterval, 45);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_ARTIFACTS: "1" }).artifactsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_ARTIFACT_MAX_FILE_BYTES: "123" }).artifactMaxFileBytes,
  123,
);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { FORGERELAY_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { FORGERELAY_SUBAGENTS: "1" }), true);

assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "invalid" }),
  /Invalid FORGERELAY_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_TASK_REMINDER_INTERVAL: "-1" }),
  /Invalid FORGERELAY_TASK_REMINDER_INTERVAL: -1/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_TASK_REMINDER_INTERVAL: "1.5" }),
  /Invalid FORGERELAY_TASK_REMINDER_INTERVAL: 1.5/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "minimal" }),
  /Invalid FORGERELAY_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_WIDGETS: "write-only" }),
  /Invalid FORGERELAY_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_TOOL_MODE: "invalid" }),
  /Invalid FORGERELAY_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_SYSTEM_INSTRUCTIONS_PATH: "" }),
  /FORGERELAY_SYSTEM_INSTRUCTIONS_PATH must be one non-empty path/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "pretty",
  requests: false,
  assets: false,
  toolCalls: true,
  shellCommands: true,
  trustProxy: false,
});

assert.deepEqual(loadConfig({ ...baseEnv, FORGERELAY_LOG_FORMAT: "json" }).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, FORGERELAY_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_LOG_LEVEL: "trace" }),
  /Invalid FORGERELAY_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_LOG_FORMAT: "color" }),
  /Invalid FORGERELAY_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["forgerelay"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, FORGERELAY_OAUTH_SCOPES: "forgerelay,admin" }).oauth.scopes,
  ["forgerelay", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ FORGERELAY_CONFIG_DIR: emptyConfigDir, FORGERELAY_ALLOWED_ROOTS: process.cwd() }),
  /FORGERELAY_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_OAUTH_OWNER_TOKEN: "too-short" }),
  /FORGERELAY_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_ARTIFACT_MAX_FILE_BYTES: "0" }),
  /Invalid FORGERELAY_ARTIFACT_MAX_FILE_BYTES: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).publicBaseUrls, ["http://127.0.0.1:7676"]);
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

const routedPublic = loadConfig({
  ...baseEnv,
  FORGERELAY_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/forgerelay/debug/",
});
assert.equal(routedPublic.publicBaseUrl, "https://abc.trycloudflare.com/forgerelay/debug");
assert.deepEqual(routedPublic.publicBaseUrls, ["https://abc.trycloudflare.com/forgerelay/debug"]);
assert.deepEqual(
  routedPublic.allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);

const multiplePublic = loadConfig({
  ...baseEnv,
  FORGERELAY_PUBLIC_BASE_URL:
    "https://primary.example.com/forgerelay/debug, https://alias.example.com/relay, https://primary.example.com/forgerelay/debug/",
});
assert.equal(multiplePublic.publicBaseUrl, "https://primary.example.com/forgerelay/debug");
assert.deepEqual(multiplePublic.publicBaseUrls, [
  "https://primary.example.com/forgerelay/debug",
  "https://alias.example.com/relay",
]);
assert.deepEqual(multiplePublic.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "primary.example.com",
  "alias.example.com",
]);
assert.throws(
  () => loadConfig({ ...baseEnv, FORGERELAY_PUBLIC_BASE_URL: "" }),
  /PUBLIC_BASE_URL must contain at least one public base URL/,
);
assert.equal(
  loadConfig({ ...baseEnv, FORGERELAY_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).logging.trustProxy,
  true,
);
assert.equal(
  loadConfig({
    ...baseEnv,
    FORGERELAY_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/",
    FORGERELAY_TRUST_PROXY: "0",
  }).logging.trustProxy,
  false,
);
assert.equal(
  loadConfig({
    ...baseEnv,
    HOST: "0.0.0.0",
    FORGERELAY_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/",
  }).logging.trustProxy,
  false,
);
assert.deepEqual(
  loadConfig({ ...baseEnv, FORGERELAY_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "forgerelay-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: [
      "https://forgerelay.example.com/forgerelay/main",
      "https://forgerelay-alt.example.com/alternate",
    ],
    subagents: true,
    allowAgentLanguageServerInstall: true,
    artifactsEnabled: true,
    artifactMaxFileBytes: 321,
    taskReminderInterval: 12,
    workflowInstructions: false,
    appendInstructions: "Follow repository workflow instructions.",
    systemInstructionsPath: "~/configured-system.md",
    hooks: {
      WorkspaceOpen: [{ command: "echo opened" }],
      BeforeWorktreeClose: [{ command: "npm test", timeoutSeconds: 45 }],
    },
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ FORGERELAY_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://forgerelay.example.com/forgerelay/main");
assert.deepEqual(fileConfig.publicBaseUrls, [
  "https://forgerelay.example.com/forgerelay/main",
  "https://forgerelay-alt.example.com/alternate",
]);
assert.equal(fileConfig.subagents, true);
assert.equal(fileConfig.allowAgentLanguageServerInstall, true);
assert.equal(fileConfig.artifactsEnabled, true);
assert.equal(fileConfig.artifactMaxFileBytes, 321);
assert.equal(fileConfig.taskReminderInterval, 12);
assert.equal(fileConfig.workflowInstructions, false);
assert.equal(fileConfig.appendInstructions, "Follow repository workflow instructions.");
assert.equal(fileConfig.systemInstructionsPath, join(homedir(), "configured-system.md"));
assert.deepEqual(fileConfig.hooks, {
  WorkspaceOpen: [{
    handlers: [{
      name: undefined,
      command: "echo opened",
      timeoutSeconds: 30,
      report: true,
    }],
  }],
  BeforeWorktreeClose: [{
    handlers: [{
      name: undefined,
      command: "npm test",
      timeoutSeconds: 45,
      report: true,
    }],
  }],
});
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "forgerelay.example.com",
  "forgerelay-alt.example.com",
]);

const invalidHooksConfigDir = mkdtempSync(join(tmpdir(), "forgerelay-invalid-hooks-test-"));
writeFileSync(
  join(invalidHooksConfigDir, "config.json"),
  JSON.stringify({ hooks: { UnknownEvent: [{ command: "echo nope" }] } }),
);
writeFileSync(
  join(invalidHooksConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);
assert.throws(
  () => loadConfig({ FORGERELAY_CONFIG_DIR: invalidHooksConfigDir }),
  /Unknown ForgeRelay hook event: UnknownEvent/,
);

writeFileSync(
  join(invalidHooksConfigDir, "config.json"),
  JSON.stringify({ hooks: { BeforeTool: [{ command: "   " }] } }),
);
assert.throws(
  () => loadConfig({ FORGERELAY_CONFIG_DIR: invalidHooksConfigDir }),
  /Hook BeforeTool command must be a non-empty string/,
);

writeFileSync(
  join(invalidHooksConfigDir, "config.json"),
  JSON.stringify({ hooks: { BeforeTool: [{ command: "echo ok", timeoutSeconds: 0 }] } }),
);
assert.throws(
  () => loadConfig({ FORGERELAY_CONFIG_DIR: invalidHooksConfigDir }),
  /Hook BeforeTool timeoutSeconds must be an integer between 1 and 300/,
);
