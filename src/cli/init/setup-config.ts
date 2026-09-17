import type { CommandShellPreference } from "../../runtime/shell/command-shell-runtime.js";
import type { ForgeRelayUserConfig } from "../../runtime/config/user-config.js";
import {
  DEFAULT_INSTRUCTION_NAMES,
  DEFAULT_SKILL_PATHS,
  DEFAULT_SYSTEM_INSTRUCTIONS_PATH,
} from "../../runtime/config/definition/general-config.js";
import type { SetupNetworkMode } from "../setup-support.js";

export interface SetupNetworkSelection {
  mode: SetupNetworkMode;
  publicBaseUrl?: ForgeRelayUserConfig["publicBaseUrl"];
}

export interface AdvancedSetupSelection {
  port: number;
  commandShell: CommandShellPreference;
  shellInstructions: boolean;
  allowAgentLanguageServerInstall: boolean;
}

export interface AgentContextSetupSelection {
  systemInstructionsPath: string;
  instructionNames: string[];
  skillPaths: string[];
}

export interface SetupConfigSelection {
  schema: string;
  allowedRoots: string[];
  network: SetupNetworkSelection;
  context?: AgentContextSetupSelection;
  advanced?: AdvancedSetupSelection;
}

export function applySetupConfig(
  current: ForgeRelayUserConfig,
  selection: SetupConfigSelection,
): ForgeRelayUserConfig {
  const next: ForgeRelayUserConfig = {
    ...current,
    $schema: selection.schema,
    allowedRoots: [...selection.allowedRoots],
  };

  applyNetworkSelection(next, selection.network);
  if (selection.context) applyAgentContextSelection(next, selection.context);
  if (selection.advanced) applyAdvancedSelection(next, selection.advanced);
  return next;
}

function applyNetworkSelection(config: ForgeRelayUserConfig, selection: SetupNetworkSelection): void {
  delete config.host;
  delete config.publicBaseUrl;
  delete config.trustedProxies;

  if (selection.mode === "lan") config.host = "0.0.0.0";
  if (selection.mode === "lan" || selection.mode === "proxy") {
    if (selection.publicBaseUrl === undefined || selection.publicBaseUrl === null) {
      throw new Error(`${selection.mode} setup requires a client-facing base URL.`);
    }
    config.publicBaseUrl = selection.publicBaseUrl;
  }
}

function applyAgentContextSelection(
  config: ForgeRelayUserConfig,
  selection: AgentContextSetupSelection,
): void {
  if (selection.systemInstructionsPath === DEFAULT_SYSTEM_INSTRUCTIONS_PATH) {
    delete config.systemInstructionsPath;
  } else {
    config.systemInstructionsPath = selection.systemInstructionsPath;
  }

  if (sameStringList(selection.instructionNames, DEFAULT_INSTRUCTION_NAMES)) {
    delete config.instructionNames;
  } else {
    config.instructionNames = [...selection.instructionNames];
  }

  if (sameStringList(selection.skillPaths, DEFAULT_SKILL_PATHS)) {
    delete config.skillPaths;
  } else {
    config.skillPaths = [...selection.skillPaths];
  }
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyAdvancedSelection(config: ForgeRelayUserConfig, selection: AdvancedSetupSelection): void {
  if (selection.port === 7676) delete config.port;
  else config.port = selection.port;

  config.commandShell = selection.commandShell;
  if (selection.shellInstructions) config.shellInstructions = true;
  else delete config.shellInstructions;

  if (selection.allowAgentLanguageServerInstall) config.allowAgentLanguageServerInstall = true;
  else delete config.allowAgentLanguageServerInstall;
}
