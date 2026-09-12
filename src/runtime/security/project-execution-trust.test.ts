import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedConfigDomain } from "../config/resolution/types.js";
import {
  compatibilityAllowProjectExecutionTrustPolicy,
  projectExecutionRequirement,
} from "./project-execution-trust.js";

function resolution(scope: "project" | "project-local" | "user", executionEffect: "none" | "process", token: string): ResolvedConfigDomain {
  const effectiveValue = {
    transport: "stdio",
    command: "node",
    env: { SECRET_TOKEN: token },
  };
  return {
    domain: "mcp",
    values: { servers: { demo: effectiveValue } },
    entries: {
      "servers.demo": {
        logicalPath: "mcp.servers.demo",
        effective: {
          source: {
            id: `canonical:${scope}:mcp`,
            scope,
            kind: "file",
            location: `/repo/.forgerelay/${scope}/mcp.json`,
            priority: 100,
          },
          configuredValue: effectiveValue,
          effectiveValue,
          reload: "hot",
          sensitivity: "sensitive",
          executionEffect,
          ...(executionEffect === "process"
            ? { executionFingerprint: token === "TOP_SECRET_TWO" ? "B".repeat(43) : "A".repeat(43) }
            : {}),
        },
        shadowed: [],
      },
    },
    sources: [],
    diagnostics: [],
  };
}

test("Project process config produces a secret-safe execution requirement with effective-config identity", async () => {
  const first = projectExecutionRequirement({
    projectId: "proj_0123456789abcdefabcd",
    resolution: resolution("project", "process", "TOP_SECRET_ONE"),
    entryKey: "servers.demo",
    display: { kind: "external-mcp", name: "demo" },
  });
  const second = projectExecutionRequirement({
    projectId: "proj_0123456789abcdefabcd",
    resolution: resolution("project", "process", "TOP_SECRET_TWO"),
    entryKey: "servers.demo",
    display: { kind: "external-mcp", name: "demo" },
  });

  assert.ok(first);
  assert.equal(first.projectId, "proj_0123456789abcdefabcd");
  assert.equal(first.domain, "mcp");
  assert.equal(first.logicalPath, "mcp.servers.demo");
  assert.equal(first.source.id, "canonical:project:mcp");
  assert.equal(first.source.location, "/repo/.forgerelay/project/mcp.json");
  assert.deepEqual(first.display, { kind: "external-mcp", name: "demo" });
  assert.equal(first.executableConfigFingerprint, "A".repeat(43));
  assert.notEqual(first.executableConfigFingerprint, second?.executableConfigFingerprint);
  assert.doesNotMatch(JSON.stringify(first), /TOP_SECRET|SECRET_TOKEN|\"command\":\"node\"/);

  const decision = await compatibilityAllowProjectExecutionTrustPolicy.authorize(first);
  assert.deepEqual(decision, {
    policy: "compatibility-allow",
    decision: "allow",
    projectId: first.projectId,
    executableConfigFingerprint: first.executableConfigFingerprint,
  });
});

test("non-Project or non-process config does not produce a Project execution requirement", () => {
  for (const [scope, effect] of [
    ["project-local", "process"],
    ["user", "process"],
    ["project", "none"],
  ] as const) {
    assert.equal(projectExecutionRequirement({
      projectId: "proj_0123456789abcdefabcd",
      resolution: resolution(scope, effect, "SECRET"),
      entryKey: "servers.demo",
      display: { kind: "external-mcp", name: "demo" },
    }), undefined);
  }
});
