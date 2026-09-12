import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoggingConfig } from "../../runtime/logging/logger.js";
import type {
  ProjectExecutionRequirement,
  ProjectExecutionTrustPolicy,
} from "../../runtime/security/project-execution-trust.js";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";
import { ExternalMcpTransformRunner } from "./external-mcp-transform.js";

const silentLogging: LoggingConfig = {
  level: "silent",
  format: "json",
  requests: false,
  assets: false,
  toolCalls: false,
  shellCommands: false,
  trustProxy: false,
};

test("Project External MCP transform Hook is authorized before command spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-transform-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  const marker = join(projectRoot, "should-not-exist.txt");
  await mkdir(projectRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(join(project.sharedConfigDir, "hooks"), { recursive: true });
  await writeFile(join(project.sharedConfigDir, "hooks", "transform.json"), JSON.stringify({
    event: "ExternalMcpBeforeForward",
    command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
  }) + "\n");

  const seen: ProjectExecutionRequirement[] = [];
  const denyPolicy: ProjectExecutionTrustPolicy = {
    async authorize(requirement) {
      seen.push(requirement);
      throw new Error("PROJECT_TRANSFORM_TRUST_DENIED");
    },
  };
  const runner = new ExternalMcpTransformRunner(
    {}, silentLogging, process.env, undefined, 1024 * 1024, configDir, undefined, denyPolicy,
  );

  await assert.rejects(
    runner.transformRequest({
      workspaceId: "ws_test",
      workspaceRoot: projectRoot,
      workspaceMode: "checkout",
      project,
      server: "demo",
      tool: "render",
    }, { value: 1 }),
    /transform Hook transform failed to start/,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.logicalPath, "hooks.hooks.transform");
});
