import { join, resolve } from "node:path";
import { forgerelayConfigDir } from "../../runtime/config/user-config.js";
import { ExternalMcpConfigRegistry } from "../../runtime/config/external-mcp-registry.js";
import { resolveGeneralConfig } from "../../runtime/config/resolution/general.js";
import { resolveHooksConfig } from "../../runtime/config/resolution/hooks.js";
import { resolveLanguageServersConfig } from "../../runtime/config/resolution/language-servers.js";
import { readJsonConfigSource } from "../../runtime/config/resolution/project-sources.js";
import { ConfigSourceRuntime } from "../../runtime/config/runtime/source-refresh.js";
import { resolveSubagentProfilesConfigSources } from "../../subagents/profiles.js";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";
import type {
  ConfigDiagnostic,
  ConfigShadowedValue,
  ConfigSourceReference,
  ConfigValueProvenance,
  ResolvedConfigDomain,
} from "../../runtime/config/resolution/types.js";

export type ConfigInspectionCommand = "check" | "sources" | "explain";
type ConfigInspectionScope =
  | { mode: "global" }
  | { mode: "project"; projectRoot: string };

interface ConfigInspectionOptions {
  command: ConfigInspectionCommand;
  json: boolean;
  scope: ConfigInspectionScope;
  logicalPath?: string;
}

interface InspectionDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  domain: string;
  logicalPath?: string;
  source: ConfigSourceReference;
  message: string;
}

interface ConfigCheckOutput {
  version: 1;
  command: "check";
  scope: ConfigInspectionScope;
  liveState: typeof OFFLINE_LIVE_STATE;
  summary: { errors: number; warnings: number; info: number };
  diagnostics: InspectionDiagnostic[];
}

interface ConfigSourceInspection {
  domain: string;
  id: string;
  scope: ConfigSourceReference["scope"];
  kind: ConfigSourceReference["kind"];
  location?: string;
  priority: number;
  state: "valid" | "invalid";
  roles: Array<"effective" | "shadowed" | "diagnostic" | "legacy" | "runtime" | "built-in">;
}

interface ConfigSourcesOutput {
  version: 1;
  command: "sources";
  scope: ConfigInspectionScope;
  liveState: typeof OFFLINE_LIVE_STATE;
  summary: { errors: number; warnings: number; info: number };
  diagnostics: InspectionDiagnostic[];
  sources: ConfigSourceInspection[];
}

interface ConfigExplainOutput {
  version: 1;
  command: "explain";
  scope: ConfigInspectionScope;
  liveState: typeof OFFLINE_LIVE_STATE;
  logicalPath: string;
  domain: string;
  effective: ConfigValueProvenance;
  shadowed: ConfigShadowedValue[];
  tombstone: boolean;
  diagnostics: InspectionDiagnostic[];
}

const OFFLINE_LIVE_STATE = {
  mode: "offline",
  lastKnownGood: "unknown",
  appliedValues: "unknown",
} as const;

export async function runConfigInspection(args: string[]): Promise<number> {
  let options: ConfigInspectionOptions;
  try {
    options = parseInspectionArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let domains: ResolvedConfigDomain[];
  try {
    domains = await resolveInspectionDomains(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const diagnostics = domains.flatMap((domain) => [
    ...domain.diagnostics.map((diagnostic) => inspectionDiagnostic(domain.domain, diagnostic)),
    ...shadowDiagnostics(domain),
  ]);
  const summary = summarizeDiagnostics(diagnostics);
  if (options.command === "explain") {
    const match = findEntry(domains, options.logicalPath!);
    if (!match) {
      console.error(`Unknown configuration logical path: ${options.logicalPath}.`);
      return 2;
    }
    const relatedSourceIds = new Set([
      match.entry.effective.source.id,
      ...match.entry.shadowed.map((shadowed) => shadowed.source.id),
    ]);
    const relatedDiagnostics = diagnostics.filter((diagnostic) =>
      diagnostic.logicalPath === options.logicalPath || relatedSourceIds.has(diagnostic.source.id)
    );
    const output: ConfigExplainOutput = {
      version: 1,
      command: "explain",
      scope: options.scope,
      liveState: OFFLINE_LIVE_STATE,
      logicalPath: options.logicalPath!,
      domain: match.domain.domain,
      effective: match.entry.effective,
      shadowed: match.entry.shadowed,
      tombstone: match.entry.tombstone === true,
      diagnostics: relatedDiagnostics,
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else printExplain(output);
    return relatedDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
  }
  if (options.command === "sources") {
    const output: ConfigSourcesOutput = {
      version: 1,
      command: "sources",
      scope: options.scope,
      liveState: OFFLINE_LIVE_STATE,
      summary,
      diagnostics,
      sources: inspectSources(domains),
    };
    if (options.json) console.log(JSON.stringify(output, null, 2));
    else printSources(output);
    return summary.errors > 0 ? 1 : 0;
  }
  const output: ConfigCheckOutput = {
    version: 1,
    command: "check",
    scope: options.scope,
    liveState: OFFLINE_LIVE_STATE,
    summary,
    diagnostics,
  };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printCheck(output);
  return summary.errors > 0 ? 1 : 0;
}

function parseInspectionArgs(args: string[]): ConfigInspectionOptions {
  const [command, ...rest] = args;
  if (command !== "check" && command !== "sources" && command !== "explain") {
    throw new Error("Expected config check, config sources, or config explain <logical-path>.");
  }
  let json = false;
  let global = false;
  let projectRoot: string | undefined;
  let logicalPath: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--json") {
      if (json) throw new Error("--json may only be supplied once.");
      json = true;
      continue;
    }
    if (arg === "--global") {
      if (global || projectRoot) throw new Error("--global and --project cannot be used together or repeated.");
      global = true;
      continue;
    }
    if (arg === "--project") {
      if (global || projectRoot) throw new Error("--global and --project cannot be used together or repeated.");
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--project requires a project path.");
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    if (command === "explain" && logicalPath === undefined && !arg.startsWith("--")) {
      logicalPath = arg;
      continue;
    }
    throw new Error(`Unknown config ${command} option: ${arg}`);
  }
  if (command === "explain" && !logicalPath) throw new Error("config explain requires a logical path.");
  return {
    command,
    json,
    scope: global
      ? { mode: "global" }
      : { mode: "project", projectRoot: projectRoot ?? resolve(process.env.FORGERELAY_WORKSPACE_ROOT ?? process.cwd()) },
    ...(logicalPath ? { logicalPath } : {}),
  };
}

async function resolveInspectionDomains(options: ConfigInspectionOptions): Promise<ResolvedConfigDomain[]> {
  const configDir = forgerelayConfigDir();
  const sourceRuntime = new ConfigSourceRuntime();
  const userSource = await readJsonConfigSource({
    id: "user:config",
    scope: "user",
    location: join(configDir, "config.json"),
  });
  const project = options.scope.mode === "project"
    ? await new ProjectContextResolver(configDir).inspect(options.scope.projectRoot)
    : undefined;
  const projectSource = project
    ? await readJsonConfigSource({
        id: "project:config",
        scope: "project",
        location: join(project.sharedConfigDir, "config.json"),
      })
    : undefined;
  const projectLocalSource = project?.localConfigDir
    ? await readJsonConfigSource({
        id: "project-local:config",
        scope: "project-local",
        location: join(project.localConfigDir, "config.json"),
      })
    : undefined;
  const general = resolveGeneralConfig({
    env: process.env,
    ...(userSource ? { userSource } : {}),
    ...(projectSource ? { projectSource } : {}),
    ...(projectLocalSource ? { projectLocalSource } : {}),
  });
  const mcp = new ExternalMcpConfigRegistry({
    configDir,
    environment: process.env,
    sourceRuntime,
  }).resolveConfiguration({
    ...(project ? { projectSharedConfigDir: project.sharedConfigDir } : {}),
    ...(project?.localConfigDir ? { projectLocalConfigDir: project.localConfigDir } : {}),
  });
  const languageServers = await resolveLanguageServersConfig({
    configDir,
    environment: process.env,
    sourceRuntime,
    ...(project?.localConfigDir
      ? { project: { sharedConfigDir: project.sharedConfigDir, localConfigDir: project.localConfigDir } }
      : project
        ? { projectSharedConfigDir: project.sharedConfigDir }
        : {}),
  });
  const hooks = await resolveHooksConfig({
    configDir,
    sourceRuntime,
    ...(project?.localConfigDir
      ? { project: { sharedConfigDir: project.sharedConfigDir, localConfigDir: project.localConfigDir } }
      : project
        ? { projectSharedConfigDir: project.sharedConfigDir }
        : {}),
  });
  const subagents = resolveSubagentProfilesConfigSources({
    configDir,
    sourceRuntime,
    ...(project ? { projectSharedConfigDir: project.sharedConfigDir } : {}),
    ...(project?.localConfigDir ? { projectLocalConfigDir: project.localConfigDir } : {}),
  });
  return [general, mcp, languageServers, hooks, subagents];
}

function shadowDiagnostics(domain: ResolvedConfigDomain): InspectionDiagnostic[] {
  return Object.values(domain.entries).flatMap((entry) =>
    entry.shadowed.map((shadowed): InspectionDiagnostic => ({
      severity: shadowed.reason === "source-shadowed" ? "warning" : "info",
      code: shadowed.reason === "source-shadowed" ? "source_shadowed" : "shadowed_value",
      domain: domain.domain,
      logicalPath: entry.logicalPath,
      source: shadowed.source,
      message: shadowed.reason === "source-shadowed"
        ? `${entry.logicalPath} from ${shadowed.source.id} is suppressed by a canonical compatibility source.`
        : `${entry.logicalPath} from ${shadowed.source.id} is shadowed by ${entry.effective.source.id} (${shadowed.reason}).`,
    }))
  );
}

function inspectionDiagnostic(domain: string, diagnostic: ConfigDiagnostic): InspectionDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    domain,
    ...(diagnostic.logicalPath ? { logicalPath: diagnostic.logicalPath } : {}),
    source: diagnostic.source,
    message: diagnostic.message,
  };
}

function summarizeDiagnostics(diagnostics: InspectionDiagnostic[]) {
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    info: diagnostics.filter((diagnostic) => diagnostic.severity === "info").length,
  };
}

function findEntry(domains: ResolvedConfigDomain[], logicalPath: string) {
  for (const domain of domains) {
    const entry = Object.values(domain.entries).find((candidate) => candidate.logicalPath === logicalPath);
    if (entry) return { domain, entry };
  }
  return undefined;
}

function inspectSources(domains: ResolvedConfigDomain[]): ConfigSourceInspection[] {
  return domains.flatMap((domain) => {
    const roles = new Map<string, Set<ConfigSourceInspection["roles"][number]>>();
    const roleSet = (id: string) => {
      const existing = roles.get(id);
      if (existing) return existing;
      const created = new Set<ConfigSourceInspection["roles"][number]>();
      roles.set(id, created);
      return created;
    };
    for (const entry of Object.values(domain.entries)) {
      roleSet(entry.effective.source.id).add("effective");
      for (const shadowed of entry.shadowed) roleSet(shadowed.source.id).add("shadowed");
    }
    for (const diagnostic of domain.diagnostics) roleSet(diagnostic.source.id).add("diagnostic");
    return domain.sources.flatMap((source): ConfigSourceInspection[] => {
      const sourceRoles = roleSet(source.id);
      if (source.id.startsWith("legacy:")) sourceRoles.add("legacy");
      if (source.kind === "environment" || source.kind === "cli") sourceRoles.add("runtime");
      if (source.kind === "built-in") sourceRoles.add("built-in");
      const meaningful = source.kind === "file" || sourceRoles.has("effective") || sourceRoles.has("shadowed") || sourceRoles.has("diagnostic");
      if (!meaningful) return [];
      const invalid = domain.diagnostics.some((diagnostic) =>
        diagnostic.source.id === source.id && diagnostic.severity === "error"
      );
      return [{
        domain: domain.domain,
        id: source.id,
        scope: source.scope,
        kind: source.kind,
        ...(source.location ? { location: source.location } : {}),
        priority: source.priority,
        state: invalid ? "invalid" : "valid",
        roles: [...sourceRoles].sort(),
      }];
    });
  }).sort((left, right) =>
    left.domain.localeCompare(right.domain) || left.id.localeCompare(right.id)
  );
}

function printExplain(output: ConfigExplainOutput): void {
  console.log(`Config explain ${output.logicalPath}`);
  console.log(`Effective source: ${output.effective.source.id}`);
  console.log(`Configured value: ${formatValue(output.effective.configuredValue)}`);
  console.log(`Effective value: ${formatValue(output.effective.effectiveValue)}`);
  console.log(`Reload: ${output.effective.reload}`);
  console.log(`Execution effect: ${output.effective.executionEffect}`);
  for (const shadowed of output.shadowed) {
    console.log(`Shadowed: ${shadowed.source.id} (${shadowed.reason})`);
  }
  if (output.diagnostics.length > 0) {
    console.log("Diagnostics:");
    for (const diagnostic of output.diagnostics) {
      const location = diagnostic.source.location ?? diagnostic.source.id;
      console.log(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${location}: ${diagnostic.message}`);
    }
  }
  console.log("Live runtime state: unknown (offline inspection; in-memory last-known-good and running applied values are unavailable).");
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function printSources(output: ConfigSourcesOutput): void {
  console.log(`Config sources (${output.scope.mode})`);
  for (const source of output.sources) {
    console.log(`${source.domain} ${source.id} · ${source.state} · ${source.roles.join(", ")}` +
      (source.location ? ` · ${source.location}` : ""));
  }
  console.log("Live runtime state: unknown (offline inspection; in-memory last-known-good and running applied values are unavailable).");
}

function printCheck(output: ConfigCheckOutput): void {
  console.log(`Config check (${output.scope.mode})`);
  for (const diagnostic of output.diagnostics) {
    const location = diagnostic.source.location ?? diagnostic.source.id;
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.domain} ${location}: ${diagnostic.message}`);
  }
  console.log(`Summary: ${output.summary.errors} error(s), ${output.summary.warnings} warning(s), ${output.summary.info} info`);
  console.log("Live runtime state: unknown (offline inspection; in-memory last-known-good and running applied values are unavailable).");
}
