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
  /** Stable key for one file-backed entry in a keyed-entry directory domain. */
  entryKey?: string;
  /** Compatibility adapters may provide an already normalized field-object; resolver validation still applies. */
  normalized?: boolean;
  /** A present canonical source may suppress all lower-priority compatibility sources at the same scope. */
  shadowsLowerPriority?: boolean;
  /** Keyed domains may suppress only these same-scope, lower-priority entry paths (for example `hooks.release`). */
  shadowsLowerPriorityKeys?: readonly string[];
  /** Source-level deprecation used by compatibility adapters. */
  deprecation?: ConfigDeprecation;
  error?: {
    code: "invalid_source" | "missing_environment";
    message: string;
  };
}

export interface ConfigDiagnostic {
  severity: ConfigDiagnosticSeverity;
  code: "invalid_source" | "missing_environment" | "deprecated_source" | "schema_mismatch";
  source: ConfigSourceReference;
  logicalPath?: string;
  message: string;
  /** Live runtime only: the invalid observed revision is currently falling back to in-process LKG. */
  usingLastKnownGood?: boolean;
  /** Live runtime only: true only when this invalid observed fingerprint changed since the prior demand refresh. */
  diagnosticChanged?: boolean;
}

export interface ConfigValueProvenance {
  source: ConfigSourceReference;
  configuredValue: unknown;
  effectiveValue: unknown;
  reload: ConfigReloadPolicy;
  sensitivity: ConfigSensitivity;
  executionEffect: ConfigExecutionEffect;
  /** Opaque identity of the resolved executable value. Present only when executionEffect=process. */
  executionFingerprint?: string;
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
