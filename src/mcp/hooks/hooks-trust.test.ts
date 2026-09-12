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
import { HookRunner } from "./hooks.js";

const silentLogging: LoggingConfig = {
  level: "silent",
  format: "json",
  requests: false,
  assets: false,
  toolCalls: false,
  shellCommands: false,
  trustProxy: false,
};

test("Project Hook execution is authorized through the Project trust seam before spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hook-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  const hookDir = join(projectRoot, ".forgerelay", "hooks");
  const marker = join(projectRoot, "should-not-exist.txt");
  const script = join(projectRoot, "hook.mjs");
  await mkdir(hookDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  await writeFile(
    join(hookDir, "trusted.json"),
    JSON.stringify({ event: "BeforeTool", command: `node "${script}"` }) + "\n",
  );

  const requirements: ProjectExecutionRequirement[] = [];
  const denyPolicy: ProjectExecutionTrustPolicy = {
    async authorize(requirement) {
      requirements.push(requirement);
      throw new Error("PROJECT_TRUST_DENIED");
    },
  };
  const runner = new HookRunner(
    {},
    silentLogging,
    process.env,
    undefined,
    undefined,
    configDir,
    undefined,
    denyPolicy,
  );

  await assert.rejects(
    runner.run("BeforeTool", {
      workspaceId: "ws_test",
      workspaceRoot: projectRoot,
      workspaceMode: "checkout",
      payload: { tool: "bash" },
    }),
    /PROJECT_TRUST_DENIED/,
  );
  assert.equal(existsSync(marker), false, "Hook command must not spawn before trust authorization");
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.domain, "hooks");
  assert.equal(requirements[0]?.logicalPath, "hooks.hooks.trusted");
  assert.deepEqual(requirements[0]?.display, { kind: "hook", name: "trusted" });
  assert.doesNotMatch(JSON.stringify(requirements[0]), /hook\.mjs|node/);
});
