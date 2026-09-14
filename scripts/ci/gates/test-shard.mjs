#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("ci:test-shard must run through npm so npm_execpath is available");

const shard = process.argv[2];
const allowed = new Set([
  "runtime-config",
  "workspace-relay-auth",
  "workspace-relay",
  "workspace-lifecycle",
  "workspace-state",
  "mcp-core",
  "mcp-server-ui",
  "lsp",
  "subagent",
  "ui-cli",
]);
if (!allowed.has(shard)) {
  throw new Error(`Unknown CI test shard '${shard ?? ""}'. Expected one of: ${[...allowed].join(", ")}`);
}

const repoRoot = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const commands = String(pkg.scripts?.test ?? "").split(" && ").filter(Boolean);
if (commands.length === 0) throw new Error("package.json test script did not contain any commands");

const selected = commands.filter((command) => classify(command) === shard);
if (selected.length === 0) throw new Error(`CI test shard '${shard}' is empty`);

console.log(`CI test shard ${shard}: ${selected.length}/${commands.length} test commands.`);
for (const command of selected) runCommand(command);
console.log(`CI test shard ${shard} passed.`);

function classify(command) {
  if (command === "npm run build:app") return "mcp-server-ui";
  if (command.includes("src/lsp/")) return "lsp";
  if (command.includes("src/workspaces/relay/auth/")) return "workspace-relay-auth";
  if (command.includes("src/workspaces/relay/tests/")) return "workspace-relay";
  if (
    command.includes("src/workspaces/conversation-")
    || command.includes("src/workspaces/git/")
    || command.includes("src/workspaces.test")
  ) return "workspace-lifecycle";
  if (command.includes("src/workspaces/") || command.includes("src/activity/")) {
    return "workspace-state";
  }
  if (
    command.includes("src/mcp/server")
    || command.includes("src/mcp/panel/")
    || command.includes("src/mcp/process/server.test.ts")
  ) return "mcp-server-ui";
  if (command.includes("src/mcp/")) return "mcp-core";
  if (command.includes("src/runtime/") || command.startsWith("node --test scripts/")) {
    return "runtime-config";
  }
  if (command.includes("src/subagents/")) return "subagent";
  return "ui-cli";
}

function runCommand(command) {
  console.log(`\n== ${command} ==`);
  let executable;
  let args;
  if (command.startsWith("node --test ")) {
    executable = process.execPath;
    args = ["--test", ...command.slice("node --test ".length).split(" ").filter(Boolean)];
  } else if (command.startsWith("tsx ")) {
    executable = process.execPath;
    args = [npmCli, "exec", "--", "tsx", ...command.slice(4).split(" ").filter(Boolean)];
  } else if (command.startsWith("npm run ")) {
    executable = process.execPath;
    args = [npmCli, "run", command.slice("npm run ".length).trim()];
  } else {
    throw new Error(`Unsupported command in package.json test script: ${command}`);
  }

  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CI test shard '${shard}' command failed with exit ${result.status ?? "unknown"}: ${command}`);
  }
}
