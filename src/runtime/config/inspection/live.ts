import type { ServerConfig } from "../config.js";
import { liveGeneralConfigState } from "../config.js";
import { ExternalMcpConfigRegistry } from "../external-mcp-registry.js";
import { resolveHooksConfig } from "../resolution/hooks.js";
import { resolveLanguageServersConfig } from "../resolution/language-servers.js";
import type { ConfigDiagnostic, ResolvedConfigDomain } from "../resolution/types.js";
import { resolveSubagentProfilesConfigSources } from "../../../subagents/profiles.js";
import { resolveProjectContext } from "../../../workspaces/state/project-context.js";

export interface LiveConfigIssue {
  domain: string;
  severity: "error";
  code: string;
  source: string;
  usingLastKnownGood: boolean;
  message: string;
}

export interface LiveConfigPanelState {
  restartRequired?: Array<{
    logicalPath: string;
    configuredValue: unknown;
    appliedValue: unknown;
  }>;
  source?: {
    state: "invalid";
    usingLastKnownGood: boolean;
    message: string;
  };
  issues?: LiveConfigIssue[];
}

export async function liveWorkspaceConfigPanelState(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<LiveConfigPanelState | undefined> {
  const general = liveGeneralConfigState(config);
  const restartRequired = Object.values(general.applied.fields)
    .filter((field) => field.restartRequired)
    .map((field) => ({
      logicalPath: field.logicalPath,
      configuredValue: field.configuredValue,
      appliedValue: field.appliedValue,
    }));

  const project = await resolveProjectContext(config.configDir, workspaceRoot);
  const mcp = new ExternalMcpConfigRegistry({
    configDir: config.configDir,
    legacyServers: config.mcpServers,
    environment: process.env,
    sourceRuntime: config.configRuntime.sources,
  }).resolveConfiguration({
    projectSharedConfigDir: project.sharedConfigDir,
    projectLocalConfigDir: project.localConfigDir,
  });
  const languageServers = await resolveLanguageServersConfig({
    configDir: config.configDir,
    project,
    legacyUser: config.languageServers,
    environment: process.env,
    sourceRuntime: config.configRuntime.sources,
  });
  const hooks = await resolveHooksConfig({
    configDir: config.configDir,
    project,
    legacyUser: config.hooks,
    sourceRuntime: config.configRuntime.sources,
  });
  const subagents = resolveSubagentProfilesConfigSources({
    configDir: config.configDir,
    sourceRuntime: config.configRuntime.sources,
    projectSharedConfigDir: project.sharedConfigDir,
    projectLocalConfigDir: project.localConfigDir,
  });
  const issues = uniqueLiveIssues([mcp, languageServers, hooks, subagents]);

  if (restartRequired.length === 0 && !general.source && issues.length === 0) return undefined;
  return {
    ...(restartRequired.length > 0 ? { restartRequired } : {}),
    ...(general.source ? { source: general.source } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

function uniqueLiveIssues(domains: ResolvedConfigDomain[]): LiveConfigIssue[] {
  const seen = new Set<string>();
  const issues: LiveConfigIssue[] = [];
  for (const domain of domains) {
    for (const diagnostic of domain.diagnostics) {
      if (diagnostic.severity !== "error") continue;
      const issue = liveIssue(domain.domain, diagnostic);
      const key = `${issue.domain}\0${issue.code}\0${issue.source}\0${issue.message}\0${issue.usingLastKnownGood}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }
  return issues.sort((left, right) =>
    left.domain.localeCompare(right.domain) || left.source.localeCompare(right.source) || left.code.localeCompare(right.code)
  );
}

function liveIssue(domain: string, diagnostic: ConfigDiagnostic): LiveConfigIssue {
  return {
    domain,
    severity: "error",
    code: diagnostic.code,
    source: diagnostic.source.location ?? diagnostic.source.id,
    usingLastKnownGood: diagnostic.usingLastKnownGood === true,
    message: diagnostic.message,
  };
}
