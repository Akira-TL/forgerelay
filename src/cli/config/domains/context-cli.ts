import { assertConfigResolutionValid } from "../../../runtime/config/resolution/resolver.js";
import {
  resolveGeneralConfigForScope,
  runGeneralConfigSet,
  runGeneralConfigUnset,
} from "../general.js";
import { runConfigInspection } from "../inspect.js";
import { parseConfigScopeArgs, type ConfigCliScope } from "../scope.js";

const CONTEXT_FIELDS = [
  "systemInstructionsPath",
  "instructionNames",
  "skillPaths",
] as const;
type ContextField = typeof CONTEXT_FIELDS[number];

const CONTEXT_LOGICAL_PATHS = new Set(CONTEXT_FIELDS.map((field) => `config.${field}`));

export async function runConfigContextCommand(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(renderConfigContextHelp());
    return;
  }
  if (command === "get") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length > 0) throw new Error(`Unknown config context get option: ${parsed.rest[0]}`);
    const resolution = await resolveGeneralConfigForScope(parsed.scope);
    assertConfigResolutionValid(resolution);
    const output = Object.fromEntries(CONTEXT_FIELDS.map((field) => {
      const entry = resolution.entries[field];
      if (!entry) throw new Error(`Missing General Config context field: config.${field}.`);
      return [field, entry.effective.effectiveValue];
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === "set") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length < 2) {
      throw new Error("Usage: forgerelay config context set <field> <value> [--project <path>|--global]");
    }
    const field = normalizeContextField(parsed.rest[0]!);
    await runGeneralConfigSet([field, ...parsed.rest.slice(1), ...scopeArgs(parsed.scope)]);
    return;
  }
  if (command === "unset") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length !== 1) {
      throw new Error("Usage: forgerelay config context unset <field> [--project <path>|--global]");
    }
    const field = normalizeContextField(parsed.rest[0]!);
    await runGeneralConfigUnset([field, ...scopeArgs(parsed.scope)]);
    return;
  }
  if (command === "check" || command === "sources") {
    process.exitCode = await runConfigInspection(
      [command, ...rest],
      "config",
      CONTEXT_LOGICAL_PATHS,
    );
    return;
  }
  if (command === "explain") {
    const parsed = parseConfigScopeArgs(rest);
    if (parsed.rest.length < 1) {
      throw new Error("Usage: forgerelay config context explain <field> [--project <path>|--global] [--json]");
    }
    const field = normalizeContextField(parsed.rest[0]!);
    process.exitCode = await runConfigInspection(
      ["explain", `config.${field}`, ...parsed.rest.slice(1), ...scopeArgs(parsed.scope)],
      "config",
      CONTEXT_LOGICAL_PATHS,
    );
    return;
  }
  throw new Error(`Unknown config context command: ${command}`);
}

function normalizeContextField(value: string): ContextField {
  const field = value.startsWith("config.") ? value.slice("config.".length) : value;
  if ((CONTEXT_FIELDS as readonly string[]).includes(field)) return field as ContextField;
  throw new Error(`Unknown config context field: ${value}. Expected ${CONTEXT_FIELDS.join(", ")}.`);
}

function scopeArgs(scope: ConfigCliScope): string[] {
  return scope.mode === "global" ? ["--global"] : ["--project", scope.projectRoot];
}

function renderConfigContextHelp(): string {
  return [
    "ForgeRelay config context",
    "",
    "Usage:",
    "  forgerelay config context get [--project <path>|--global]",
    "  forgerelay config context set <systemInstructionsPath|instructionNames|skillPaths> <value> [--project <path>|--global]",
    "  forgerelay config context unset <systemInstructionsPath|instructionNames|skillPaths> [--project <path>|--global]",
    "  forgerelay config context check [--project <path>|--global] [--json]",
    "  forgerelay config context sources [--project <path>|--global] [--json]",
    "  forgerelay config context explain <systemInstructionsPath|instructionNames|skillPaths> [--project <path>|--global] [--json]",
  ].join("\n");
}
