import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { defineConfigDomain, configSourceSchema, parseConfigSource, resolveExecutionEffect } from "./definition.js";
import { generalConfigDefinition } from "./general-config.js";
import { languageServersConfigDefinition } from "./language-servers.js";
import { subagentProfilesConfigDefinition } from "../../../subagents/profiles.js";
import { hooksConfigDefinition } from "../../../mcp/hooks/config.js";
import {
  configSchemaId,
  configSchemaRelativePath,
  generateConfigJsonSchema,
  generateConfigSchemaFiles,
} from "./schema.js";
import { CONFIG_DEFINITION_CATALOG } from "./catalog.js";
import { CONFIG_SCHEMA_CONTRACT_MAJOR } from "./types.js";
import { resolveConfigDomain } from "../resolution/resolver.js";

test("Config Definition keeps built-in defaults as metadata instead of injecting source values", () => {
  const parsed = parseConfigSource(generalConfigDefinition, "user", {});
  assert.deepEqual(parsed, {});

  const port = generalConfigDefinition.fields.port;
  assert.deepEqual(port.legalScopes, ["runtime", "user", "built-in"]);
  assert.deepEqual(port.builtIn, { kind: "literal", value: 7676 });
  assert.equal(port.reload, "restart-required");
  assert.equal(port.runtimeOverride?.env, "PORT");
  assert.equal(typeof port.runtimeOverride?.readEnv, "function");
});

test("file-backed source schemas reserve $schema and reject unknown or illegal-scope fields", () => {
  assert.deepEqual(
    parseConfigSource(generalConfigDefinition, "project", {
      $schema: "https://example.test/forgerelay-schema.json",
    }),
    { $schema: "https://example.test/forgerelay-schema.json" },
  );

  const projectHost = configSourceSchema(generalConfigDefinition, "project").safeParse({ host: "0.0.0.0" });
  assert.equal(projectHost.success, false);
  if (!projectHost.success) assert.equal(projectHost.error.issues[0]?.code, "unrecognized_keys");

  const userTypo = configSourceSchema(generalConfigDefinition, "user").safeParse({ typoPort: 7676 });
  assert.equal(userTypo.success, false);
  if (!userTypo.success) assert.equal(userTypo.error.issues[0]?.code, "unrecognized_keys");
  assert.equal(configSourceSchema(generalConfigDefinition, "user").safeParse({ port: 7677 }).success, true);
});

test("generated scope schemas carry strict structure, defaults, descriptions, and Config metadata", () => {
  const schema = generateConfigJsonSchema(generalConfigDefinition, "user");
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.$id, configSchemaId(generalConfigDefinition, "user"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(CONFIG_SCHEMA_CONTRACT_MAJOR, 1);
  assert.match(String(schema.$id), /\/schemas\/v1\/config\.user\.schema\.json$/);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.port?.default, 7676);
  assert.equal(properties.port?.description, "Local listening port.");
  assert.equal(properties.port?.["x-forgerelay-reload"], "restart-required");
  assert.deepEqual(properties.port?.["x-forgerelay-scopes"], ["runtime", "user", "built-in"]);
  assert.deepEqual(properties.retention?.["x-forgerelay-runtime-override"], {
    env: ["FORGERELAY_RETENTION_HISTORY_DAYS", "FORGERELAY_RETENTION_ORPHANED_ADMIN"],
  });
  assert.equal(properties.$schema?.type, "string");
});

test("schema generation is domain-and-scope based with a stable independent contract path", () => {
  const files = generateConfigSchemaFiles(CONFIG_DEFINITION_CATALOG);
  assert.deepEqual(files.map((file) => file.relativePath), [
    "schemas/v1/config.user.schema.json",
    "schemas/v1/config.project-local.schema.json",
    "schemas/v1/config.project.schema.json",
    "schemas/v1/mcp.user.schema.json",
    "schemas/v1/mcp.project-local.schema.json",
    "schemas/v1/mcp.project.schema.json",
    "schemas/v1/language-servers.user.schema.json",
    "schemas/v1/language-servers.project-local.schema.json",
    "schemas/v1/language-servers.project.schema.json",
    "schemas/v1/hooks.user.schema.json",
    "schemas/v1/hooks.project-local.schema.json",
    "schemas/v1/hooks.project.schema.json",
  ]);
  assert.equal(
    configSchemaRelativePath(generalConfigDefinition, "project"),
    "schemas/v1/config.project.schema.json",
  );
});

test("Hook keyed-entry schemas stay per-file while resolver metadata remains keyed and hot", () => {
  const schema = generateConfigJsonSchema(hooksConfigDefinition, "project");
  const variants = schema.anyOf as Array<Record<string, unknown>>;
  const active = variants.find((variant) => "event" in ((variant.properties ?? {}) as Record<string, unknown>));
  const disabled = variants.find((variant) => "disabled" in ((variant.properties ?? {}) as Record<string, unknown>));
  const activeProperties = active?.properties as Record<string, Record<string, unknown>>;
  const disabledProperties = disabled?.properties as Record<string, Record<string, unknown>>;
  assert.equal(activeProperties.event?.type, "string");
  assert.equal(activeProperties.command?.type, "string");
  assert.equal(activeProperties.$schema?.type, "string");
  assert.equal(disabledProperties.disabled?.const, true);
  assert.equal(disabledProperties.$schema?.type, "string");
  assert.equal(schema["x-forgerelay-merge"], "keyed");
  assert.equal(schema["x-forgerelay-reload"], "hot");
  assert.equal(schema["x-forgerelay-sensitivity"], "sensitive");
  assert.equal(schema["x-forgerelay-execution-effect"], "dynamic");
});

test("Markdown-backed Subagent Profiles stay in the Config Definition catalog without emitting a misleading JSON file schema", () => {
  const files = generateConfigSchemaFiles(CONFIG_DEFINITION_CATALOG);
  assert.equal(CONFIG_DEFINITION_CATALOG.includes(subagentProfilesConfigDefinition), true);
  assert.equal(subagentProfilesConfigDefinition.schemaOutput, "none");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.merge, "keyed");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.reload, "hot");
  assert.equal(subagentProfilesConfigDefinition.fields.profiles.sensitivity, "sensitive");
  assert.equal(files.some((file) => file.relativePath.includes("subagents.")), false);
  assert.throws(
    () => generateConfigJsonSchema(subagentProfilesConfigDefinition, "project"),
    /does not expose a JSON file schema/,
  );
});

test("Language Server root-keyed sources normalize through the shared Config Definition entrypoint", () => {
  const parsed = parseConfigSource(languageServersConfigDefinition, "project", {
    $schema: "https://example.invalid/language-servers.schema.json",
    test: { command: "example", languages: ["typescript"], extensions: [".ts"] },
  });
  assert.deepEqual(parsed, {
    $schema: "https://example.invalid/language-servers.schema.json",
    servers: {
      test: { command: "example", languages: ["typescript"], extensions: [".ts"] },
    },
  });
});

test("Language Server schemas expose keyed hot sensitive env-interpolated process metadata", () => {
  const field = languageServersConfigDefinition.fields.servers;
  assert.equal(field.merge, "keyed");
  assert.equal(field.reload, "hot");
  assert.equal(field.sensitivity, "sensitive");
  assert.equal(field.interpolation, "env");
  const resolution = resolveConfigDomain({
    definition: languageServersConfigDefinition,
    sources: [{
      id: "project:language-servers",
      scope: "project",
      kind: "file",
      priority: 0,
      value: {
        active: { command: "example", languages: ["typescript"], extensions: [".ts"] },
        masked: { disabled: true },
      },
    }],
  });
  assert.equal(resolution.entries["servers.active"]?.effective.executionEffect, "process");
  assert.equal(resolution.entries["servers.masked"]?.effective.executionEffect, "none");

  const schema = generateConfigJsonSchema(languageServersConfigDefinition, "project");
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.$schema?.type, "string");
  assert.equal(schema["x-forgerelay-merge"], "keyed");
  assert.equal(schema["x-forgerelay-reload"], "hot");
  assert.equal(schema["x-forgerelay-sensitivity"], "sensitive");
  assert.equal(schema["x-forgerelay-interpolation"], "env");
  assert.equal(schema["x-forgerelay-execution-effect"], "dynamic");
});

test("Config Definition can express entry-sensitive process execution effects without runtime-specific trust logic", () => {
  const serverSchema = z.discriminatedUnion("transport", [
    z.object({ transport: z.literal("stdio"), command: z.string().min(1) }).strict(),
    z.object({ transport: z.literal("streamable-http"), url: z.string().min(1) }).strict(),
  ]);
  const definition = defineConfigDomain({
    domain: "execution-test",
    title: "Execution test configuration",
    description: "Test-only execution metadata model.",
    fields: {
      server: {
        schema: serverSchema,
        description: "One process-sensitive test entry.",
        legalScopes: ["project"],
        merge: "keyed",
        reload: "hot",
        sensitivity: "public",
        interpolation: "none",
        builtIn: { kind: "none" },
        executionEffect: (value: z.output<typeof serverSchema>) => value.transport === "stdio" ? "process" : "none",
      },
    },
  });

  const field = definition.fields.server;
  assert.equal(resolveExecutionEffect(field, { transport: "stdio", command: "node" }, ["server", "renderer"]), "process");
  assert.equal(resolveExecutionEffect(field, { transport: "streamable-http", url: "https://example.test/mcp" }, ["server", "remote"]), "none");
});
