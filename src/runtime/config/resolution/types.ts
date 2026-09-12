import type {
  ConfigDeprecation,
  ConfigExecutionEffect,
  ConfigReloadPolicy,
  ConfigScope,
  ConfigSensitivity,
} from "../definition/types.js";

export type ConfigSourceKind = "cli" | "environment" | "file" | "built-in";
export type ConfigDiagnosticSeverity = "error" | "warning" | "info";
export type ConfigShadowReason = "higher-scope" | "higher-priority" | "source-shadowed";

export interface ConfigSourceReference {
  id: string;
  scope: ConfigScope;
  kind: ConfigSourceKind;
  location?: string;
  priority: number;
}

export interface ConfigSourceInput extends ConfigSourceReference {
  value?: unknown;
  /** A present canonical source may suppress lower-priority compatibility sources at the same scope. */
  shadowsLowerPriority?: boolean;
  /** Source-level deprecation used by compatibility adapters. */
  deprecation?: ConfigDeprecation;
  error?: {
    code: "invalid_source" | "missing_environment";
    message: string;
  };
}

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  code: "invalid_source" | "missing_environment" | "deprecated_source";
  source: ConfigSourceReference;
  logicalPath?: string;
  message: string;
}

export interface ConfigValueProvenance {
  source: ConfigSourceReference;
  configuredValue: unknown;
  effectiveValue: unknown;
  reload: ConfigReloadPolicy;
  sensitivity: ConfigSensitivity;
  executionEffect: ConfigExecutionEffect;
}

export interface ConfigShadowedValue extends ConfigValueProvenance {
  reason: ConfigShadowReason;
}

export interface ResolvedConfigEntry {
  logicalPath: string;
  effective: ConfigValueProvenance;
  shadowed: ConfigShadowedValue[];
  /** True when the effective keyed value is a `disabled: true` tombstone. */
  tombstone?: boolean;
}

export interface ResolvedConfigDomain {
  domain: string;
  values: Record<string, unknown>;
  entries: Record<string, ResolvedConfigEntry>;
  sources: ConfigSourceReference[];
  diagnostics: ConfigDiagnostic[];
}
