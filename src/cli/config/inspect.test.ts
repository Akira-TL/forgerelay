import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = join(process.cwd(), "src", "cli.ts");

function runCli(configDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv, FORGERELAY_CONFIG_DIR: configDir },
    encoding: "utf8",
  });
}

test("config check reports invalid global configuration as JSON with exit code 1 and explicit offline live-state uncertainty", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-invalid-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), "{ not-json\n");

  const result = runCli(configDir, ["config", "check", "--global", "--json"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    command?: string;
    scope?: { mode?: string };
    liveState?: { mode?: string; lastKnownGood?: string; appliedValues?: string };
    summary?: { errors?: number; warnings?: number; info?: number };
    diagnostics?: Array<{ severity?: string; code?: string; domain?: string; source?: { location?: string } }>;
  };
  assert.equal(output.command, "check");
  assert.equal(output.scope?.mode, "global");
  assert.deepEqual(output.liveState, {
    mode: "offline",
    lastKnownGood: "unknown",
    appliedValues: "unknown",
  });
  assert.equal(output.summary?.errors, 1);
  assert.equal(output.summary?.warnings, 0);
  assert.equal(output.summary?.info, 0);
  assert.equal(output.diagnostics?.[0]?.severity, "error");
  assert.equal(output.diagnostics?.[0]?.code, "invalid_source");
  assert.equal(output.diagnostics?.[0]?.domain, "config");
  assert.equal(output.diagnostics?.[0]?.source?.location, join(configDir, "config.json"));
});

test("top-level help advertises the Config v2 diagnostic commands", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-help-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const result = runCli(configDir, ["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /forgerelay config check/);
  assert.match(result.stdout, /forgerelay config sources/);
  assert.match(result.stdout, /forgerelay config explain <logical-path>/);
});

test("config diagnostic usage and query failures exit with code 2", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-usage-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const usage = runCli(configDir, ["config", "check", "--global", "--project", root]);
  assert.equal(usage.status, 2, usage.stderr || usage.stdout);
  assert.match(usage.stderr, /--global and --project/);

  const query = runCli(configDir, ["config", "check", "--project", join(root, "missing-project")]);
  assert.equal(query.status, 2, query.stderr || query.stdout);
  assert.match(query.stderr, /missing-project|ENOENT|no such file/i);
});

test("config check validates every global Config v2 domain without starting configured runtimes", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-domains-"));
  const configDir = join(root, "config");
  const marker = join(root, "must-not-run.txt");
  mkdirSync(join(configDir, "hooks"), { recursive: true });
  mkdirSync(join(configDir, "subagents"), { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ allowedRoots: [root] }));
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
    servers: {
      remote: {
        transport: "streamable-http",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "CONFIG_CHECK_SECRET_SENTINEL" },
      },
      local: {
        transport: "stdio",
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'mcp')`],
      },
    },
  }));
  writeFileSync(join(configDir, "language-servers.json"), JSON.stringify({
    custom: {
      command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'lsp')`],
      extensions: [".custom"],
      env: { TOKEN: "${MISSING_CONFIG_CHECK_ENV}" },
    },
  }));
  writeFileSync(join(configDir, "hooks", "safe.json"), JSON.stringify({
    event: "BeforeTool",
    command: `${process.execPath} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'hook')`)}`,
  }));
  writeFileSync(join(configDir, "hooks", "broken.json"), JSON.stringify({
    event: "BeforeTool",
    command: "printf broken",
    unsupported: true,
  }));
  writeFileSync(join(configDir, "subagents", "reviewer.md"), [
    "---",
    "description: Review code",
    "provider: codex",
    "---",
    "Review carefully.",
    "",
  ].join("\n"));

  const result = runCli(configDir, ["config", "check", "--global", "--json"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(result.stdout + result.stderr, /CONFIG_CHECK_SECRET_SENTINEL/);
  const output = JSON.parse(result.stdout) as {
    summary: { errors: number };
    diagnostics: Array<{ domain: string; code: string; severity: string }>;
  };
  assert.equal(output.summary.errors, 2);
  assert.deepEqual(
    output.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.domain).sort(),
    ["hooks", "language-servers"],
  );
  assert.ok(output.diagnostics.some((diagnostic) => diagnostic.code === "missing_environment"));
});

test("project config check is read-only and does not create Project identity state", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-project-readonly-"));
  const configDir = join(root, "config");
  const project = join(root, "project");
  mkdirSync(join(project, ".forgerelay"), { recursive: true });
  writeFileSync(join(project, ".forgerelay", "config.json"), JSON.stringify({ port: "not-a-port" }));

  const result = runCli(configDir, ["config", "check", "--project", project, "--json"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    scope: { mode: string; projectRoot?: string };
    diagnostics: Array<{ domain: string; source: { scope: string; location?: string } }>;
  };
  assert.equal(output.scope.mode, "project");
  assert.equal(output.scope.projectRoot, project);
  assert.ok(output.diagnostics.some((diagnostic) =>
    diagnostic.domain === "config" &&
    diagnostic.source.scope === "project" &&
    diagnostic.source.location === join(project, ".forgerelay", "config.json")
  ));
  assert.equal(existsSync(join(configDir, "projects")), false);
});

test("config sources lists only meaningful participating sources with provenance roles", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-sources-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    port: 9000,
    mcpServers: { legacy: { transport: "stdio", command: "legacy-mcp" } },
  }));
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
    servers: { canonical: { transport: "stdio", command: "canonical-mcp" } },
  }));

  const result = runCli(configDir, ["config", "sources", "--global", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    command: string;
    sources: Array<{
      domain: string;
      id: string;
      kind: string;
      state: string;
      roles: string[];
      location?: string;
    }>;
  };
  assert.equal(output.command, "sources");
  assert.ok(output.sources.some((source) =>
    source.domain === "config" && source.id === "user:config" && source.roles.includes("effective")
  ));
  assert.ok(output.sources.some((source) =>
    source.domain === "mcp" && source.id === "legacy:user:mcpServers" && source.roles.includes("legacy")
  ));
  assert.ok(output.sources.some((source) =>
    source.domain === "mcp" && source.id === "canonical:user:mcp" && source.roles.includes("effective")
  ));
  assert.equal(output.sources.some((source) => source.kind === "environment"), false);
  assert.equal(output.sources.some((source) => source.state === "missing"), false);
});

test("config explain reports precedence, reload, and execution metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-explain-port-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ port: 9000 }));

  const result = runCli(configDir, ["config", "explain", "config.port", "--global", "--json"], { PORT: "9001" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    command: string;
    logicalPath: string;
    effective: { source: { id: string }; configuredValue: unknown; effectiveValue: unknown; reload: string; executionEffect: string };
    shadowed: Array<{ source: { id: string }; reason: string; configuredValue: unknown }>;
  };
  assert.equal(output.command, "explain");
  assert.equal(output.logicalPath, "config.port");
  assert.equal(output.effective.source.id, "runtime:environment");
  assert.equal(output.effective.configuredValue, 9001);
  assert.equal(output.effective.effectiveValue, 9001);
  assert.equal(output.effective.reload, "restart-required");
  assert.equal(output.effective.executionEffect, "none");
  assert.ok(output.shadowed.some((entry) =>
    entry.source.id === "user:config" && entry.reason === "higher-scope" && entry.configuredValue === 9000
  ));
});

test("config explain human output includes related diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-explain-diagnostics-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    $schema: "https://example.test/stale-config.schema.json",
    port: 9000,
  }));

  const result = runCli(configDir, ["config", "explain", "config.port", "--global"], { PORT: "9001" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Diagnostics:/);
  assert.match(result.stdout, /WARNING schema_mismatch/);
  assert.match(result.stdout, /INFO shadowed_value/);
});

test("config explain preserves environment references for sensitive config without printing resolved secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-explain-secret-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "mcp.json"), JSON.stringify({
    servers: {
      secure: {
        transport: "streamable-http",
        url: "https://mcp.example.test/",
        headers: { Authorization: "${MCP_EXPLAIN_SECRET}" },
      },
    },
  }));
  const secret = "EXPLAIN_SECRET_SENTINEL";

  const result = runCli(configDir, ["config", "explain", "mcp.servers.secure", "--global", "--json"], {
    MCP_EXPLAIN_SECRET: secret,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.match(result.stdout, /MCP_EXPLAIN_SECRET/);
  const output = JSON.parse(result.stdout) as {
    effective: { configuredValue: unknown; effectiveValue: unknown; sensitivity: string; source: { id: string } };
  };
  assert.equal(output.effective.source.id, "canonical:user:mcp");
  assert.equal(output.effective.sensitivity, "sensitive");
  assert.equal(output.effective.effectiveValue, "<redacted>");
  assert.deepEqual(output.effective.configuredValue, {
    transport: "<redacted>",
    url: "<redacted>",
    headers: { Authorization: "${MCP_EXPLAIN_SECRET}" },
  });
});

test("config check reports precedence as info and unexpected schema references as warnings without failing", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-advisory-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    $schema: "https://example.test/stale-config.schema.json",
    port: 9000,
  }));

  const result = runCli(configDir, ["config", "check", "--global", "--json"], { PORT: "9001" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    summary: { errors: number; warnings: number; info: number };
    diagnostics: Array<{ severity: string; code: string; logicalPath?: string }>;
  };
  assert.equal(output.summary.errors, 0);
  assert.ok(output.summary.warnings >= 1);
  assert.ok(output.summary.info >= 1);
  assert.ok(output.diagnostics.some((diagnostic) => diagnostic.code === "schema_mismatch" && diagnostic.severity === "warning"));
  assert.ok(output.diagnostics.some((diagnostic) =>
    diagnostic.code === "shadowed_value" && diagnostic.severity === "info" && diagnostic.logicalPath === "config.port"
  ));
});

test("config check validates the supported legacy user hooks.json source", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-check-legacy-hooks-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), "{}\n");
  writeFileSync(join(configDir, "hooks.json"), JSON.stringify({ UnsupportedEvent: [] }));

  const result = runCli(configDir, ["config", "check", "--global", "--json"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    diagnostics: Array<{ severity: string; domain: string; source: { location?: string } }>;
  };
  assert.ok(output.diagnostics.some((diagnostic) =>
    diagnostic.severity === "error" &&
    diagnostic.domain === "hooks" &&
    diagnostic.source.location === join(configDir, "hooks.json")
  ));
});
