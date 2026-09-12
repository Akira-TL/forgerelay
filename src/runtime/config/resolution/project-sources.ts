import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProjectContext } from "../../../workspaces/state/project-context.js";
import { ConfigSourceRuntime, type ConfigSourceRefreshResult } from "../runtime/source-refresh.js";
import { resolveGeneralConfig, type GeneralConfigResolutionInput } from "./general.js";
import type { ConfigSourceInput, ResolvedConfigDomain } from "./types.js";

export interface ProjectConfigSourceOptions {
  domain: string;
  fileName: string;
}

export interface ProjectGeneralConfigResolutionInput {
  env?: NodeJS.ProcessEnv;
  cli?: Record<string, unknown>;
}

export interface LegacyUserConfigFieldRefreshResult<T> extends ConfigSourceRefreshResult<T | undefined> {
  issueScope?: "container" | "field";
}

export function refreshLegacyUserConfigField<T>(input: {
  sourceRuntime: ConfigSourceRuntime;
  configDir: string;
  field: string;
  parse: (value: unknown) => T | undefined;
  invalidMessage: string;
}): LegacyUserConfigFieldRefreshResult<T> {
  const location = join(input.configDir, "config.json");
  const refreshed = input.sourceRuntime.refreshFile<T | undefined>({
    key: `legacy-user-config:${input.field}:${location}`,
    path: location,
    parse: (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        throw new LegacyUserConfigFieldError("container");
      }
      if (!isRecord(value)) throw new LegacyUserConfigFieldError("container");
      const validation = resolveGeneralConfig({
        env: {},
        user: value,
        userSourcePath: location,
      });
      const error = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (error) throw new LegacyUserConfigFieldError("container");
      try {
        return input.parse(value[input.field]);
      } catch {
        throw new LegacyUserConfigFieldError("field");
      }
    },
    parseIssue: (error) => ({
      code: "invalid_source",
      message: error instanceof LegacyUserConfigFieldError && error.scope === "field"
        ? input.invalidMessage
        : "General configuration is invalid.",
    }),
    readIssue: {
      code: "invalid_source",
      message: "General configuration could not be read.",
    },
  });
  return {
    ...refreshed,
    ...(refreshed.issue
      ? { issueScope: refreshed.issue.message === input.invalidMessage ? "field" as const : "container" as const }
      : {}),
  };
}

class LegacyUserConfigFieldError extends Error {
  constructor(readonly scope: "container" | "field") {
    super(scope);
  }
}

export async function resolveProjectGeneralConfig(
  project: ProjectContext,
  input: ProjectGeneralConfigResolutionInput = {},
): Promise<ResolvedConfigDomain> {
  const userSource = await readJsonConfigSource({
    id: "user:config",
    scope: "user",
    location: join(project.configDir, "config.json"),
  });
  const projectSources = await loadProjectConfigSources(project, {
    domain: "config",
    fileName: "config.json",
  });
  const resolutionInput: GeneralConfigResolutionInput = {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.cli === undefined ? {} : { cli: input.cli }),
    ...(userSource === undefined ? {} : { userSource }),
  };
  const projectSource = projectSources.find((source) => source.scope === "project");
  const projectLocalSource = projectSources.find((source) => source.scope === "project-local");
  if (projectSource) resolutionInput.projectSource = projectSource;
  if (projectLocalSource) resolutionInput.projectLocalSource = projectLocalSource;
  return resolveGeneralConfig(resolutionInput);
}

export async function loadProjectConfigSources(
  project: ProjectContext,
  options: ProjectConfigSourceOptions,
): Promise<ConfigSourceInput[]> {
  const fileName = normalizeConfigFileName(options.fileName);
  const domain = normalizeDomain(options.domain);
  const sources: ConfigSourceInput[] = [];
  const projectSource = await readJsonConfigSource({
    id: `project:${domain}`,
    scope: "project",
    location: join(project.sharedConfigDir, fileName),
  });
  if (projectSource) sources.push(projectSource);

  const localSource = await readJsonConfigSource({
    id: `project-local:${domain}`,
    scope: "project-local",
    location: join(project.localConfigDir, fileName),
  });
  if (localSource) sources.push(localSource);
  return sources;
}

export async function readJsonConfigSource(input: {
  id: string;
  scope: "user" | "project" | "project-local";
  location: string;
}): Promise<ConfigSourceInput | undefined> {
  let raw: string;
  try {
    raw = await readFile(input.location, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    return {
      ...input,
      kind: "file",
      priority: 0,
      error: {
        code: "invalid_source",
        message: "Configuration source could not be read.",
      },
    };
  }

  try {
    return {
      ...input,
      kind: "file",
      priority: 0,
      value: JSON.parse(raw) as unknown,
    };
  } catch {
    return {
      ...input,
      kind: "file",
      priority: 0,
      error: {
        code: "invalid_source",
        message: "Configuration source is not valid JSON.",
      },
    };
  }
}

function normalizeConfigFileName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || basename(normalized) !== normalized) {
    throw new Error("Project configuration fileName must be one file name without path separators.");
  }
  return normalized;
}

function normalizeDomain(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error("Project configuration domain must use lowercase letters, digits, and hyphens.");
  }
  return normalized;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
