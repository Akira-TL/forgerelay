import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../runtime/config/config.js";
import type {
  ProjectExecutionRequirement,
  ProjectExecutionTrustPolicy,
} from "../../runtime/security/project-execution-trust.js";
import { ProjectContextResolver } from "../../workspaces/state/project-context.js";
import { SubagentSessionManager } from "./manager.js";

test("Project Subagent Profile authorization runs before provider launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-subagent-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const project = await new ProjectContextResolver(configDir).resolve(projectRoot);
  await mkdir(join(project.sharedConfigDir, "subagents"), { recursive: true });
  await writeFile(join(project.sharedConfigDir, "subagents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Project reviewer.",
    "provider: codex",
    "---",
    "",
    "Review the requested change.",
    "",
  ].join("\n"));
  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: projectRoot,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });

  const seen: ProjectExecutionRequirement[] = [];
  const denyPolicy: ProjectExecutionTrustPolicy = {
    async authorize(requirement) {
      seen.push(requirement);
      throw new Error("PROJECT_SUBAGENT_TRUST_DENIED");
    },
  };
  let launches = 0;
  const manager = new SubagentSessionManager(config, {
    launch() {
      launches += 1;
      return { id: "should-not-launch" };
    },
  }, denyPolicy);
  t.after(() => manager.close());

  await assert.rejects(
    manager.start({
      workspaceId: "ws_test",
      workspaceRoot: projectRoot,
      target: "reviewer",
      prompt: "Review this change.",
    }),
    /PROJECT_SUBAGENT_TRUST_DENIED/,
  );
  assert.equal(launches, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.domain, "subagents");
  assert.equal(seen[0]?.logicalPath, "subagents.profiles.reviewer");
  assert.deepEqual(seen[0]?.display, { kind: "subagent-profile", name: "reviewer" });
  assert.doesNotMatch(JSON.stringify(seen[0]), /Review the requested change|codex/);
});
