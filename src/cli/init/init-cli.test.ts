import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pty from "node-pty";

const cli = join(process.cwd(), "src", "cli.ts");

void test("basic init asks only roots and connection mode while preserving the connection handoff", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-init-cli-test-"));
  const configDir = join(root, "config");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const child = pty.spawn(process.execPath, ["--import", "tsx", cli, "init"], {
    name: "xterm-256color",
    cols: 110,
    rows: 40,
    cwd: process.cwd(),
    env: stringEnvironment({
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_STATE_DIR: join(root, "state"),
    }),
  });

  let output = "";
  let rootsAnswered = false;
  let modeAnswered = false;
  child.onData((data) => {
    output += data;
    if (!rootsAnswered && output.includes("Where are your projects located?")) {
      rootsAnswered = true;
      child.write("\r");
      return;
    }
    if (rootsAnswered && !modeAnswered && output.includes("How should clients reach this ForgeRelay instance?")) {
      modeAnswered = true;
      child.write("\r");
    }
  });

  const exitCode = await waitForExit(child, 10_000);
  assert.equal(exitCode, 0, output);
  assert.equal(rootsAnswered, true, output);
  assert.equal(modeAnswered, true, output);
  for (const unexpected of [
    "Which local port should ForgeRelay use?",
    "Which command shell should Agent commands and Hooks use?",
    "Runtime Shell Instructions for this command shell?",
    "Which Language Servers should ForgeRelay manage with npm?",
    "Allow Agents to install or update ForgeRelay-managed Language Servers on demand?",
  ]) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(unexpected)));
  }

  const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "allowedRoots"]);
  assert.match(String(config.$schema), /schemas\/v1\/config\.user\.schema\.json$/);

  const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")) as { ownerToken?: string };
  assert.ok(auth.ownerToken);
  assert.match(output, /OAuth mode: Owner-password approval/);
  assert.match(output, /Client-facing MCP URL/);
  assert.match(output, new RegExp(escapeRegExp(`Owner password: ${auth.ownerToken}`)));
  assert.match(output, /Run `forgerelay serve` to start the MCP server\./);
});

void test("advanced init remains directly usable after basic setup and preserves unrelated config", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "forgerelay-init-advanced-cli-test-"));
  const configDir = join(root, "config");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    $schema: "https://example.invalid/config.schema.json",
    allowedRoots: [process.cwd()],
    port: 8765,
    retention: { historyDays: 30 },
  }, null, 2));
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({ ownerToken: "owner-test", instanceId: "forge-test" }, null, 2));

  const child = pty.spawn(process.execPath, ["--import", "tsx", cli, "init", "--advanced"], {
    name: "xterm-256color",
    cols: 110,
    rows: 40,
    cwd: process.cwd(),
    env: stringEnvironment({
      SHELL: "/bin/bash",
      FORGERELAY_CONFIG_DIR: configDir,
      FORGERELAY_STATE_DIR: join(root, "state"),
    }),
  });

  let output = "";
  const answered = new Set<string>();
  const promptsToAnswer = [
    "Where are your projects located?",
    "How should clients reach this ForgeRelay instance?",
    "Which local port should ForgeRelay use?",
    "Which command shell should Agent commands and Hooks use?",
    "Which Language Servers should ForgeRelay manage with npm?",
    "Allow Agents to install or update ForgeRelay-managed Language Servers on demand?",
  ];
  child.onData((data) => {
    output += data;
    for (const prompt of promptsToAnswer) {
      if (!answered.has(prompt) && output.includes(prompt)) {
        answered.add(prompt);
        child.write("\r");
        break;
      }
    }
  });

  const exitCode = await waitForExit(child, 10_000);
  assert.equal(exitCode, 0, output);
  assert.doesNotMatch(output, /already configured/);
  for (const prompt of promptsToAnswer) assert.equal(answered.has(prompt), true, `${prompt}\n${output}`);

  const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(config.port, 8765);
  assert.deepEqual(config.retention, { historyDays: 30 });
  assert.match(String(config.$schema), /schemas\/v1\/config\.user\.schema\.json$/);
});

function stringEnvironment(extra: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...extra,
  };
}

function waitForExit(child: pty.IPty, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out waiting for interactive init to exit."));
    }, timeoutMs);
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
