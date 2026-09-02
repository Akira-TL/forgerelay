import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import { SubagentSessionManager, type SubagentLaunchRequest } from "./manager.js";
import { SubagentSessionStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "forgerelay-subagent-manager-test-"));
const previousCodexCommand = process.env.CODEX_COMMAND;
process.env.CODEX_COMMAND = process.execPath;
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
  assert.throws(
    () => manager.resume({ sessionId: started.session.id, prompt: "busy" }, { workspaceId: "ws_test" }),
    (error: unknown) => (error as { code?: string }).code === "subagent.busy",
  );
  manager.close();

  const store = new SubagentSessionStore(stateDir);
  store.update(started.session.id, {
    status: "idle",
    activeRun: undefined,
    providerSessionId: "thread_test",
  });
  store.close();
  const resumedLaunches: SubagentLaunchRequest[] = [];
  const resumedManager = new SubagentSessionManager(config, {
    launch(request) {
      resumedLaunches.push(request);
    },
  });
  const resumed = resumedManager.resume(
    { sessionId: started.session.id, prompt: "Continue." },
    { workspaceId: "ws_test" },
  );
  assert.equal(resumed.session.model, "gpt-5.4");
  assert.equal(resumed.session.thinking, "high");
  assert.deepEqual(resumedLaunches.at(-1), {
    sessionId: started.session.id,
    runId: resumed.run.id,
    prompt: "Continue.",
  });
  assert.throws(
    () => resumedManager.resume({ sessionId: started.session.id, prompt: "wrong workspace" }, { workspaceId: "ws_other" }),
    (error: unknown) => (error as { code?: string }).code === "subagent.session_not_found",
  );
  resumedManager.close();
} finally {
  if (previousCodexCommand === undefined) {
    delete process.env.CODEX_COMMAND;
  } else {
    process.env.CODEX_COMMAND = previousCodexCommand;
  }
  rmSync(root, { recursive: true, force: true });
}
