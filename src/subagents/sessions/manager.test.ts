import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import { SubagentSessionManager, type SubagentLaunchRequest } from "./manager.js";

const root = mkdtempSync(join(tmpdir(), "forgerelay-subagent-manager-test-"));
try {
  const configDir = join(root, ".forgerelay");
  const stateDir = join(root, ".state");
  const projectRoot = join(root, "project");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(configDir, "agents", "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Reviews code.",
      "provider: codex",
      "model: gpt-5.4",
      "thinking: high",
      "---",
      "",
      "Review carefully.",
    ].join("\n"),
  );

  const config = loadConfig({
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_ALLOWED_ROOTS: projectRoot,
    FORGERELAY_STATE_DIR: stateDir,
    FORGERELAY_SUBAGENTS: "1",
    FORGERELAY_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  });
  const launches: SubagentLaunchRequest[] = [];
  const manager = new SubagentSessionManager(config, {
    launch(request) {
      launches.push(request);
    },
  });

  const started = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot: projectRoot,
    target: "reviewer",
    prompt: "Review this change.",
    activityId: "act_test",
  });
  assert.equal(started.session.status, "running");
  assert.equal(started.session.profileName, "reviewer");
  assert.equal(started.session.provider, "codex");
  assert.equal(started.session.model, "gpt-5.4");
  assert.equal(started.session.thinking, "high");
  assert.equal(started.run.id, started.session.activeRun?.id);
  assert.equal(started.run.activityId, "act_test");
  assert.deepEqual(launches, [{
    sessionId: started.session.id,
    runId: started.run.id,
    activityId: "act_test",
    prompt: "Review this change.",
  }]);

  assert.equal(manager.get(started.session.id)?.id, started.session.id);
  assert.equal(manager.get(started.session.id, { workspaceId: "ws_other" }), undefined);
  assert.equal(manager.list({ workspaceId: "ws_test" }).length, 1);
  manager.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
