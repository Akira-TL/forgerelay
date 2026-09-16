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

function availableLoopbackPort(): number {
  return Number(execFileSync(
    "node",
    [
      "-e",
      "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});",
    ],
    { encoding: "utf8" },
  ).trim());
}

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

for (const flag of ["version", "-v", "--version"]) {
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
assert.match(helpOutput, /forgerelay serve --host <host>/);
assert.match(helpOutput, /forgerelay serve --port <port>/);
assert.match(helpOutput, /forgerelay serve --root <path>/);
assert.match(helpOutput, /forgerelay serve --public-url <url>/);
assert.match(helpOutput, /Explicitly allow this invocation/);
for (const flag of ["-h", "--help"]) {
  const aliasHelpOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-help-alias-test" },
  });
  assert.equal(aliasHelpOutput, helpOutput);
}
for (const command of ["serve", "init", "config", "connect", "system", "help", "version"]) {
  assert.match(helpOutput, new RegExp(`^  forgerelay ${command}\\b`, "m"));
}
for (const legacyCommand of ["start", "doctor", "hooks", "agents", "auth", "mcp", "maintenance"]) {
  assert.doesNotMatch(helpOutput, new RegExp(`^  forgerelay ${legacyCommand}\\b`, "m"));
}

const bareRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-bare-help-test-"));
try {
  const configDir = join(bareRoot, ".forgerelay");
  const bare = spawnSync("node", ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: configDir },
  });
  assert.equal(bare.status, 0);
  assert.equal(bare.stderr, "");
  assert.match(bare.stdout, /^ForgeRelay\n/m);
  assert.match(bare.stdout, /forgerelay serve/);
  assert.equal(existsSync(configDir), false);
} finally {
  rmSync(bareRoot, { recursive: true, force: true });
}

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

const duplicateServePort = spawnSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "serve", "--port", "7781", "--port", "7782"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-duplicate-serve-port-test" },
  },
);
assert.equal(duplicateServePort.status, 1);
assert.match(duplicateServePort.stderr, /--port may only be supplied once/);

for (const [args, expected] of [
  [["--host", "127.0.0.1", "--host", "localhost"], /--host may only be supplied once/],
  [["--host", "http://127.0.0.1"], /Invalid --host: .*not a URL/],
  [["--port", "0"], /Invalid --port: Enter a port between/],
  [["--public-url", "http://203.0.113.8:7788"], /Invalid --public-url: Plain HTTP is allowed only/],
  [["--root"], /Missing value for --root/],
] as const) {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "serve", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-invalid-serve-value-test" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, expected);
}

const serveOverrideRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-serve-overrides-test-"));
try {
  const configDir = join(serveOverrideRoot, ".forgerelay");
  const stateDir = join(serveOverrideRoot, ".state");
  const persistedRoot = join(serveOverrideRoot, "persisted-root");
  const environmentRoot = join(serveOverrideRoot, "environment-root");
  const cliRootA = join(serveOverrideRoot, "cli-root-a");
  const cliRootB = join(serveOverrideRoot, "cli-root-b");
  for (const directory of [configDir, stateDir, persistedRoot, environmentRoot, cliRootA, cliRootB]) {
    mkdirSync(directory, { recursive: true });
  }
  const configPath = join(configDir, "config.json");
  const authPath = join(configDir, "auth.json");
  const persistedPort = availableLoopbackPort();
  const environmentPort = availableLoopbackPort();
  const cliPort = availableLoopbackPort();
  const persistedConfig = JSON.stringify({
    host: "localhost",
    port: persistedPort,
    allowedRoots: [persistedRoot],
    publicBaseUrl: "https://persisted.example.com/base",
    stateDir,
  }, null, 2) + "\n";
  const persistedAuth = JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
    instanceId: "fr_cli_override_test",
  }, null, 2) + "\n";
  writeFileSync(configPath, persistedConfig);
  writeFileSync(authPath, persistedAuth);

  const result = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(cliPort),
      "--root",
      cliRootA,
      "--root",
      cliRootB,
      "--public-url",
      "https://cli-one.example.com/relay/",
      "--public-url",
      "https://cli-two.example.com/alternate/",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2_500,
      killSignal: "SIGTERM",
      env: {
        ...cleanProductEnv,
        FORGERELAY_CONFIG_DIR: configDir,
        FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
        HOST: "0.0.0.0",
        PORT: String(environmentPort),
        FORGERELAY_ALLOWED_ROOTS: environmentRoot,
        FORGERELAY_PUBLIC_BASE_URL: "https://environment.example.com/base",
      },
    },
  );

  assert.match(result.stdout, new RegExp(`forgerelay listening on http://127\\.0\\.0\\.1:${cliPort}/relay/mcp`));
  assert.match(result.stdout, /client-facing base url: https:\/\/cli-one\.example\.com\/relay/);
  assert.ok(result.stdout.includes(`allowed roots: ${cliRootA}, ${cliRootB}`));
  assert.match(result.stdout, /allowed hosts: .*cli-one\.example\.com.*cli-two\.example\.com/);
  assert.doesNotMatch(result.stdout, /persisted\.example\.com|environment\.example\.com/);
  assert.equal(readFileSync(configPath, "utf8"), persistedConfig);
  assert.equal(readFileSync(authPath, "utf8"), persistedAuth);
} finally {
  rmSync(serveOverrideRoot, { recursive: true, force: true });
}

const legacyStartOption = spawnSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "start", "--definitely-not-a-serve-option"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-legacy-start-test" },
  },
);
assert.equal(legacyStartOption.status, 1);
assert.match(legacyStartOption.stderr, /Unknown serve option: --definitely-not-a-serve-option/);

const unknownCommand = spawnSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "definitely-not-a-command"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...cleanProductEnv, FORGERELAY_CONFIG_DIR: "/tmp/forgerelay-cli-unknown-command-test" },
  },
);
assert.equal(unknownCommand.status, 1);
assert.match(unknownCommand.stderr, /Unknown command: definitely-not-a-command/);

const compatibilityRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-compatibility-test-"));
try {
  const configDir = join(compatibilityRoot, ".forgerelay");
  const stateDir = join(compatibilityRoot, ".state");
  const compatibilityEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_STATE_DIR: stateDir,
  };

  const legacyRelayList = execFileSync("node", ["--import", "tsx", "src/cli.ts", "auth", "list"], {
    cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv,
  });
  const canonicalRelayList = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "connect", "relay", "list"],
    { cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv },
  );
  assert.equal(canonicalRelayList, legacyRelayList);

  const legacyMcpHelp = execFileSync("node", ["--import", "tsx", "src/cli.ts", "mcp", "--help"], {
    cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv,
  });
  const canonicalMcpHelp = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "connect", "mcp", "--help"],
    { cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv },
  );
  assert.equal(canonicalMcpHelp, legacyMcpHelp);

  const legacyMaintenance = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "maintenance", "inspect", "--json"],
    { cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv },
  );
  const canonicalMaintenance = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "system", "inspect", "--json"],
    { cwd: process.cwd(), encoding: "utf8", env: compatibilityEnv },
  );
  assert.equal(canonicalMaintenance, legacyMaintenance);
} finally {
  rmSync(compatibilityRoot, { recursive: true, force: true });
}

const doctorRoot = mkdtempSync(join(tmpdir(), "forgerelay-cli-doctor-test-"));
const doctorShell = process.platform === "win32"
  ? {
      family: "cmd" as const,
      executable: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
      compatibility: "native supported runtime",
    }
  : {
      family: "sh" as const,
      executable: "/bin/sh",
      compatibility: "POSIX sh is supported as an explicit command runtime",
    };
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
      commandShell: {
        mode: "pinned",
        family: doctorShell.family,
        executable: doctorShell.executable,
      },
      shellInstructions: false,
    }),
  );

  const doctorEnv = {
    ...cleanProductEnv,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    FORGERELAY_TOOL_MODE: "minimal",
    FORGERELAY_WIDGETS: "changes",
    FORGERELAY_SKILLS: "0",
  };
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: doctorEnv,
  });
  const canonicalOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", "system", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: doctorEnv,
  });
  assert.equal(canonicalOutput, output);

  assert.match(output, /Bind MCP URL: http:\/\/127\.0\.0\.1:7676\/base\/path\/mcp/);
  assert.match(
    output,
    /Client-facing base URLs: https:\/\/forge\.example\.com\/base\/path, https:\/\/forge-alt\.example\.com\/alternate\/path/,
  );
  assert.match(output, /Client-facing base URL: https:\/\/forge\.example\.com\/base\/path/);
  assert.match(output, /Client-facing MCP URL: https:\/\/forge\.example\.com\/base\/path\/mcp/);
  assert.match(output, /Runtime privilege: (standard|elevated|unknown)/);
  assert.match(output, new RegExp(`Command shell: ${doctorShell.family} \\(`));
  assert.ok(output.includes(`Command shell executable: ${doctorShell.executable}`));
  assert.match(output, /Command shell source: explicit/);
  assert.ok(output.includes(`Command shell compatibility: ${doctorShell.compatibility}`));
  if (doctorShell.family === "cmd") {
    assert.match(output, /Shell Instructions: disabled \(.+instructions\\cmd\.md; unavailable\)/);
  } else {
    assert.match(output, /Shell Instructions: disabled \(not applicable\)/);
  }
  assert.doesNotMatch(output, /Bash shell:/);
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
      "--global",
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
    ["--import", "tsx", "src/cli.ts", "config", "set", "publicBaseUrl", "https://legacy.example.com/new-route", "--global"],
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

  const canonicalListed = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "config", "hooks", "list", "--project", projectRoot],
    { cwd: process.cwd(), encoding: "utf8", env: hooksEnv },
  );
  assert.equal(canonicalListed, listed);

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
  mkdirSync(join(configDir, "subagents"), { recursive: true });
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
    join(configDir, "subagents", "reviewer.md"),
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
        CODEX_COMMAND: join(root, "missing-codex"),
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
  assert.match(shown, /ENOENT/);
  assert.doesNotMatch(shown, /Subagent profile not found/);
  assert.doesNotMatch(shown, /Hook results:/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
