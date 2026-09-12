import type * as z from "zod/v4";

export const CONFIG_SCHEMA_CONTRACT_MAJOR = 1 as const;

export type ConfigScope = "runtime" | "project-local" | "project" | "user" | "built-in";
export type ConfigFileScope = Extract<ConfigScope, "project-local" | "project" | "user">;
export type ConfigMergeStrategy = "replace" | "keyed" | "append";
export type ConfigReloadPolicy = "hot" | "restart-required";
export type ConfigSensitivity = "public" | "sensitive";
export type ConfigInterpolation = "none" | "env";
export type ConfigExecutionEffect = "none" | "process";
export type ConfigFileShape =
  | { kind: "object" }
  | { kind: "keyed-root"; field: string }
  | {
      kind: "keyed-entry";
      field: string;
      fileSchema: z.ZodType;
      normalizeEntry?: (value: unknown) => unknown;
    };

export const CONFIG_FILE_SCOPES = ["user", "project-local", "project"] as const satisfies readonly ConfigFileScope[];

export interface ConfigRuntimeOverride<T = unknown> {
  cli?: string;
  env?: string | readonly string[];
  readEnv?: (env: NodeJS.ProcessEnv) => T | undefined;
}

export interface ConfigDeprecation {
  since: string;
  removeIn?: string;
  replacement?: string;
}

export type ConfigBuiltInDefault<T = unknown> =
  | { kind: "literal"; value: T }
  | { kind: "computed"; description: string }
  | { kind: "none" };

export type ConfigExecutionEffectResolver<T = unknown> = (
  value: T,
  logicalPath: readonly string[],
) => ConfigExecutionEffect;

export type ConfigValueInterpolator<T = unknown> = (
  value: T,
  environment: NodeJS.ProcessEnv,
) => T;

export interface ConfigFieldDefinition<TSchema extends z.ZodType = z.ZodType> {
  schema: TSchema;
  description: string;
  /** File-backed domains may require a field whenever the domain source exists. */
  required?: boolean;
  legalScopes: readonly ConfigScope[];
  merge: ConfigMergeStrategy;
  reload: ConfigReloadPolicy;
  sensitivity: ConfigSensitivity;
  interpolation: ConfigInterpolation;
  interpolateValue?: ConfigValueInterpolator<z.input<TSchema>>;
  builtIn: ConfigBuiltInDefault<z.input<TSchema>>;
  executionEffect: ConfigExecutionEffect | ConfigExecutionEffectResolver<z.output<TSchema>>;
  runtimeOverride?: ConfigRuntimeOverride<z.output<TSchema>>;
  deprecation?: ConfigDeprecation;
}

export type ConfigFieldMap = Record<string, ConfigFieldDefinition<any>>;

export interface ConfigDomainDefinition<TFields extends ConfigFieldMap = ConfigFieldMap> {
  domain: string;
  title: string;
  description: string;
  /** Defaults to an object whose properties are the declared fields. */
  fileShape?: ConfigFileShape;
  fields: TFields;
}
