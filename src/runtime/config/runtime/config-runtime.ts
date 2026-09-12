import { createHash } from "node:crypto";
import type { ConfigDomainDefinition } from "../definition/types.js";
import { ConfigSourceRuntime } from "./source-refresh.js";

export interface ConfigAppliedFieldState {
  logicalPath: string;
  configuredValue: unknown;
  appliedValue: unknown;
  restartRequired: boolean;
}

export interface ConfigAppliedDomainState {
  domain: string;
  restartRequired: boolean;
  fields: Record<string, ConfigAppliedFieldState>;
}

export interface ConfigRuntimeResolutionInputs {
  environment: NodeJS.ProcessEnv;
  cli?: Record<string, unknown>;
}

export class ConfigRuntime {
  readonly sources = new ConfigSourceRuntime();
  private readonly applied = new Map<string, Map<string, unknown>>();
  private readonly resolutionInputs = new Map<string, ConfigRuntimeResolutionInputs>();

  captureResolutionInputs(
    domain: string,
    inputs: ConfigRuntimeResolutionInputs,
  ): void {
    this.resolutionInputs.set(domain, {
      environment: { ...inputs.environment },
      ...(inputs.cli ? { cli: structuredClone(inputs.cli) } : {}),
    });
  }

  resolutionInputsFor(domain: string): ConfigRuntimeResolutionInputs {
    const inputs = this.resolutionInputs.get(domain);
    if (!inputs) throw new Error(`No runtime resolution inputs are available for ${domain}.`);
    return {
      environment: { ...inputs.environment },
      ...(inputs.cli ? { cli: structuredClone(inputs.cli) } : {}),
    };
  }

  captureApplied(
    definition: ConfigDomainDefinition,
    values: Record<string, unknown>,
  ): void {
    const domain = new Map<string, unknown>();
    for (const [name, field] of Object.entries(definition.fields)) {
      if (field.reload !== "restart-required") continue;
      domain.set(name, structuredClone(values[name]));
    }
    this.applied.set(definition.domain, domain);
  }

  snapshotApplied(
    definition: ConfigDomainDefinition,
    configuredValues: Record<string, unknown>,
  ): ConfigAppliedDomainState {
    const startup = this.applied.get(definition.domain);
    if (!startup) {
      throw new Error(`No applied configuration snapshot is available for ${definition.domain}.`);
    }
    const fields: Record<string, ConfigAppliedFieldState> = {};
    let restartRequired = false;
    for (const [name, field] of Object.entries(definition.fields)) {
      if (field.reload !== "restart-required") continue;
      const appliedValue = startup.get(name);
      const configuredValue = configuredValues[name];
      const changed = valueFingerprint(appliedValue) !== valueFingerprint(configuredValue);
      restartRequired ||= changed;
      fields[name] = {
        logicalPath: `${definition.domain}.${name}`,
        configuredValue: safeValue(field.sensitivity, configuredValue),
        appliedValue: safeValue(field.sensitivity, appliedValue),
        restartRequired: changed,
      };
    }
    return { domain: definition.domain, restartRequired, fields };
  }
}

function safeValue(sensitivity: string, value: unknown): unknown {
  if (sensitivity === "sensitive" && value !== undefined) return "<redacted>";
  return structuredClone(value);
}

function valueFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "undefined";
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}
