import { generalConfigDefinition } from "../definition/general-config.js";
import type { ConfigSourceInput } from "./types.js";
import { resolveConfigDomain } from "./resolver.js";

export interface GeneralConfigResolutionInput {
  env?: NodeJS.ProcessEnv;
  cli?: Record<string, unknown>;
  user?: unknown;
  userSourcePath?: string;
  project?: unknown;
  projectSourcePath?: string;
  projectLocal?: unknown;
  projectLocalSourcePath?: string;
}

export function resolveGeneralConfig(input: GeneralConfigResolutionInput = {}) {
  const env = input.env ?? process.env;
  const sources: ConfigSourceInput[] = [];

  if (input.user !== undefined) {
    sources.push({
      id: "user:config",
      scope: "user",
      kind: "file",
      location: input.userSourcePath,
      priority: 0,
      value: input.user,
    });
  }
  if (input.project !== undefined) {
    sources.push({
      id: "project:config",
      scope: "project",
      kind: "file",
      location: input.projectSourcePath,
      priority: 0,
      value: input.project,
    });
  }
  if (input.projectLocal !== undefined) {
    sources.push({
      id: "project-local:config",
      scope: "project-local",
      kind: "file",
      location: input.projectLocalSourcePath,
      priority: 0,
      value: input.projectLocal,
    });
  }

  sources.push(environmentSource(env));
  if (input.cli !== undefined) {
    sources.push({
      id: "runtime:cli",
      scope: "runtime",
      kind: "cli",
      priority: 20,
      value: input.cli,
    });
  }

  return resolveConfigDomain({
    definition: generalConfigDefinition,
    sources,
    environment: env,
  });
}

function environmentSource(env: NodeJS.ProcessEnv): ConfigSourceInput {
  const values: Record<string, unknown> = {};
  try {
    for (const [name, field] of Object.entries(generalConfigDefinition.fields)) {
      const readEnv = field.runtimeOverride?.readEnv;
      if (!readEnv) continue;
      const value = readEnv(env);
      if (value !== undefined) values[name] = value;
    }
    return {
      id: "runtime:environment",
      scope: "runtime",
      kind: "environment",
      priority: 10,
      value: values,
    };
  } catch (error) {
    return {
      id: "runtime:environment",
      scope: "runtime",
      kind: "environment",
      priority: 10,
      error: {
        code: "invalid_source",
        message: error instanceof Error ? error.message : "Runtime environment configuration is invalid.",
      },
    };
  }
}
