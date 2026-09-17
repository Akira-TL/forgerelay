import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("config subagents set preserves canonical Markdown profile storage", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-subagents-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const profile = {
      description: "Review changes",
      provider: "codex",
      model: "gpt-5",
      body: "Review the current diff.",
    };
    const result = runCli(configDir, [
      "config", "subagents", "set", "profiles.reviewer", JSON.stringify(profile), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const document = readFileSync(join(configDir, "subagents", "reviewer.md"), "utf8");
    assert.match(document, /^---\n/);
    assert.match(document, /name: "reviewer"/);
    assert.match(document, /description: "Review changes"/);
    assert.match(document, /provider: codex/);
    assert.match(document, /model: "gpt-5"/);
    assert.match(document, /---\nReview the current diff\.\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config hooks set preserves one-file-per-hook canonical storage", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-hooks-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const hook = { event: "BeforeTool", command: "npm test" };
    const result = runCli(configDir, [
      "config", "hooks", "set", "hooks.build", JSON.stringify(hook), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "hooks", "build.json"), "utf8")), hook);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config lsp set preserves keyed-root language-servers.json storage", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-lsp-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const definition = { command: "demo-lsp", extensions: [".demo"] };
    const result = runCli(configDir, [
      "config", "lsp", "set", "servers.demo", JSON.stringify(definition), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "language-servers.json"), "utf8")), {
      demo: definition,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config mcp set writes one valid definition to canonical global mcp.json", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-mcp-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const result = runCli(configDir, [
      "config", "mcp", "set", "servers.demo",
      JSON.stringify({ transport: "streamable-http", url: "https://mcp.example.test/mcp" }),
      "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "mcp.json"), "utf8")), {
      servers: {
        demo: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      },
    });
    assert.equal(existsSync(join(configDir, "mcp-auth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config mcp get returns the effective configured definition without exposing interpolated secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-mcp-get-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const configured = {
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    };
    const create = runCli(configDir, [
      "config", "mcp", "set", "servers.demo", JSON.stringify(configured), "--global",
    ]);
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const get = runCli(
      configDir,
      ["config", "mcp", "get", "servers.demo", "--global"],
      { MCP_TOKEN: "SECRET_MUST_NOT_APPEAR" },
    );
    assert.equal(get.status, 0, get.stderr || get.stdout);
    assert.equal(JSON.parse(get.stdout), "<redacted>");
    assert.doesNotMatch(get.stdout, /SECRET_MUST_NOT_APPEAR|mcp\.example\.test|Bearer \$\{MCP_TOKEN\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config mcp unset removes one logical value without deleting the named server", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-mcp-unset-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const create = runCli(configDir, [
      "config", "mcp", "set", "servers.demo",
      JSON.stringify({
        transport: "streamable-http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer token" },
      }),
      "--global",
    ]);
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const unset = runCli(configDir, ["config", "mcp", "unset", "servers.demo.headers", "--global"]);
    assert.equal(unset.status, 0, unset.stderr || unset.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "mcp.json"), "utf8")), {
      servers: { demo: { transport: "streamable-http", url: "https://mcp.example.test/mcp" } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config mcp sources and explain expose only MCP Config v2 provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-mcp-inspect-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const create = runCli(configDir, [
      "config", "mcp", "set", "servers.demo",
      JSON.stringify({ transport: "stdio", command: "demo-server" }),
      "--global",
    ]);
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const sources = runCli(configDir, ["config", "mcp", "sources", "--global", "--json"]);
    assert.equal(sources.status, 0, sources.stderr || sources.stdout);
    const sourcesJson = JSON.parse(sources.stdout) as { sources: Array<{ domain: string; location?: string }> };
    assert.ok(sourcesJson.sources.length > 0);
    assert.ok(sourcesJson.sources.every((source) => source.domain === "mcp"));
    assert.ok(sourcesJson.sources.some((source) => source.location === join(configDir, "mcp.json")));

    const explain = runCli(configDir, [
      "config", "mcp", "explain", "servers.demo", "--global", "--json",
    ]);
    assert.equal(explain.status, 0, explain.stderr || explain.stdout);
    const explainJson = JSON.parse(explain.stdout) as { domain: string; logicalPath: string };
    assert.equal(explainJson.domain, "mcp");
    assert.equal(explainJson.logicalPath, "mcp.servers.demo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config mcp remove deletes a complete named server from canonical global storage", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-mcp-remove-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const create = runCli(configDir, [
      "config", "mcp", "set", "servers.demo",
      JSON.stringify({ transport: "stdio", command: "demo-server" }),
      "--global",
    ]);
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const remove = runCli(configDir, ["config", "mcp", "remove", "demo", "--global"]);
    assert.equal(remove.status, 0, remove.stderr || remove.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "mcp.json"), "utf8")), { servers: {} });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("domain mutations default to project shared storage without falling back to global", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-project-scope-"));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const env = { FORGERELAY_WORKSPACE_ROOT: projectRoot };
  try {
    const commands = [
      ["config", "mcp", "set", "servers.demo", JSON.stringify({ transport: "stdio", command: "demo" })],
      ["config", "lsp", "set", "servers.demo", JSON.stringify({ command: "demo-lsp", extensions: [".demo"] })],
      ["config", "hooks", "set", "hooks.build", JSON.stringify({ event: "BeforeTool", command: "npm test" })],
      ["config", "subagents", "set", "profiles.reviewer", JSON.stringify({ description: "Review", provider: "codex", body: "Review." })],
    ];
    for (const command of commands) {
      const result = runCli(configDir, command, env);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const shared = join(projectRoot, ".forgerelay");
    assert.equal(existsSync(join(shared, "mcp.json")), true);
    assert.equal(existsSync(join(shared, "language-servers.json")), true);
    assert.equal(existsSync(join(shared, "hooks", "build.json")), true);
    assert.equal(existsSync(join(shared, "subagents", "reviewer.md")), true);
    assert.equal(existsSync(join(configDir, "mcp.json")), false);
    assert.equal(existsSync(join(configDir, "language-servers.json")), false);
    assert.equal(existsSync(join(configDir, "hooks", "build.json")), false);
    assert.equal(existsSync(join(configDir, "subagents", "reviewer.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid updates are rejected atomically for every configurable domain", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-atomic-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const validCommands = [
      ["config", "mcp", "set", "servers.demo", JSON.stringify({ transport: "stdio", command: "demo" }), "--global"],
      ["config", "lsp", "set", "servers.demo", JSON.stringify({ command: "demo-lsp", extensions: [".demo"] }), "--global"],
      ["config", "hooks", "set", "hooks.build", JSON.stringify({ event: "BeforeTool", command: "npm test" }), "--global"],
      ["config", "subagents", "set", "profiles.reviewer", JSON.stringify({ description: "Review", provider: "codex", body: "Review." }), "--global"],
    ];
    for (const command of validCommands) {
      const result = runCli(configDir, command);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const paths = [
      join(configDir, "mcp.json"),
      join(configDir, "language-servers.json"),
      join(configDir, "hooks", "build.json"),
      join(configDir, "subagents", "reviewer.md"),
    ];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    const invalidCommands = [
      ["config", "mcp", "set", "servers.demo", JSON.stringify({ transport: "stdio" }), "--global"],
      ["config", "lsp", "set", "servers.demo", JSON.stringify({ extensions: ["demo"] }), "--global"],
      ["config", "hooks", "set", "hooks.build", JSON.stringify({ event: "BeforeTool", command: "" }), "--global"],
      ["config", "subagents", "set", "profiles.reviewer", JSON.stringify({ description: "Bad", provider: "unknown", body: "x" }), "--global"],
    ];
    for (const command of invalidCommands) {
      const result = runCli(configDir, command);
      assert.equal(result.status, 1, result.stderr || result.stdout);
    }
    assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp and lsp require remove for complete named-resource deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-remove-distinction-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const cases = [
      {
        cli: "mcp",
        path: "servers.demo",
        value: { transport: "stdio", command: "demo" },
        file: join(configDir, "mcp.json"),
      },
      {
        cli: "lsp",
        path: "servers.demo",
        value: { command: "demo-lsp", extensions: [".demo"] },
        file: join(configDir, "language-servers.json"),
      },
    ];
    for (const entry of cases) {
      const create = runCli(configDir, ["config", entry.cli, "set", entry.path, JSON.stringify(entry.value), "--global"]);
      assert.equal(create.status, 0, create.stderr || create.stdout);
      const before = readFileSync(entry.file, "utf8");
      const unset = runCli(configDir, ["config", entry.cli, "unset", entry.path, "--global"]);
      assert.equal(unset.status, 1, unset.stderr || unset.stdout);
      assert.match(unset.stderr, /remove <name>/);
      assert.equal(readFileSync(entry.file, "utf8"), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lsp hooks and subagents support unset and complete named-resource removal", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-remove-unset-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    let result = runCli(configDir, [
      "config", "lsp", "set", "servers.demo",
      JSON.stringify({ command: "demo-lsp", args: ["--stdio"], extensions: [".demo"] }), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = runCli(configDir, ["config", "lsp", "unset", "servers.demo.args", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal("args" in JSON.parse(readFileSync(join(configDir, "language-servers.json"), "utf8")).demo, false);
    result = runCli(configDir, ["config", "lsp", "remove", "demo", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "language-servers.json"), "utf8")), {});

    result = runCli(configDir, [
      "config", "hooks", "set", "hooks.build",
      JSON.stringify({ event: "BeforeTool", command: "npm test", report: true }), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = runCli(configDir, ["config", "hooks", "unset", "hooks.build.report", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal("report" in JSON.parse(readFileSync(join(configDir, "hooks", "build.json"), "utf8")), false);
    result = runCli(configDir, ["config", "hooks", "remove", "build", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(configDir, "hooks", "build.json")), false);

    result = runCli(configDir, [
      "config", "subagents", "set", "profiles.reviewer",
      JSON.stringify({ description: "Review", provider: "codex", model: "gpt-5", body: "Review." }), "--global",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = runCli(configDir, ["config", "subagents", "unset", "profiles.reviewer.model", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(readFileSync(join(configDir, "subagents", "reviewer.md"), "utf8"), /^model:/m);
    result = runCli(configDir, ["config", "subagents", "remove", "reviewer", "--global"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(configDir, "subagents", "reviewer.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all four domains expose get check sources and explain through Config v2", () => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-config-domain-inspection-matrix-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  try {
    const setups = [
      { cli: "mcp", domain: "mcp", path: "servers.demo", value: { transport: "stdio", command: "demo" } },
      { cli: "lsp", domain: "language-servers", path: "servers.demo", value: { command: "demo-lsp", extensions: [".demo"] } },
      { cli: "hooks", domain: "hooks", path: "hooks.build", value: { event: "BeforeTool", command: "npm test" } },
      { cli: "subagents", domain: "subagents", path: "profiles.reviewer", value: { description: "Review", provider: "codex", body: "Review." } },
    ];
    for (const setup of setups) {
      let result = runCli(configDir, ["config", setup.cli, "set", setup.path, JSON.stringify(setup.value), "--global"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      result = runCli(configDir, ["config", setup.cli, "get", setup.path, "--global"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      JSON.parse(result.stdout);
      result = runCli(configDir, ["config", setup.cli, "check", "--global", "--json"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      JSON.parse(result.stdout);
      result = runCli(configDir, ["config", setup.cli, "sources", "--global", "--json"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const sources = JSON.parse(result.stdout) as { sources: Array<{ domain: string }> };
      assert.ok(sources.sources.every((source) => source.domain === setup.domain));
      result = runCli(configDir, ["config", setup.cli, "explain", setup.path, "--global", "--json"]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const explain = JSON.parse(result.stdout) as { domain: string };
      assert.equal(explain.domain, setup.domain);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
