import { generalConfigDefinition } from "../definition/general-config.js";
import type { ConfigSourceInput } from "./types.js";
import { resolveConfigDomain } from "./resolver.js";

export interface GeneralConfigResolutionInput {
  env?: NodeJS.ProcessEnv;
  cli?: Record<string, unknown>;
  user?: unknown;
  userSourcePath?: string;
  userSource?: ConfigSourceInput;
  project?: unknown;
  projectSourcePath?: string;
  projectSource?: ConfigSourceInput;
  projectLocal?: unknown;
  projectLocalSourcePath?: string;
  projectLocalSource?: ConfigSourceInput;
}

export function resolveGeneralConfig(input: GeneralConfigResolutionInput = {}) {
  const env = input.env ?? process.env;
  const sources: ConfigSourceInput[] = [];

  appendFileSource(sources, {
    expectedScope: "user",
    prepared: input.userSource,
    value: input.user,
    sourcePath: input.userSourcePath,
  });
  appendFileSource(sources, {
    expectedScope: "project",
    prepared: input.projectSource,
    value: input.project,
    sourcePath: input.projectSourcePath,
  });
  appendFileSource(sources, {
    expectedScope: "project-local",
    prepared: input.projectLocalSource,
    value: input.projectLocal,
    sourcePath: input.projectLocalSourcePath,
  });

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

function appendFileSource(
  sources: ConfigSourceInput[],
  input: {
    expectedScope: "user" | "project" | "project-local";
    prepared?: ConfigSourceInput;
    value?: unknown;
    sourcePath?: string;
  },
): void {
  if (input.prepared !== undefined && input.value !== undefined) {
    throw new Error(`General configuration received duplicate ${input.expectedScope} sources.`);
  }
  if (input.prepared !== undefined) {
    if (input.prepared.scope !== input.expectedScope || input.prepared.kind !== "file") {
      throw new Error(`General configuration ${input.expectedScope} source must be a file source at the matching scope.`);
    }
    sources.push(input.prepared);
    return;
  }
  if (input.value === undefined) return;
  sources.push({
    id: `${input.expectedScope}:config`,
    scope: input.expectedScope,
    kind: "file",
    location: input.sourcePath,
    priority: 0,
    value: input.value,
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
