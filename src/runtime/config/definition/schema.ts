import * as z from "zod/v4";
import { configSourceSchema } from "./definition.js";
import {
  CONFIG_FILE_SCOPES,
  CONFIG_SCHEMA_CONTRACT_MAJOR,
  type ConfigDomainDefinition,
  type ConfigFieldDefinition,
  type ConfigFileScope,
} from "./types.js";

const DRAFT_7_SCHEMA = "http://json-schema.org/draft-07/schema#";
const SCHEMA_RAW_BASE = "https://raw.githubusercontent.com/Akira-TL/forgerelay/main";

type JsonObject = Record<string, unknown>;

export interface GeneratedConfigSchema {
  relativePath: string;
  schema: JsonObject;
}

export function configSchemaRelativePath(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): string {
  return `schemas/v${CONFIG_SCHEMA_CONTRACT_MAJOR}/${definition.domain}.${scope}.schema.json`;
}

export function configSchemaId(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): string {
  return `${SCHEMA_RAW_BASE}/${configSchemaRelativePath(definition, scope)}`;
}

export function generateConfigJsonSchema(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): JsonObject {
  if (definition.fileShape?.kind === "keyed-root") {
    return generateKeyedRootConfigJsonSchema(definition, scope);
  }

  const schema = z.toJSONSchema(configSourceSchema(definition, scope), {
    target: "draft-7",
  }) as JsonObject;
  applySchemaIdentity(schema, definition, scope);

  const properties = asObject(schema.properties);
  for (const [name, field] of Object.entries(definition.fields)) {
    if (!field.legalScopes.includes(scope)) continue;
    const property = asObject(properties[name]);
    applyFieldMetadata(property, field);
    properties[name] = property;
  }
  schema.properties = properties;
  return schema;
}

function generateKeyedRootConfigJsonSchema(
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): JsonObject {
  const fileShape = definition.fileShape;
  if (!fileShape || fileShape.kind !== "keyed-root") {
    throw new Error(`Config domain ${definition.domain} is not keyed-root.`);
  }
  const field = definition.fields[fileShape.field];
  if (!field || !field.legalScopes.includes(scope)) {
    throw new Error(`Config domain ${definition.domain} does not expose keyed-root field ${fileShape.field} at ${scope} scope.`);
  }
  const schema = z.toJSONSchema(field.schema, { target: "draft-7" }) as JsonObject;
  applySchemaIdentity(schema, definition, scope);
  const properties = asObject(schema.properties);
  properties.$schema = {
    type: "string",
    description: "Editor-only JSON Schema URL. Ignored by ForgeRelay resolution.",
  };
  schema.properties = properties;
  applyFieldMetadata(schema, field);
  return schema;
}

function applySchemaIdentity(
  schema: JsonObject,
  definition: ConfigDomainDefinition,
  scope: ConfigFileScope,
): void {
  schema.$schema = DRAFT_7_SCHEMA;
  schema.$id = configSchemaId(definition, scope);
  schema.title = `${definition.title} (${scope})`;
  schema.description = definition.description;
}

function applyFieldMetadata(target: JsonObject, field: ConfigFieldDefinition): void {
  if (field.builtIn.kind === "literal") target.default = field.builtIn.value;
  target["x-forgerelay-scopes"] = [...field.legalScopes];
  target["x-forgerelay-merge"] = field.merge;
  target["x-forgerelay-reload"] = field.reload;
  target["x-forgerelay-sensitivity"] = field.sensitivity;
  target["x-forgerelay-interpolation"] = field.interpolation;
  target["x-forgerelay-execution-effect"] =
    typeof field.executionEffect === "function" ? "dynamic" : field.executionEffect;
  if (field.runtimeOverride) {
    target["x-forgerelay-runtime-override"] = {
      ...(field.runtimeOverride.cli ? { cli: field.runtimeOverride.cli } : {}),
      ...(field.runtimeOverride.env ? { env: field.runtimeOverride.env } : {}),
    };
  }
  if (field.builtIn.kind === "computed") {
    target["x-forgerelay-computed-default"] = field.builtIn.description;
  }
  if (field.deprecation) {
    target.deprecated = true;
    target["x-forgerelay-deprecation"] = field.deprecation;
  }
}

export function generateConfigSchemaFiles(
  definitions: readonly ConfigDomainDefinition[],
): GeneratedConfigSchema[] {
  return definitions.flatMap((definition) =>
    CONFIG_FILE_SCOPES.map((scope) => ({
      relativePath: configSchemaRelativePath(definition, scope),
      schema: generateConfigJsonSchema(definition, scope),
    })),
  );
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}
