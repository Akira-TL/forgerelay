import { resolve } from "node:path";
import {
  HOOK_EVENTS,
  loadProjectHookConfig,
  mergeHookConfigs,
  parseHookConfig,
  type HookConfig,
  type HookEvent,
  type HookMatcher,
} from "./hooks.js";
import { loadForgeRelayFiles } from "./user-config.js";

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

export async function runHooksCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) {
    printHooksHelp();
    return;
  }

  const projectRoot = parseProjectRoot(rest);
  const globalHooks = loadGlobalHooks();
  const project = await loadProjectHookConfig(projectRoot);
  const globalEntries = flattenHooks(globalHooks, "global");
  const projectEntries = flattenHooks(project.hooks, "project");

  if (subcommand === "list") {
    for (const entry of [...globalEntries, ...projectEntries]) {
      console.log(formatHookEntry(entry));
    }
    if (globalEntries.length === 0 && projectEntries.length === 0) {
      console.log("No hooks configured.");
    }
    if (project.diagnostic) {
      console.error(`Project hooks diagnostic: ${project.diagnostic}`);
    }
    return;
  }

  if (subcommand === "check") {
    if (project.diagnostic) {
      throw new Error(`Hook check failed: ${project.diagnostic}`);
    }
    console.log(`Hooks OK: ${globalEntries.length} global, ${projectEntries.length} project`);
    return;
  }

  throw new Error(`Unknown hooks command: ${subcommand}`);
}

function loadGlobalHooks(): HookConfig {
  const files = loadForgeRelayFiles();
  return mergeHookConfigs(
    parseHookConfig(files.config.hooks),
    parseHookConfig(files.hooks),
    files.hookFiles,
  );
}

function parseProjectRoot(args: string[]): string {
  let projectRoot = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--project") {
      throw new Error(`Unknown hooks option: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error("Usage: forgerelay hooks <list|check> [--project <path>]");
    projectRoot = resolve(value);
    index += 1;
  }
  return projectRoot;
}

function flattenHooks(config: HookConfig, scope: HookScope): HookListEntry[] {
  const entries: HookListEntry[] = [];
  for (const event of HOOK_EVENTS) {
    let handlerIndex = 0;
    for (const rule of config[event] ?? []) {
      for (const handler of rule.handlers) {
        handlerIndex += 1;
        entries.push({
          scope,
          event,
          name: handler.name ?? `${event} handler ${handlerIndex}`,
          matcher: rule.matcher,
          command: handler.command,
          timeoutSeconds: handler.timeoutSeconds,
          report: handler.report,
        });
      }
    }
  }
  return entries;
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
