import * as z from "zod/v4";
import {
  CONFIG_FILE_SCOPES,
  type ConfigDomainDefinition,
  type ConfigExecutionEffect,
  type ConfigFieldDefinition,
  type ConfigFieldMap,
  type ConfigFileScope,
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

export function parseConfigSource(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
  value: unknown,
): Record<string, unknown> {
  return configSourceSchema(definition, scope).parse(value) as Record<string, unknown>;
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
