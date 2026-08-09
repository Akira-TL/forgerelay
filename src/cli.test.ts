import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LocalAgentStore } from "./local-agent-store.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
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

  const hooksEnv = { ...process.env, FORGERELAY_CONFIG_DIR: configDir };
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

const root = mkdtempSync(join(tmpdir(), "devspace-cli-agents-test-"));
try {
  const configDir = join(root, ".devspace");
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
  const store = new LocalAgentStore(stateDir);
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
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_ALLOWED_ROOTS: projectRoot,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_WORKSPACE_ID: "ws_current",
      DEVSPACE_WORKSPACE_ROOT: projectRoot,
      DEVSPACE_SUBAGENTS: "1",
      DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    },
  });

  assert.match(output, new RegExp(`${current.id} idle reviewer codex gpt-5\\.4 thinking=high`));
  assert.doesNotMatch(output, /profile reviewer/);
  assert.doesNotMatch(output, new RegExp(other.id));

  assert.equal(loadConfig({
    DEVSPACE_CONFIG_DIR: configDir,
    DEVSPACE_ALLOWED_ROOTS: projectRoot,
    DEVSPACE_STATE_DIR: stateDir,
    DEVSPACE_SUBAGENTS: "1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  }).subagents, true);

  const workerStore = new LocalAgentStore(stateDir);
  const failing = workerStore.create({
    workspaceId: "ws_hooked",
    workspaceRoot: projectRoot,
    profileName: "missing-profile",
    provider: "codex",
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
        ...process.env,
        DEVSPACE_CONFIG_DIR: configDir,
        DEVSPACE_ALLOWED_ROOTS: projectRoot,
        DEVSPACE_STATE_DIR: stateDir,
        DEVSPACE_SUBAGENTS: "1",
        DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    },
  );

  assert.equal(
    readFileSync(join(projectRoot, "subagent-hooks.log"), "utf8").replace(/\r\n/g, "\n"),
    "SubagentStart:ws_hooked\nSubagentStop:ws_hooked\n",
  );
  const completedStore = new LocalAgentStore(stateDir);
  const failedRecord = completedStore.get(failing.id);
  completedStore.close();
  assert.equal(failedRecord?.status, "error");
  assert.match(failedRecord?.error ?? "", /Subagent profile not found: missing-profile/);
  assert.deepEqual(
    failedRecord?.hookReports?.map((report) => [report.event, report.name, report.status]),
    [
      ["SubagentStart", "Subagent started", "passed"],
      ["SubagentStop", "Subagent stopped", "passed"],
    ],
  );

  const shown = execFileSync(
    "node",
    ["--import", "tsx", "src/cli.ts", "agents", "show", failing.id],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEVSPACE_CONFIG_DIR: configDir,
        DEVSPACE_ALLOWED_ROOTS: projectRoot,
        DEVSPACE_STATE_DIR: stateDir,
        DEVSPACE_SUBAGENTS: "1",
        DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
      },
    },
  );
  assert.match(shown, /Hook results:/);
  assert.match(shown, /Subagent started \(SubagentStart, global\) passed/);
  assert.match(shown, /Subagent stopped \(SubagentStop, global\) passed/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
