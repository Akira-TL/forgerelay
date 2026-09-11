import * as z from "zod/v4";
import { configSourceSchema, resolveExecutionEffect } from "../definition/definition.js";
import type {
  ConfigDomainDefinition,
  ConfigFieldDefinition,
  ConfigScope,
} from "../definition/types.js";
import type {
  ConfigDiagnostic,
  ConfigShadowReason,
  ConfigSourceInput,
  ConfigSourceReference,
  ConfigValueProvenance,
  ResolvedConfigDomain,
} from "./types.js";

const SCOPE_RANK: Record<ConfigScope, number> = {
  "built-in": 0,
  user: 1,
  project: 2,
  "project-local": 3,
  runtime: 4,
};

interface ResolveConfigDomainInput {
  definition: ConfigDomainDefinition;
  sources: readonly ConfigSourceInput[];
  environment?: NodeJS.ProcessEnv;
}

interface PreparedSource {
  reference: ConfigSourceReference;
  values: Record<string, unknown>;
  configuredValues: Record<string, unknown>;
}

interface Candidate {
  source: ConfigSourceReference;
  value: unknown;
  hasValue: boolean;
  configuredValue: unknown;
}

class MissingEnvironmentError extends Error {
  constructor(readonly name: string) {
    super(`Required environment variable ${name} is not available.`);
  }
}

export function resolveConfigDomain(input: ResolveConfigDomainInput): ResolvedConfigDomain {
  const environment = input.environment ?? process.env;
  const diagnostics: ConfigDiagnostic[] = [];
  const prepared: PreparedSource[] = [];

  for (const source of input.sources) {
    const reference = sourceReference(source);
    if (source.error) {
      diagnostics.push({
        severity: "error",
        code: source.error.code,
        source: reference,
        message: source.error.message,
      });
      continue;
    }

    try {
      const configured = sourceObject(source.value);
      const interpolated = interpolateSource(input.definition, source.scope, configured, environment);
      const parsed = parseSource(input.definition, source.scope, interpolated);
      prepared.push({
        reference,
        values: stripSchemaMetadata(parsed),
        configuredValues: stripSchemaMetadata(configured),
      });
    } catch (error) {
      diagnostics.push(diagnosticForSourceError(reference, error));
    }
  }

  const builtInReference: ConfigSourceReference = {
    id: `built-in:${input.definition.domain}`,
    scope: "built-in",
    kind: "built-in",
    priority: 0,
  };
  const entries: ResolvedConfigDomain["entries"] = {};
  const values: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(input.definition.fields)) {
    const logicalPath = `${input.definition.domain}.${name}`;
    const candidates = prepared
      .filter((source) => Object.prototype.hasOwnProperty.call(source.values, name))
      .map((source): Candidate => ({
        source: source.reference,
        value: source.values[name],
        hasValue: true,
        configuredValue: source.configuredValues[name],
      }));

    if (field.builtIn.kind === "literal") {
      candidates.push({
        source: builtInReference,
        value: field.builtIn.value,
        hasValue: true,
        configuredValue: field.builtIn.value,
      });
    } else if (field.builtIn.kind === "computed") {
      candidates.push({
        source: builtInReference,
        value: undefined,
        hasValue: false,
        configuredValue: `<computed: ${field.builtIn.description}>`,
      });
    }

    candidates.sort(compareCandidates);
    const winner = candidates[0];
    if (!winner) continue;

    const effective = provenanceFor(field, winner, logicalPath);
    const shadowed = candidates.slice(1).map((candidate) => ({
      ...provenanceFor(field, candidate, logicalPath),
      reason: shadowReason(winner, candidate),
    }));
    entries[name] = {
      logicalPath,
      effective,
      shadowed,
    };
    if (winner.hasValue) values[name] = winner.value;

    for (const candidate of candidates) {
      if (candidate.source.scope === "built-in" || !field.deprecation) continue;
      diagnostics.push({
        severity: "warning",
        code: "deprecated_source",
        source: candidate.source,
        logicalPath,
        message: `${logicalPath} is deprecated since ForgeRelay ${field.deprecation.since}` +
          (field.deprecation.replacement ? `; use ${field.deprecation.replacement}.` : "."),
      });
    }
  }

  const sources = [
    ...input.sources.map(sourceReference),
    builtInReference,
  ].sort(compareSourceReferences);

  return {
    domain: input.definition.domain,
    values,
    entries,
    sources,
    diagnostics,
  };
}

export function assertConfigResolutionValid(resolution: ResolvedConfigDomain): void {
  const errors = resolution.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return;
  const details = errors.map((diagnostic) => {
    const location = diagnostic.source.location ?? diagnostic.source.id;
    return `${location}: ${diagnostic.message}`;
  });
  throw new Error(`Invalid ForgeRelay ${resolution.domain} configuration: ${details.join("; ")}`);
}

function parseSource(
  definition: ConfigDomainDefinition,
  scope: ConfigScope,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (scope === "user" || scope === "project" || scope === "project-local") {
    return configSourceSchema(definition, scope).parse(value) as Record<string, unknown>;
  }
  if (scope !== "runtime") {
    throw new Error("Built-in configuration is synthesized from Config Definition metadata.");
  }

  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(definition.fields)) {
    if (field.legalScopes.includes("runtime")) shape[name] = field.schema.optional();
  }
  return z.object(shape).strict().parse(value) as Record<string, unknown>;
}

function interpolateSource(
  definition: ConfigDomainDefinition,
  scope: ConfigScope,
  configured: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const interpolated = { ...configured };
  for (const [name, field] of Object.entries(definition.fields)) {
    if (!field.legalScopes.includes(scope) || field.interpolation !== "env") continue;
    if (!Object.prototype.hasOwnProperty.call(interpolated, name)) continue;
    interpolated[name] = interpolateValue(interpolated[name], environment);
  }
  return interpolated;
}

function interpolateValue(value: unknown, environment: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined) throw new MissingEnvironmentError(name);
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => interpolateValue(entry, environment));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, environment)]),
    );
  }
  return value;
}

function provenanceFor(
  field: ConfigFieldDefinition,
  candidate: Candidate,
  logicalPath: string,
): ConfigValueProvenance {
  const executionEffect = candidate.hasValue
    ? resolveExecutionEffect(field, candidate.value, logicalPath.split("."))
    : typeof field.executionEffect === "string"
      ? field.executionEffect
      : "none";
  return {
    source: candidate.source,
    configuredValue: safeConfiguredValue(field, candidate.configuredValue),
    effectiveValue: candidate.hasValue
      ? safeValue(field, candidate.value)
      : candidate.configuredValue,
    reload: field.reload,
    sensitivity: field.sensitivity,
    executionEffect,
  };
}

function safeConfiguredValue(field: ConfigFieldDefinition, value: unknown): unknown {
  if (field.sensitivity !== "sensitive") return structuredClone(value);
  if (field.interpolation === "env") return preserveEnvironmentReferences(value);
  return "<redacted>";
}

function safeValue(field: ConfigFieldDefinition, value: unknown): unknown {
  if (field.sensitivity === "sensitive") return "<redacted>";
  return structuredClone(value);
}

function preserveEnvironmentReferences(value: unknown): unknown {
  if (typeof value === "string") {
    return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ? value : "<redacted>";
  }
  if (Array.isArray(value)) return value.map((entry) => preserveEnvironmentReferences(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, preserveEnvironmentReferences(entry)]),
    );
  }
  return "<redacted>";
}

function diagnosticForSourceError(
  source: ConfigSourceReference,
  error: unknown,
): ConfigDiagnostic {
  if (error instanceof MissingEnvironmentError) {
    return {
      severity: "error",
      code: "missing_environment",
      source,
      message: `Required environment variable ${error.name} is not available.`,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      severity: "error",
      code: "invalid_source",
      source,
      message: error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "config";
        return `${path}: ${issue.message}`;
      }).join("; "),
    };
  }
  return {
    severity: "error",
    code: "invalid_source",
    source,
    message: error instanceof Error ? error.message : "Configuration source is invalid.",
  };
}

function sourceObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Configuration source must be a JSON object.");
  return value;
}

function stripSchemaMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = value;
  return rest;
}

function sourceReference(source: ConfigSourceInput): ConfigSourceReference {
  return {
    id: source.id,
    scope: source.scope,
    kind: source.kind,
    ...(source.location ? { location: source.location } : {}),
    priority: source.priority,
  };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return compareSourceReferences(left.source, right.source);
}

function compareSourceReferences(left: ConfigSourceReference, right: ConfigSourceReference): number {
  const scope = SCOPE_RANK[right.scope] - SCOPE_RANK[left.scope];
  if (scope !== 0) return scope;
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  return left.id.localeCompare(right.id);
}

function shadowReason(winner: Candidate, candidate: Candidate): ConfigShadowReason {
  return winner.source.scope === candidate.source.scope ? "higher-priority" : "higher-scope";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
