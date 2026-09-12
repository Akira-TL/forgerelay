import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProjectExecutionRequirement,
  ProjectExecutionTrustPolicy,
} from "../../../runtime/security/project-execution-trust.js";
import { ExternalMcpGateway } from "./external-mcp.js";

const requirement: ProjectExecutionRequirement = {
  projectId: "proj_0123456789abcdefabcd",
  domain: "mcp",
  logicalPath: "servers.worker",
  source: { id: "canonical:project:mcp", location: "/repo/.forgerelay/mcp.json" },
  display: { kind: "external-mcp", name: "worker" },
  executableConfigFingerprint: "A".repeat(43),
};

test("Project stdio MCP authorization runs before transport spawn", async () => {
  const seen: ProjectExecutionRequirement[] = [];
  const denyPolicy: ProjectExecutionTrustPolicy = {
    async authorize(input) {
      seen.push(input);
      throw new Error("PROJECT_MCP_TRUST_DENIED");
    },
  };
  const gateway = new ExternalMcpGateway(1024 * 1024, undefined, denyPolicy);

  await assert.rejects(
    gateway.run(
      { worker: { transport: "stdio", command: "definitely-not-a-real-forgerelay-command" } },
      { operation: "tools", server: "worker" },
      undefined,
      undefined,
      { origins: { worker: "project" }, executionRequirements: { worker: requirement } },
    ),
    /PROJECT_MCP_TRUST_DENIED/,
  );
  assert.deepEqual(seen, [requirement]);
});
