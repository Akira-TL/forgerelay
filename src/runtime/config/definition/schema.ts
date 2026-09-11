import * as z from "zod/v4";
import { configSourceSchema } from "./definition.js";
import {
  CONFIG_FILE_SCOPES,
  CONFIG_SCHEMA_CONTRACT_MAJOR,
  type ConfigDomainDefinition,
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
  const schema = z.toJSONSchema(configSourceSchema(definition, scope), {
    target: "draft-7",
  }) as JsonObject;
  schema.$schema = DRAFT_7_SCHEMA;
  schema.$id = configSchemaId(definition, scope);
  schema.title = `${definition.title} (${scope})`;
  schema.description = definition.description;

  const properties = asObject(schema.properties);
  for (const [name, field] of Object.entries(definition.fields)) {
    if (!field.legalScopes.includes(scope)) continue;
    const property = asObject(properties[name]);
    if (field.builtIn.kind === "literal") property.default = field.builtIn.value;
    property["x-forgerelay-scopes"] = [...field.legalScopes];
    property["x-forgerelay-merge"] = field.merge;
    property["x-forgerelay-reload"] = field.reload;
    property["x-forgerelay-sensitivity"] = field.sensitivity;
    property["x-forgerelay-interpolation"] = field.interpolation;
    property["x-forgerelay-execution-effect"] =
      typeof field.executionEffect === "function" ? "dynamic" : field.executionEffect;
    if (field.runtimeOverride) {
      property["x-forgerelay-runtime-override"] = {
        ...(field.runtimeOverride.cli ? { cli: field.runtimeOverride.cli } : {}),
        ...(field.runtimeOverride.env ? { env: field.runtimeOverride.env } : {}),
      };
    }
    if (field.builtIn.kind === "computed") {
      property["x-forgerelay-computed-default"] = field.builtIn.description;
    }
    if (field.deprecation) {
      property.deprecated = true;
      property["x-forgerelay-deprecation"] = field.deprecation;
    }
    properties[name] = property;
  }
  schema.properties = properties;
  return schema;
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
