import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../runtime/config/config.js";
import {
  classifyClientFacingBaseUrl,
  hasInsecureLanBaseUrl,
  setupBindAddress,
  validateBindAddress,
  validateClientFacingBaseUrls,
  validateHttpsProxyBaseUrls,
  validateLanClientFacingBaseUrls,
} from "./setup-support.js";
import { SubagentSessionStore } from "../subagents/sessions/store.js";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.startsWith("FORGERELAY_")
  ),
) as NodeJS.ProcessEnv;

assert.equal(classifyClientFacingBaseUrl("https://forge.example.com"), "secure");
assert.equal(classifyClientFacingBaseUrl("http://192.168.1.20:7676"), "insecure-lan");
assert.equal(classifyClientFacingBaseUrl("http://S256C:7676"), "insecure-lan");
assert.equal(classifyClientFacingBaseUrl("http://relay.home.arpa:7676"), "insecure-lan");
assert.throws(() => classifyClientFacingBaseUrl("http://forge.example.com"), /Use HTTPS for public addresses/);
assert.throws(() => classifyClientFacingBaseUrl("ftp://192.168.1.20"), /http:\/\/ or https:\/\//);
assert.equal(validateClientFacingBaseUrls("http://10.0.0.8:7676,https://forge.example.com"), undefined);
assert.match(validateClientFacingBaseUrls("http://203.0.113.8:7676") ?? "", /Use HTTPS/);
assert.equal(hasInsecureLanBaseUrl(["https://forge.example.com"]), false);
assert.equal(hasInsecureLanBaseUrl(["http://10.0.0.8:7676"]), true);
assert.equal(validateBindAddress("0.0.0.0"), undefined);
assert.equal(validateBindAddress("127.0.0.1"), undefined);
assert.match(validateBindAddress("http://0.0.0.0") ?? "", /not a URL/);
assert.equal(setupBindAddress("local"), "127.0.0.1");
assert.equal(setupBindAddress("ssh"), "127.0.0.1");
assert.equal(setupBindAddress("proxy"), "127.0.0.1");
assert.equal(setupBindAddress("lan"), "0.0.0.0");
assert.equal(validateLanClientFacingBaseUrls("http://192.168.1.20:7676"), undefined);
assert.match(validateLanClientFacingBaseUrls("https://forge.example.com") ?? "", /Direct LAN/);
assert.equal(validateHttpsProxyBaseUrls("https://forge.example.com/forgerelay/debug"), undefined);
assert.match(validateHttpsProxyBaseUrls("http://192.168.1.20:7676") ?? "", /HTTPS/);

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const helpOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", "help"], {
  encoding: "utf8",
  env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-help-test" },
});
assert.match(helpOutput, /forgerelay serve --allow-elevated/);
assert.match(helpOutput, /Explicitly allow this invocation/);

const invalidServeOption = spawnSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "serve", "--definitely-not-a-serve-option"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-invalid-serve-option-test" },
  },
);
assert.equal(invalidServeOption.status, 1);
assert.match(invalidServeOption.stderr, /Unknown serve option: --definitely-not-a-serve-option/);

const doctorRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-doctor-test-"));
try {
  const configDir = join(doctorRoot, ".forgerelay");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 7676,
      allowedRoots: [doctorRoot],
      publicBaseUrl: [
        "https://forge.example.com/base/path",
        "https://forge-alt.example.com/alternate/path",
      ],
      subagents: true,
      artifactsEnabled: true,
      allowAgentLanguageServerInstall: true,
    }),
  );

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      FORGERELAY_TOOL_MODE: "minimal",
      FORGERELAY_WIDGETS: "changes",
      FORGERELAY_SKILLS: "0",
    },
  });

  assert.match(output, /Bind MCP URL: http:\/\/127\.0\.0\.1:7676\/base\/path\/mcp/);
  assert.match(
    output,
    /Client-facing base URLs: https:\/\/forge\.example\.com\/base\/path, https:\/\/forge-alt\.example\.com\/alternate\/path/,
  );
  assert.match(output, /Client-facing base URL: https:\/\/forge\.example\.com\/base\/path/);
  assert.match(output, /Client-facing MCP URL: https:\/\/forge\.example\.com\/base\/path\/mcp/);
  assert.match(output, /Runtime privilege: (standard|elevated|unknown)/);
  assert.match(output, /Command shell: (bash|cmd|zsh|sh|fish|pwsh|powershell)/);
  assert.match(output, /Tool mode: minimal/);
  assert.match(output, /Widgets: changes/);
  assert.match(output, /Trust proxy: loopback/);
  assert.match(output, /Artifacts: enabled/);
  assert.match(output, /Subagents: enabled/);
  assert.match(output, /Agent-managed Language Server install: enabled/);
  assert.match(output, /Skills: disabled/);
} finally {
  rmSync(doctorRoot, { recursive: true, force: true });
}

const publicConfigRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-public-config-test-"));
try {
  const configDir = join(publicConfigRoot, ".forgerelay");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ publicBaseUrl: "https://legacy.example.com/old-route" }),
  );
  const env = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir };

  execFileSync(
    "node",
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "config",
      "set",
      "publicBaseUrl",
      "https://primary.example.com/forgerelay/debug,https://alias.example.com/relay",
    ],
    { cwd: process.cwd(), encoding: "utf8", env },
  );

  const multiple = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(multiple.publicBaseUrl, [
    "https://primary.example.com/forgerelay/debug",
    "https://alias.example.com/relay",
  ]);
  const resolved = loadConfig({
    ...env,
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  assert.equal(resolved.publicBaseUrl, "https://primary.example.com/forgerelay/debug");
  assert.deepEqual(resolved.publicBaseUrls, [
    "https://primary.example.com/forgerelay/debug",
    "https://alias.example.com/relay",
  ]);
  assert.deepEqual(resolved.allowedHosts, [
    "localhost",
    "127.0.0.1",
    "::1",
    "primary.example.com",
    "alias.example.com",
  ]);

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "set", "publicBaseUrl", "https://legacy.example.com/new-route"],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
  const single = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(single.publicBaseUrl, "https://legacy.example.com/new-route");
} finally {
  rmSync(publicConfigRoot, { recursive: true, force: true });
}

const hooksRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-hooks-test-"));
try {
  const configDir = join(hooksRoot, ".forgerelay");
  const globalHooksDir = join(configDir, "hooks");
  const projectRoot = join(hooksRoot, "project");
  const projectHooksDir = join(projectRoot, ".forgerelay", "hooks");
  mkdirSync(globalHooksDir, { recursive: true });
  mkdirSync(projectHooksDir, { recursive: true });
  writeFileSync(
    join(globalHooksDir, "10-global-release.json"),
    JSON.stringify({
      event: "BeforeTool",
      matcher: { tool: "bash", commandRegex: "^git push" },
      command: "npm run release:verify",
      timeoutSeconds: 300,
      report: true,
    }),
  );
  writeFileSync(
    join(projectHooksDir, "20-project-tests.json"),
    JSON.stringify({
      event: "BeforeWorktreeClose",
      command: "npm test",
      report: false,
    }),
  );

  const hooksEnv = { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir };
  const listed = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "hooks", "list", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: hooksEnv },
  );
  assert.match(
    listed,
    /global 10-global-release BeforeTool .*timeout=300s report=true .*npm run release:verify/,
  );
  assert.match(
    listed,
    /project 20-project-tests BeforeWorktreeClose .*timeout=30s report=false .*npm test/,
  );

  const checked = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "hooks", "check", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: hooksEnv },
  );
  assert.match(checked, /Hooks OK: 1 global, 1 project/);

  writeFileSync(join(projectHooksDir, "30-broken.json"), "{ invalid json\n");
  const invalid = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "hooks", "check", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: hooksEnv },
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /30-broken\.json/);

  rmSync(join(projectHooksDir, "30-broken.json"));
  writeFileSync(join(globalHooksDir, "30-broken-global.json"), "{ invalid json\n");
  const invalidGlobal = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "hooks", "check", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: hooksEnv },
  );
  assert.equal(invalidGlobal.status, 1);
  assert.match(invalidGlobal.stderr, /30-broken-global\.json/);
} finally {
  rmSync(hooksRoot, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), "forgerelay-cli-agents-test-"));
try {
  const configDir = join(root, ".forgerelay");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const subagentHookCommand = `node -e "require('node:fs').appendFileSync('subagent-hooks.log', process.env.FORGERELAY_HOOK_EVENT + ':' + process.env.FORGERELAY_WORKSPACE_ID + '\\n')"`;
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      hooks: {
        SubagentStart: [{ name: "Subagent started", command: subagentHookCommand }],
        SubagentStop: [{ name: "Subagent stopped", command: subagentHookCommand }],
      },
    }),
  );
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Read-only reviewer.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review only.",
      "",
    ].join("\n"),
  );
  const store = new SubagentSessionStore(stateDir);
  const current = store.update(
    store.create({
      workspaceId: "ws_current",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
      model: "gpt-5.4",
      thinking: "high",
    }).id,
    { status: "idle" },
  );
  const other = store.update(
    store.create({
      workspaceId: "ws_other",
      workspaceRoot: projectRoot,
      profileName: "reviewer",
      provider: "codex",
    }).id,
    { status: "running" },
  );
  store.close();

  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "agents", "ls"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...cleanProductEnv,
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_ALLOWED_ROOTS: projectRoot,
      FORGERELAY_STATE_DIR: stateDir,
      FORGERELAY_WORKSPACE_ID: "ws_current",
      FORGERELAY_WORKSPACE_ROOT: projectRoot,
      FORGERELAY_SUBAGENTS: "1",
      FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: projectRoot,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);

  const workerStore = new SubagentSessionStore(stateDir);
  const failing = workerStore.create({
    workspaceId: "ws_hooked",
    workspaceRoot: projectRoot,
    profileName: "missing-profile",
    provider: "codex",
    activeRun: {
      id: "run_hookfailure",
      startedAt: new Date().toISOString(),
    },
  });
  workerStore.close();
  const promptFile = join(root, "worker-prompt.txt");
  writeFileSync(promptFile, "secret worker prompt that hooks must not receive\n");

  execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "agents", "__worker", failing.id, "--prompt-file", promptFile],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_ALLOWED_ROOTS: projectRoot,
        FORGERELAY_STATE_DIR: stateDir,
        FORGERELAY_SUBAGENTS: "1",
        FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    },
  );
  assert.equal(existsSync(promptFile), false);

  assert.equal(
    readFileSync(join(projectRoot, "subagent-hooks.log"), "utf8").replace(/\r\n/g, "\n"),
    "SubagentStart:ws_hooked\nSubagentStop:ws_hooked\n",
  );
  const completedStore = new SubagentSessionStore(stateDir);
  const failedRecord = completedStore.get(failing.id);
  completedStore.close();
  assert.equal(failedRecord?.status, "idle");
  assert.equal(failedRecord?.latestRun?.id, "run_hookfailure");
  assert.equal(failedRecord?.latestRun?.status, "failed");

  const shown = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "agents", "show", failing.id],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_ALLOWED_ROOTS: projectRoot,
        FORGERELAY_STATE_DIR: stateDir,
        FORGERELAY_SUBAGENTS: "1",
        FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    },
  );
  assert.match(shown, /Subagent profile not found: missing-profile/);
  assert.doesNotMatch(shown, /Hook results:/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
