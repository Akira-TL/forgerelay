import * as z from "zod/v4";
import {
  CONFIG_FILE_SCOPES,
  type ConfigDomainDefinition,
  type ConfigExecutionEffect,
  type ConfigFieldDefinition,
  type ConfigFieldMap,
  type ConfigFileScope,
  type ConfigScope,
} from "./types.js";

const DOMAIN_PATTERN = /^[a-z][a-z0-9-]*$/;
const FILE_SCOPE_SET = new Set<ConfigFileScope>(CONFIG_FILE_SCOPES);

export function defineConfigDomain<const TFields extends ConfigFieldMap>(
  definition: ConfigDomainDefinition<TFields>,
): ConfigDomainDefinition<TFields> {
  if (!DOMAIN_PATTERN.test(definition.domain)) {
    throw new Error(`Invalid config domain name: ${definition.domain}`);
  }
  if (!definition.title.trim()) {
    throw new Error(`Config domain ${definition.domain} requires a title.`);
  }
  if (!definition.description.trim()) {
    throw new Error(`Config domain ${definition.domain} requires a description.`);
  }

  for (const [name, field] of Object.entries(definition.fields)) {
    validateFieldDefinition(definition.domain, name, field);
  }
  validateFileShape(definition);
  return definition;
}

export function configSourceSchema(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): z.ZodObject<Record<string, z.ZodType>> {
  if (!FILE_SCOPE_SET.has(scope)) throw new Error(`Scope ${scope} is not a file-backed config scope.`);

  const shape: Record<string, z.ZodType> = {
    $schema: z.string().optional().describe("Editor-only JSON Schema URL. Ignored by ForgeRelay resolution."),
  };
  for (const [name, field] of Object.entries(definition.fields)) {
    if (!field.legalScopes.includes(scope)) continue;
    const schema = field.required ? field.schema : field.schema.optional();
    shape[name] = schema.describe(field.description);
  }
  return z.object(shape).strict();
}

export function normalizeConfigSourceShape(
  definition: ConfigDomainDefinition,
  scope: ConfigScope,
  value: unknown,
): unknown {
  const fileShape = definition.fileShape;
  if (
    !fileShape ||
    fileShape.kind !== "keyed-root" ||
    !FILE_SCOPE_SET.has(scope as ConfigFileScope) ||
    !isRecord(value)
  ) {
    return value;
  }
  const { $schema, ...entries } = value;
  return {
    ...($schema === undefined ? {} : { $schema }),
    [fileShape.field]: entries,
  };
}

export function parseConfigSource(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
  value: unknown,
): Record<string, unknown> {
  return configSourceSchema(definition, scope).parse(
    normalizeConfigSourceShape(definition, scope, value),
  ) as Record<string, unknown>;
}

export function resolveExecutionEffect<TSchema extends z.ZodType>(
  field: ConfigFieldDefinition<TSchema>,
  value: z.output<TSchema>,
  logicalPath: readonly string[],
): ConfigExecutionEffect {
  return typeof field.executionEffect === "function"
    ? field.executionEffect(value, logicalPath)
    : field.executionEffect;
}

function validateFileShape(definition: ConfigDomainDefinition): void {
  const fileShape = definition.fileShape;
  if (!fileShape || fileShape.kind === "object") return;
  const rootField = definition.fields[fileShape.field];
  if (!rootField) {
    throw new Error(`Config domain ${definition.domain} keyed-root field ${fileShape.field} is not defined.`);
  }
  if (rootField.merge !== "keyed") {
    throw new Error(`Config domain ${definition.domain} keyed-root field ${fileShape.field} must use keyed merge.`);
  }
  const otherFileFields = Object.entries(definition.fields).filter(([name, field]) =>
    name !== fileShape.field &&
    field.legalScopes.some((scope) => FILE_SCOPE_SET.has(scope as ConfigFileScope))
  );
  if (otherFileFields.length > 0) {
    throw new Error(`Config domain ${definition.domain} keyed-root shape cannot expose additional file-backed fields.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFieldDefinition(domain: string, name: string, field: ConfigFieldDefinition): void {
  if (name === "$schema") {
    throw new Error(`Config domain ${domain} cannot define reserved field $schema.`);
  }
  if (!name.trim()) throw new Error(`Config domain ${domain} contains an empty field name.`);
  if (!field.description.trim()) throw new Error(`Config field ${domain}.${name} requires a description.`);
  if (field.legalScopes.length === 0) throw new Error(`Config field ${domain}.${name} requires at least one legal scope.`);
  if (new Set(field.legalScopes).size !== field.legalScopes.length) {
    throw new Error(`Config field ${domain}.${name} contains duplicate legal scopes.`);
  }
  if (field.builtIn.kind !== "none" && !field.legalScopes.includes("built-in")) {
    throw new Error(`Config field ${domain}.${name} declares a built-in default without built-in scope.`);
  }
  if (field.runtimeOverride && !field.legalScopes.includes("runtime")) {
    throw new Error(`Config field ${domain}.${name} declares a runtime override without runtime scope.`);
  }
  if (field.interpolateValue && field.interpolation !== "env") {
    throw new Error(`Config field ${domain}.${name} declares a custom interpolator without env interpolation.`);
  }
}
