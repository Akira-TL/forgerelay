import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import { SubagentSessionManager } from "./manager.js";

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
  const launches: Array<{ sessionId: string; prompt: string }> = [];
  const manager = new SubagentSessionManager(config, {
    launch(sessionId, prompt) {
      launches.push({ sessionId, prompt });
    },
  });

  const started = await manager.start({
    workspaceId: "ws_test",
    workspaceRoot: projectRoot,
    target: "reviewer",
    prompt: "Review this change.",
  });
  assert.equal(started.status, "starting");
  assert.equal(started.profileName, "reviewer");
  assert.equal(started.provider, "codex");
  assert.equal(started.model, "gpt-5.4");
  assert.equal(started.thinking, "high");
  assert.deepEqual(launches, [{ sessionId: started.id, prompt: "Review this change." }]);

  const resumed = manager.resume({
    sessionId: started.id,
    prompt: "Now focus on tests.",
    model: "gpt-5.6",
  });
  assert.equal(resumed.id, started.id);
  assert.equal(resumed.status, "starting");
  assert.equal(resumed.model, "gpt-5.6");
  assert.equal(resumed.thinking, "high");
  assert.equal(resumed.latestResponse, undefined);
  assert.deepEqual(launches[1], { sessionId: started.id, prompt: "Now focus on tests." });

  assert.equal(manager.get(started.id)?.id, started.id);
  assert.equal(manager.list({ workspaceId: "ws_test" }).length, 1);
  manager.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
