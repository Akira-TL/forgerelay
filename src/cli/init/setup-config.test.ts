import assert from "node:assert/strict";
import test from "node:test";
import type { ForgeRelayUserConfig } from "../../runtime/config/user-config.js";
import {
  DEFAULT_INSTRUCTION_NAMES,
  DEFAULT_SKILL_PATHS,
  DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
} from "../../runtime/config/definition/general-config.js";
import { applySetupConfig } from "./setup-config.js";

const schema = "https://raw.githubusercontent.com/Akira-TL/forgerelay/main/schemas/v1/config.user.schema.json";
const roots = ["/projects"];

test("basic local init persists only schema and selected roots for a fresh install", () => {
  assert.deepEqual(applySetupConfig({}, {
    schema,
    allowedRoots: roots,
    network: { mode: "local" },
  }), {
    $schema: schema,
    allowedRoots: roots,
  });
});

test("basic force init changes setup-owned network fields without snapshotting advanced defaults", () => {
  const current: ForgeRelayUserConfig = {
    port: 9000,
    commandShell: { mode: "pinned", family: "bash", executable: "/bin/bash" },
    shellInstructions: true,
    allowAgentLanguageServerInstall: true,
    artifactsEnabled: true,
    host: "0.0.0.0",
    publicBaseUrl: "http://192.168.1.20:9000",
  };
  assert.deepEqual(applySetupConfig(current, {
    schema,
    allowedRoots: roots,
    network: { mode: "local" },
  }), {
    $schema: schema,
    port: 9000,
    commandShell: { mode: "pinned", family: "bash", executable: "/bin/bash" },
    shellInstructions: true,
    allowAgentLanguageServerInstall: true,
    artifactsEnabled: true,
    allowedRoots: roots,
  });
});

test("basic proxy init persists only connection-specific values", () => {
  assert.deepEqual(applySetupConfig({}, {
    schema,
    allowedRoots: roots,
    network: { mode: "proxy", publicBaseUrl: "https://forge.example.com/relay" },
  }), {
    $schema: schema,
    allowedRoots: roots,
    publicBaseUrl: "https://forge.example.com/relay",
  });
});

test("init accepts Agent context built-ins without persisting redundant overrides", () => {
  const current: ForgeRelayUserConfig = {
    systemInstructionsPath: DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
    instructionNames: [...DEFAULT_INSTRUCTION_NAMES],
    skillPaths: [...DEFAULT_SKILL_PATHS],
  };
  assert.deepEqual(applySetupConfig(current, {
    schema,
    allowedRoots: roots,
    network: { mode: "local" },
    context: {
      systemInstructionsPath: DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
      instructionNames: [...DEFAULT_INSTRUCTION_NAMES],
      skillPaths: [...DEFAULT_SKILL_PATHS],
    },
  }), {
    $schema: schema,
    allowedRoots: roots,
  });
});

test("init persists only actual Agent context source overrides", () => {
  assert.deepEqual(applySetupConfig({}, {
    schema,
    allowedRoots: roots,
    network: { mode: "local" },
    context: {
      systemInstructionsPath: "~/.custom/AGENT.md",
      instructionNames: ["AGENTS.md", "CLAUDE.md"],
      skillPaths: ["~/.claude/skills", "./.claude/skills"],
    },
  }), {
    $schema: schema,
    allowedRoots: roots,
    systemInstructionsPath: "~/.custom/AGENT.md",
    instructionNames: ["AGENTS.md", "CLAUDE.md"],
    skillPaths: ["~/.claude/skills", "./.claude/skills"],
  });
});

test("advanced init removes built-in defaults instead of serializing them", () => {
  const current: ForgeRelayUserConfig = {
    port: 9000,
    shellInstructions: true,
    allowAgentLanguageServerInstall: true,
  };
  assert.deepEqual(applySetupConfig(current, {
    schema,
    allowedRoots: roots,
    network: { mode: "ssh" },
    advanced: {
      port: 7676,
      commandShell: { mode: "pinned", family: "bash", executable: "/bin/bash" },
      shellInstructions: false,
      allowAgentLanguageServerInstall: false,
    },
  }), {
    $schema: schema,
    allowedRoots: roots,
    commandShell: { mode: "pinned", family: "bash", executable: "/bin/bash" },
  });
});
