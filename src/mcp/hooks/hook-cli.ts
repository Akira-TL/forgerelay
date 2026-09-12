import { join, resolve } from "node:path";
import { resolveProjectContext } from "../../workspaces/state/project-context.js";
import {
  effectiveHookConfigEntries,
  resolveHooksConfig,
} from "../../runtime/config/resolution/hooks.js";
import type { ResolvedConfigDomain } from "../../runtime/config/resolution/types.js";
import type { ConfigSourceRuntime } from "../../runtime/config/runtime/source-refresh.js";
import { forgerelayConfigDir } from "../../runtime/config/user-config.js";
import {
  type HookConfig,
  type HookEvent,
  type HookMatcher,
} from "./hooks.js";

type HookScope = "global" | "project";

type HookListEntry = {
  scope: HookScope;
  event: HookEvent;
  name: string;
  matcher?: HookMatcher;
  command: string;
  timeoutSeconds: number;
  report: boolean;
};

export interface HookCheckResult {
  globalHooks: number;
  projectHooks: number;
}

export async function checkHookConfiguration(
  projectRoot: string,
  globalHooks: HookConfig = {},
  configDir?: string,
  sourceRuntime?: ConfigSourceRuntime,
): Promise<HookCheckResult> {
  const resolution = await resolveHookConfiguration(projectRoot, globalHooks, configDir, sourceRuntime);
  assertHookResolutionValid(resolution);
  const entries = flattenResolvedHooks(resolution);
  return {
    globalHooks: entries.filter((entry) => entry.scope === "global").length,
    projectHooks: entries.filter((entry) => entry.scope === "project").length,
  };
}

export async function runHooksCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) {
    printHooksHelp();
    return;
  }

  const projectRoot = parseProjectRoot(rest);
  const configDir = forgerelayConfigDir();
  const resolution = await resolveHookConfiguration(projectRoot, {}, configDir);
  const entries = flattenResolvedHooks(resolution);

  if (subcommand === "list") {
    for (const entry of entries) console.log(formatHookEntry(entry));
    if (entries.length === 0) console.log("No hooks configured.");
    for (const diagnostic of hookErrors(resolution)) {
      console.error(`Hooks diagnostic: ${formatDiagnostic(diagnostic)}`);
    }
    return;
  }

  if (subcommand === "check") {
    assertHookResolutionValid(resolution);
    const globalHooksCount = entries.filter((entry) => entry.scope === "global").length;
    const projectHooksCount = entries.filter((entry) => entry.scope === "project").length;
    console.log(`Hooks OK: ${globalHooksCount} global, ${projectHooksCount} project`);
    return;
  }

  throw new Error(`Unknown hooks command: ${subcommand}`);
}

async function resolveHookConfiguration(
  projectRoot: string,
  legacyUser: HookConfig,
  configDir?: string,
  sourceRuntime?: ConfigSourceRuntime,
): Promise<ResolvedConfigDomain> {
  const project = configDir ? await resolveProjectContext(configDir, projectRoot) : undefined;
  return resolveHooksConfig({
    ...(configDir ? { configDir } : {}),
    ...(project ? { project } : {}),
    projectSharedConfigDir: join(projectRoot, ".forgerelay"),
    legacyUser,
    ...(sourceRuntime ? { sourceRuntime } : {}),
  });
}

function flattenResolvedHooks(resolution: ResolvedConfigDomain): HookListEntry[] {
  const counters = new Map<string, number>();
  return effectiveHookConfigEntries(resolution).flatMap((entry) =>
    entry.entries.map((hook) => {
      const scope: HookScope = entry.scope === "user" ? "global" : "project";
      const counterKey = `${scope}:${hook.event}`;
      const index = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, index);
      const synthetic = entry.name.startsWith("@legacy/");
      return {
        scope,
        event: hook.event,
        name: hook.name ?? (synthetic ? `${hook.event} handler ${index}` : entry.name),
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        command: hook.command,
        timeoutSeconds: hook.timeoutSeconds ?? 30,
        report: hook.report ?? true,
      };
    })
  );
}

function hookErrors(resolution: ResolvedConfigDomain) {
  return resolution.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

function assertHookResolutionValid(resolution: ResolvedConfigDomain): void {
  const errors = hookErrors(resolution);
  if (errors.length === 0) return;
  throw new Error(`Hook check failed: ${errors.map(formatDiagnostic).join(" | ")}`);
}

function formatDiagnostic(diagnostic: ResolvedConfigDomain["diagnostics"][number]): string {
  return `${diagnostic.source.location ?? diagnostic.source.id}: ${diagnostic.message}`;
}

function parseProjectRoot(args: string[]): string {
  let projectRoot = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--project") throw new Error(`Unknown hooks option: ${arg}`);
    const value = args[index + 1];
    if (!value) throw new Error("Usage: forgerelay hooks <list|check> [--project <path>]");
    projectRoot = resolve(value);
    index += 1;
  }
  return projectRoot;
}

function formatHookEntry(entry: HookListEntry): string {
  const matcher = formatMatcher(entry.matcher);
  return `${entry.scope} ${entry.name} ${entry.event} ${matcher} timeout=${entry.timeoutSeconds}s report=${entry.report} :: ${entry.command}`;
}

function formatMatcher(matcher: HookMatcher | undefined): string {
  if (!matcher) return "matcher=*";
  const parts = [
    matcher.tool ? `tool=${matcher.tool}` : undefined,
    matcher.commandRegex ? `commandRegex=${matcher.commandRegex}` : undefined,
    matcher.pathRegex ? `pathRegex=${matcher.pathRegex}` : undefined,
    matcher.provider ? `provider=${matcher.provider}` : undefined,
    matcher.workspaceMode ? `workspaceMode=${matcher.workspaceMode}` : undefined,
    matcher.capability ? `capability=${matcher.capability}` : undefined,
    matcher.externalServer ? `externalServer=${matcher.externalServer}` : undefined,
    matcher.externalTool ? `externalTool=${matcher.externalTool}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return parts.length > 0 ? parts.join(" ") : "matcher=*";
}

function printHooksHelp(): void {
  console.log([
    "ForgeRelay hooks",
    "",
    "Usage:",
    "  forgerelay hooks list [--project <path>]",
    "  forgerelay hooks check [--project <path>]",
  ].join("\n"));
}
