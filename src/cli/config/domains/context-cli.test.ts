import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = join(process.cwd(), "src", "cli.ts");
const cleanProductEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
) as NodeJS.ProcessEnv;

function runCli(configDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: process.cwd(),
    env: { ...cleanProductEnv, ...extraEnv, FORGERELAY_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

test("config context get reads built-in defaults without persisting redundant config", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-defaults-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const result = runCli(configDir, ["config", "context", "get", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      systemInstructionsPath: "~/.agents/AGENTS.md",
      instructionNames: ["AGENTS.md"],
      skillPaths: ["~/.agents/skills", "./.agents/skills"],
    });
    assert.equal(existsSync(join(configDir, "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context get reports only effective Agent context sources", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-get-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectRoot, ".forgerelay"), { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    systemInstructionsPath: "~/.user/AGENTS.md",
    instructionNames: ["USER.md"],
    skillPaths: ["~/.user/skills"],
    host: "127.0.0.1",
  }) + "\n");
  writeFileSync(join(projectRoot, ".forgerelay", "config.json"), JSON.stringify({
    systemInstructionsPath: "./PROJECT.md",
    instructionNames: ["PROJECT.md"],
    skillPaths: ["./.project-skills"],
  }) + "\n");
  try {
    const result = runCli(configDir, ["config", "context", "get", "--project", projectRoot]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      systemInstructionsPath: "./PROJECT.md",
      instructionNames: ["PROJECT.md"],
      skillPaths: ["./.project-skills"],
    });
    assert.doesNotMatch(result.stdout, /host/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context set defaults to project shared storage and unset falls back without synthetic defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-project-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ skillPaths: ["~/.user/skills"] }) + "\n");
  const env = { FORGERELAY_WORKSPACE_ROOT: projectRoot };
  try {
    const set = runCli(configDir, [
      "config", "context", "set", "skillPaths", JSON.stringify(["./.custom-skills"]),
    ], env);
    assert.equal(set.status, 0, set.stderr || set.stdout);
    const projectConfigPath = join(projectRoot, ".forgerelay", "config.json");
    assert.deepEqual(JSON.parse(readFileSync(projectConfigPath, "utf8")), {
      skillPaths: ["./.custom-skills"],
    });
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")), {
      skillPaths: ["~/.user/skills"],
    });

    const unset = runCli(configDir, ["config", "context", "unset", "skillPaths"], env);
    assert.equal(unset.status, 0, unset.stderr || unset.stdout);
    assert.deepEqual(JSON.parse(readFileSync(projectConfigPath, "utf8")), {});

    const get = runCli(configDir, ["config", "context", "get"], env);
    assert.equal(get.status, 0, get.stderr || get.stdout);
    assert.deepEqual(JSON.parse(get.stdout).skillPaths, ["~/.user/skills"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context explicit --project writes use the selected project shared config", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-explicit-project-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  try {
    const set = runCli(configDir, [
      "config", "context", "set", "instructionNames", JSON.stringify(["AGENTS.md", "CLAUDE.md"]),
      "--project", projectRoot,
    ]);
    assert.equal(set.status, 0, set.stderr || set.stdout);
    const projectConfigPath = join(projectRoot, ".forgerelay", "config.json");
    assert.deepEqual(JSON.parse(readFileSync(projectConfigPath, "utf8")), {
      instructionNames: ["AGENTS.md", "CLAUDE.md"],
    });
    assert.equal(existsSync(join(configDir, "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context global writes use the machine config and preserve relative Skill path text", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-global-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const set = runCli(configDir, [
      "config", "context", "set", "skillPaths", JSON.stringify(["~/.claude/skills", "./.pi/skills"]), "--global",
    ]);
    assert.equal(set.status, 0, set.stderr || set.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")).skillPaths, [
      "~/.claude/skills", "./.pi/skills",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context sources and explain expose only context-source provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-inspect-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 7999,
    instructionNames: ["CUSTOM.md"],
  }) + "\n");
  try {
    const sources = runCli(configDir, ["config", "context", "sources", "--global", "--json"]);
    assert.equal(sources.status, 0, sources.stderr || sources.stdout);
    const sourceOutput = JSON.parse(sources.stdout) as { sources: Array<{ domain: string; id: string }> };
    assert.ok(sourceOutput.sources.length > 0);
    assert.ok(sourceOutput.sources.every((source) => source.domain === "config"));

    const explain = runCli(configDir, [
      "config", "context", "explain", "instructionNames", "--global", "--json",
    ]);
    assert.equal(explain.status, 0, explain.stderr || explain.stdout);
    const explanation = JSON.parse(explain.stdout) as { logicalPath: string; effective: { effectiveValue: unknown } };
    assert.equal(explanation.logicalPath, "config.instructionNames");
    assert.deepEqual(explanation.effective.effectiveValue, ["CUSTOM.md"]);

    const unrelated = runCli(configDir, ["config", "context", "explain", "port", "--global", "--json"]);
    assert.notEqual(unrelated.status, 0);
    assert.match(unrelated.stderr, /context field|Unknown/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context check reports context-source validation diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-check-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    instructionNames: ["nested/AGENTS.md"],
  }) + "\n");
  try {
    const check = runCli(configDir, ["config", "context", "check", "--global", "--json"]);
    assert.equal(check.status, 1, check.stderr || check.stdout);
    const output = JSON.parse(check.stdout) as {
      summary: { errors: number };
      diagnostics: Array<{ domain: string; code: string }>;
    };
    assert.ok(output.summary.errors > 0);
    assert.ok(output.diagnostics.length > 0);
    assert.ok(output.diagnostics.every((diagnostic) => diagnostic.domain === "config"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context runtime overrides replace lower scopes in the effective project view", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-runtime-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectRoot, ".forgerelay"), { recursive: true });
  writeFileSync(join(projectRoot, ".forgerelay", "config.json"), JSON.stringify({
    instructionNames: ["PROJECT.md"],
  }) + "\n");
  try {
    const result = runCli(configDir, ["config", "context", "get", "--project", projectRoot], {
      FORGERELAY_INSTRUCTION_NAMES: "RUNTIME.md",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).instructionNames, ["RUNTIME.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config context accepts only the three #183 context fields", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-context-fields-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    for (const command of ["set", "unset", "explain"] as const) {
      const args = command === "set"
        ? ["config", "context", command, "port", "7999", "--global"]
        : ["config", "context", command, "port", "--global"];
      const result = runCli(configDir, args);
      assert.notEqual(result.status, 0);
    }
    assert.equal(existsSync(join(configDir, "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
