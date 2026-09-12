import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ExternalMcpConfigRegistry } from "../../runtime/config/external-mcp-registry.js";
import {
  effectiveLanguageServerEntries,
  resolveLanguageServersConfig,
} from "../../runtime/config/resolution/language-servers.js";
import {
  effectiveHookConfigEntries,
  resolveHooksConfig,
} from "../../runtime/config/resolution/hooks.js";
import { ConfigRuntime } from "../../runtime/config/runtime/config-runtime.js";
import { resolveSubagentProfilesConfig } from "../../subagents/profiles.js";

const cli = join(process.cwd(), "src", "cli.ts");

function runCli(configDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv, FORGERELAY_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("config migrate dry-run reports paths without mutating or printing legacy secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-dry-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const secret = "MIGRATION_SECRET_SENTINEL";
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    allowedRoots: [root],
    mcpServers: {
      demo: { transport: "streamable-http", url: "https://mcp.example.test/", headers: { Authorization: secret } },
    },
  }, null, 2));

  const result = runCli(configDir, ["config", "migrate", "--dry-run", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/i);
  assert.match(result.stdout, /mcp\.json/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.equal(existsSync(join(configDir, "mcp.json")), false);
  assert.ok(json(join(configDir, "config.json")).mcpServers);
});

test("config migrate writes canonical user domains, backs up legacy sources, and preserves effective behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-user-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  writeFileSync(join(configDir, "agents", "reviewer.md"), [
    "---",
    "description: Review code",
    "provider: codex",
    "---",
    "Review carefully.",
    "",
  ].join("\n"));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    allowedRoots: [root],
    artifactsEnabled: true,
    mcpServers: { demo: { transport: "stdio", command: "demo-mcp", args: ["--stdio"] } },
    languageServers: { custom: { command: "custom-lsp", extensions: [".custom"] } },
    hooks: { BeforeTool: [{ name: "guard", command: "printf guard", report: true }] },
  }, null, 2));
  writeFileSync(join(configDir, "hooks.json"), JSON.stringify({
    AfterTool: [{ name: "audit", command: "printf audit" }],
  }, null, 2));

  const result = runCli(configDir, ["config", "migrate", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migration complete/i);
  assert.match(result.stdout, /Backup:/);

  const migratedConfig = json(join(configDir, "config.json"));
  assert.equal(migratedConfig.artifactsEnabled, true);
  assert.equal("mcpServers" in migratedConfig, false);
  assert.equal("languageServers" in migratedConfig, false);
  assert.equal("hooks" in migratedConfig, false);
  assert.match(migratedConfig.$schema, /schemas\/v1\/config\.user\.schema\.json$/);

  const mcp = json(join(configDir, "mcp.json"));
  assert.equal(mcp.servers.demo.command, "demo-mcp");
  assert.match(mcp.$schema, /schemas\/v1\/mcp\.user\.schema\.json$/);
  const lsp = json(join(configDir, "language-servers.json"));
  assert.equal(lsp.custom.command, "custom-lsp");
  assert.match(lsp.$schema, /schemas\/v1\/language-servers\.user\.schema\.json$/);
  assert.equal(json(join(configDir, "hooks", "guard.json")).command, "printf guard");
  assert.equal(json(join(configDir, "hooks", "audit.json")).command, "printf audit");
  assert.equal(existsSync(join(configDir, "hooks.json")), false);
  assert.equal(existsSync(join(configDir, "agents")), false);
  assert.equal(readFileSync(join(configDir, "subagents", "reviewer.md"), "utf8").includes("Review carefully."), true);

  const backups = readdirSync(join(configDir, "migration-backups"));
  assert.equal(backups.length, 1);
  const backupRoot = join(configDir, "migration-backups", backups[0]!);
  assert.equal(existsSync(join(backupRoot, "config.json")), true);
  assert.equal(existsSync(join(backupRoot, "hooks.json")), true);
  assert.equal(existsSync(join(backupRoot, "agents", "reviewer.md")), true);

  const mcpResolved = new ExternalMcpConfigRegistry({ configDir }).resolveGlobal();
  assert.equal(mcpResolved.servers.demo?.transport, "stdio");
  assert.equal(mcpResolved.servers.demo && "command" in mcpResolved.servers.demo ? mcpResolved.servers.demo.command : undefined, "demo-mcp");

  const lspResolved = await resolveLanguageServersConfig({ configDir });
  const custom = effectiveLanguageServerEntries(lspResolved).find((entry) => entry.id === "custom");
  assert.equal(custom?.value.command, "custom-lsp");

  const hookResolved = await resolveHooksConfig({ configDir });
  assert.deepEqual(
    effectiveHookConfigEntries(hookResolved).map((entry) => entry.name).sort(),
    ["audit", "guard"],
  );

  const profileResolved = await resolveSubagentProfilesConfig(
    { configDir, configRuntime: new ConfigRuntime() },
    root,
  );
  assert.equal((profileResolved.values.profiles as Record<string, unknown>).reviewer !== undefined, true);
});

test("config migrate normalizes legacy Language Server disable semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-lsp-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    allowedRoots: [root],
    languageServers: {
      typescript: { enabled: false },
      custom: { command: "custom-lsp", extensions: [".custom"], enabled: true },
    },
  }, null, 2));

  const result = runCli(configDir, ["config", "migrate", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  const lsp = json(join(configDir, "language-servers.json"));
  assert.deepEqual(lsp.typescript, { disabled: true });
  assert.equal(lsp.custom.command, "custom-lsp");
  assert.equal("enabled" in lsp.custom, false);
});

test("config migrate handles project-shared legacy Hooks and Subagent Profiles explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-project-"));
  const configDir = join(root, "config");
  const project = join(root, "project");
  mkdirSync(join(project, ".forgerelay", "agents"), { recursive: true });
  writeFileSync(join(project, ".forgerelay", "hooks.json"), JSON.stringify({
    BeforeTool: [{ name: "project-guard", command: "printf project" }],
  }, null, 2));
  writeFileSync(join(project, ".forgerelay", "agents", "worker.md"), [
    "---",
    "name: worker",
    "description: Project worker",
    "provider: codex",
    "legacyExtra: ignored-by-old-parser",
    "---",
    "Work in project.",
    "",
  ].join("\n"));

  const dry = runCli(configDir, ["config", "migrate", "--dry-run", "--project", project]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(join(project, ".forgerelay", "hooks", "project-guard.json")), false);

  const result = runCli(configDir, ["config", "migrate", "--project", project]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json(join(project, ".forgerelay", "hooks", "project-guard.json")).command, "printf project");
  const profile = readFileSync(join(project, ".forgerelay", "subagents", "worker.md"), "utf8");
  assert.match(profile, /name: "worker"/);
  assert.doesNotMatch(profile, /legacyExtra/);
  assert.equal(existsSync(join(project, ".forgerelay", "hooks.json")), false);
  assert.equal(existsSync(join(project, ".forgerelay", "agents")), false);
});

test("config migrate preserves ForgeRelay-owned Skills under the ForgeRelay config directory", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-skills-"));
  const configDir = join(root, "config");
  const home = join(root, "home");
  mkdirSync(join(configDir, "skills", "owned-skill", "assets"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  writeFileSync(join(configDir, "skills", "owned-skill", "SKILL.md"), "---\nname: owned-skill\ndescription: ForgeRelay owned\n---\nBody\n");
  writeFileSync(join(configDir, "skills", "owned-skill", "assets", "blob.bin"), Buffer.from([0, 255, 1, 2, 3]));

  const result = runCli(configDir, ["config", "migrate", "--global"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(configDir, "skills", "owned-skill", "SKILL.md")), true);
  assert.deepEqual(
    [...readFileSync(join(configDir, "skills", "owned-skill", "assets", "blob.bin"))],
    [0, 255, 1, 2, 3],
  );
  assert.equal(existsSync(join(home, ".agents", "skills", "owned-skill")), false);
});

test("config migrate preserves repeated legacy Hook names by assigning stable extra canonical files", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-hook-duplicates-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    hooks: {
      BeforeTool: [{ name: "shared", command: "printf before" }],
      AfterTool: [{ name: "shared", command: "printf after" }],
    },
  }, null, 2));

  const result = runCli(configDir, ["config", "migrate", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  const hookFiles = readdirSync(join(configDir, "hooks")).filter((name) => name.endsWith(".json")).sort();
  assert.equal(hookFiles.length, 2);
  assert.equal(hookFiles.includes("shared.json"), true);
  const resolved = await resolveHooksConfig({ configDir });
  const commands = effectiveHookConfigEntries(resolved)
    .flatMap((entry) => entry.entries.map((hook) => hook.command))
    .sort();
  assert.deepEqual(commands, ["printf after", "printf before"]);
});

test("config migrate does not merge ForgeRelay-owned Skills with Agent ecosystem Skills", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-skill-shadow-"));
  const configDir = join(root, "config");
  const home = join(root, "home");
  mkdirSync(join(configDir, "skills", "review"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(configDir, "skills", "review", "SKILL.md"), "forgerelay-owned-skill");
  writeFileSync(join(home, ".agents", "skills", "review", "SKILL.md"), "agent-ecosystem-skill");

  const result = runCli(configDir, ["config", "migrate", "--global"], { HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(configDir, "skills", "review", "SKILL.md"), "utf8"), "forgerelay-owned-skill");
  assert.equal(readFileSync(join(home, ".agents", "skills", "review", "SKILL.md"), "utf8"), "agent-ecosystem-skill");
});

test("config migrate preserves Subagent Profiles when legacy and canonical filenames collide but names differ", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-profile-filename-"));
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(join(configDir, "subagents"), { recursive: true });
  writeFileSync(join(configDir, "agents", "worker.md"), "---\nname: legacy-worker\ndescription: Legacy worker\nprovider: codex\n---\nLegacy body.\n");
  writeFileSync(join(configDir, "subagents", "worker.md"), "---\nname: canonical-worker\ndescription: Canonical worker\nprovider: codex\n---\nCanonical body.\n");

  const result = runCli(configDir, ["config", "migrate", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  const resolved = await resolveSubagentProfilesConfig(
    { configDir, configRuntime: new ConfigRuntime() },
    root,
  );
  assert.deepEqual(
    Object.keys(resolved.values.profiles as Record<string, unknown>).sort(),
    ["canonical-worker", "legacy-worker"],
  );
});

test("config migrate does not reactivate legacy MCP values shadowed by an existing canonical source", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-migrate-shadow-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    allowedRoots: [root],
    mcpServers: { legacy: { transport: "stdio", command: "must-not-activate" } },
  }, null, 2));
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
    servers: { canonical: { transport: "stdio", command: "canonical-only" } },
  }, null, 2));

  const result = runCli(configDir, ["config", "migrate", "--global"]);
  assert.equal(result.status, 0, result.stderr);
  const mcp = json(join(configDir, "mcp.json"));
  assert.deepEqual(Object.keys(mcp.servers), ["canonical"]);
  assert.equal("mcpServers" in json(join(configDir, "config.json")), false);
});
