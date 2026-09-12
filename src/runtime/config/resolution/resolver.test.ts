import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { defineConfigDomain } from "../definition/definition.js";
import { resolveGeneralConfig } from "./general.js";
import { assertConfigResolutionValid, resolveConfigDomain } from "./resolver.js";

const precedenceDefinition = defineConfigDomain({
  domain: "precedence-test",
  title: "Precedence test",
  description: "Test-only Config Resolver precedence contract.",
  fields: {
    value: {
      schema: z.string(),
      description: "One replace value.",
      legalScopes: ["runtime", "project-local", "project", "user", "built-in"],
      merge: "replace",
      reload: "hot",
      sensitivity: "public",
      interpolation: "none",
      builtIn: { kind: "literal", value: "built-in" },
      executionEffect: "none",
    },
  },
});

test("Config Resolver applies scope precedence and CLI priority above environment", () => {
  const resolved = resolveConfigDomain({
    definition: precedenceDefinition,
    sources: [
      source("user", "user:file", "file", 0, { value: "user" }),
      source("project", "project:file", "file", 0, { value: "project" }),
      source("project-local", "project-local:file", "file", 0, { value: "project-local" }),
      source("runtime", "runtime:environment", "environment", 10, { value: "environment" }),
      source("runtime", "runtime:cli", "cli", 20, { value: "cli" }),
    ],
  });

  assert.equal(resolved.values.value, "cli");
  assert.equal(resolved.entries.value?.effective.source.id, "runtime:cli");
  assert.deepEqual(
    resolved.entries.value?.shadowed.map((candidate) => [candidate.source.id, candidate.reason]),
    [
      ["runtime:environment", "higher-priority"],
      ["project-local:file", "higher-scope"],
      ["project:file", "higher-scope"],
      ["user:file", "higher-scope"],
      ["built-in:precedence-test", "higher-scope"],
    ],
  );
});

test("an invalid file source is atomic and cannot leak valid sibling fields", () => {
  const resolved = resolveConfigDomain({
    definition: precedenceDefinition,
    sources: [source("user", "user:file", "file", 0, { value: "user", typo: true })],
  });

  assert.equal(resolved.values.value, "built-in");
  assert.equal(resolved.entries.value?.effective.source.scope, "built-in");
  assert.equal(resolved.diagnostics.length, 1);
  assert.equal(resolved.diagnostics[0]?.code, "invalid_source");
  assert.match(resolved.diagnostics[0]?.message ?? "", /Unrecognized key/);
  assert.throws(() => assertConfigResolutionValid(resolved), /Invalid ForgeRelay precedence-test configuration/);
});

test("sensitive interpolation resolves runtime values without copying raw secrets into provenance", () => {
  const definition = defineConfigDomain({
    domain: "secret-test",
    title: "Secret test",
    description: "Test-only secret interpolation contract.",
    fields: {
      token: {
        schema: z.string(),
        description: "Sensitive token.",
        legalScopes: ["user"],
        merge: "replace",
        reload: "hot",
        sensitivity: "sensitive",
        interpolation: "env",
        builtIn: { kind: "none" },
        executionEffect: "process",
      },
    },
  });
  const resolved = resolveConfigDomain({
    definition,
    sources: [source("user", "user:file", "file", 0, { token: "${SECRET_TOKEN}" })],
    environment: { SECRET_TOKEN: "sentinel-super-secret" },
  });
  const changedSecret = resolveConfigDomain({
    definition,
    sources: [source("user", "user:file", "file", 0, { token: "${SECRET_TOKEN}" })],
    environment: { SECRET_TOKEN: "different-super-secret" },
  });

  assert.equal(resolved.values.token, "sentinel-super-secret");
  assert.equal(resolved.entries.token?.effective.configuredValue, "${SECRET_TOKEN}");
  assert.equal(resolved.entries.token?.effective.effectiveValue, "<redacted>");
  assert.match(resolved.entries.token?.effective.executionFingerprint ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    resolved.entries.token?.effective.executionFingerprint,
    changedSecret.entries.token?.effective.executionFingerprint,
  );
  assert.doesNotMatch(JSON.stringify(resolved.entries), /sentinel-super-secret|different-super-secret/);
  assert.doesNotMatch(JSON.stringify(resolved.entries), /executionFingerprint/);
});

test("missing interpolation variables invalidate the whole source with a safe diagnostic", () => {
  const definition = defineConfigDomain({
    domain: "missing-env-test",
    title: "Missing environment test",
    description: "Test-only missing interpolation contract.",
    fields: {
      token: {
        schema: z.string(),
        description: "Sensitive token.",
        legalScopes: ["user"],
        merge: "replace",
        reload: "hot",
        sensitivity: "sensitive",
        interpolation: "env",
        builtIn: { kind: "none" },
        executionEffect: "none",
      },
    },
  });
  const resolved = resolveConfigDomain({
    definition,
    sources: [source("user", "user:file", "file", 0, { token: "${MISSING_TOKEN}" })],
    environment: {},
  });

  assert.equal(resolved.values.token, undefined);
  assert.equal(resolved.diagnostics[0]?.code, "missing_environment");
  assert.match(resolved.diagnostics[0]?.message ?? "", /MISSING_TOKEN/);
});

test("general resolver rejects machine-only project fields and exposes lower built-in provenance", () => {
  const resolved = resolveGeneralConfig({ project: { port: 9000 }, env: {} });
  assert.equal(resolved.values.port, 7676);
  assert.equal(resolved.entries.port?.effective.source.scope, "built-in");
  assert.equal(resolved.diagnostics[0]?.source.scope, "project");
  assert.equal(resolved.diagnostics[0]?.code, "invalid_source");
});

test("general runtime CLI values outrank parsed environment overrides", () => {
  const resolved = resolveGeneralConfig({
    env: { PORT: "8000" },
    cli: { port: 9000 },
  });
  assert.equal(resolved.values.port, 9000);
  assert.equal(resolved.entries.port?.effective.source.kind, "cli");
  assert.equal(resolved.entries.port?.shadowed[0]?.source.kind, "environment");
});

test("runtime diagnostics report constraints without echoing received values", () => {
  const sentinel = "sentinel-invalid-port";
  const resolved = resolveGeneralConfig({ env: { PORT: sentinel } });
  assert.equal(resolved.diagnostics[0]?.code, "invalid_source");
  assert.match(resolved.diagnostics[0]?.message ?? "", /expected an integer from 1 to 65535/);
  assert.doesNotMatch(JSON.stringify(resolved.diagnostics), new RegExp(sentinel));
});

test("known legacy inline domain keys remain valid but deprecated while unknown keys are strict errors", () => {
  const compatible = resolveGeneralConfig({
    user: { hooks: { BeforeTool: [] } },
    userSourcePath: "/tmp/config.json",
    env: {},
  });
  assert.equal(compatible.diagnostics.some((diagnostic) => diagnostic.code === "invalid_source"), false);
  assert.equal(compatible.diagnostics.some((diagnostic) => diagnostic.code === "deprecated_source"), true);

  const invalid = resolveGeneralConfig({ user: { typoPort: 7676 }, env: {} });
  assert.equal(invalid.diagnostics[0]?.code, "invalid_source");
});

test("keyed merge resolves each key independently, honors tombstones, and lets canonical source presence shadow same-scope legacy", () => {
  const definition = defineConfigDomain({
    domain: "keyed-test",
    title: "Keyed test",
    description: "Test-only keyed merge contract.",
    fields: {
      entries: {
        schema: z.record(z.string(), z.union([
          z.object({ value: z.string() }).strict(),
          z.object({ disabled: z.literal(true) }).strict(),
        ])),
        description: "Keyed entries.",
        legalScopes: ["project", "user"],
        merge: "keyed",
        reload: "hot",
        sensitivity: "public",
        interpolation: "none",
        builtIn: { kind: "none" },
        executionEffect: "none",
      },
    },
  });
  const resolved = resolveConfigDomain({
    definition,
    sources: [
      {
        scope: "user",
        id: "legacy:user",
        kind: "file",
        priority: 0,
        value: { entries: { legacyOnly: { value: "legacy" }, shared: { value: "legacy" } } },
      },
      {
        scope: "user",
        id: "canonical:user",
        kind: "file",
        priority: 100,
        shadowsLowerPriority: true,
        value: { entries: { shared: { value: "user" }, inherited: { value: "user" } } },
      },
      {
        scope: "project",
        id: "canonical:project",
        kind: "file",
        priority: 100,
        shadowsLowerPriority: true,
        value: { entries: { shared: { disabled: true }, projectOnly: { value: "project" } } },
      },
    ],
  });

  assert.deepEqual(resolved.values.entries, {
    inherited: { value: "user" },
    projectOnly: { value: "project" },
  });
  assert.equal(resolved.entries["entries.shared"]?.tombstone, true);
  assert.equal(resolved.entries["entries.shared"]?.effective.source.scope, "project");
  assert.equal(resolved.entries["entries.legacyOnly"], undefined, "canonical user source presence shadows legacy backfill");
  assert.equal(
    resolved.entries["entries.shared"]?.shadowed.some((entry) => entry.source.id === "legacy:user" && entry.reason === "source-shadowed"),
    true,
  );
});

function source(
  scope: "runtime" | "project-local" | "project" | "user",
  id: string,
  kind: "cli" | "environment" | "file",
  priority: number,
  value: unknown,
) {
  return { scope, id, kind, priority, value } as const;
}
