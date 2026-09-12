import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { defineConfigDomain } from "../definition/definition.js";
import { ConfigRuntime } from "./config-runtime.js";

const definition = defineConfigDomain({
  domain: "runtime-test",
  title: "Runtime test",
  description: "Test-only Config Runtime contract.",
  fields: {
    port: {
      schema: z.number().int(),
      description: "Restart-required port.",
      legalScopes: ["user"],
      merge: "replace",
      reload: "restart-required",
      sensitivity: "public",
      interpolation: "none",
      builtIn: { kind: "none" },
      executionEffect: "none",
    },
    token: {
      schema: z.string(),
      description: "Sensitive restart-required value.",
      legalScopes: ["user"],
      merge: "replace",
      reload: "restart-required",
      sensitivity: "sensitive",
      interpolation: "none",
      builtIn: { kind: "none" },
      executionEffect: "none",
    },
    hot: {
      schema: z.string(),
      description: "Hot value.",
      legalScopes: ["user"],
      merge: "replace",
      reload: "hot",
      sensitivity: "public",
      interpolation: "none",
      builtIn: { kind: "none" },
      executionEffect: "none",
    },
  },
});

test("restart-required runtime state keeps startup applied values while exposing configured changes", () => {
  const runtime = new ConfigRuntime();
  runtime.captureApplied(definition, {
    port: 7676,
    token: "startup-secret",
    hot: "startup-hot",
  });

  const changed = runtime.snapshotApplied(definition, {
    port: 8765,
    token: "replacement-secret",
    hot: "replacement-hot",
  });
  assert.equal(changed.restartRequired, true);
  assert.deepEqual(changed.fields.port, {
    logicalPath: "runtime-test.port",
    configuredValue: 8765,
    appliedValue: 7676,
    restartRequired: true,
  });
  assert.deepEqual(changed.fields.token, {
    logicalPath: "runtime-test.token",
    configuredValue: "<redacted>",
    appliedValue: "<redacted>",
    restartRequired: true,
  });
  assert.equal(changed.fields.hot, undefined, "hot fields are not part of applied restart state");

  const stillStartupApplied = runtime.snapshotApplied(definition, {
    port: 7676,
    token: "startup-secret",
    hot: "another-hot-value",
  });
  assert.equal(stillStartupApplied.restartRequired, false);
  assert.equal(stillStartupApplied.fields.port?.appliedValue, 7676);
});
