import assert from "node:assert/strict";
import test from "node:test";
import { compactWorkspacePresentation } from "./workspace-presentation.js";

test("compact Workspace presentation restores display metadata without carrying bootstrap bodies", () => {
  const presentation = compactWorkspacePresentation({
    workspaceId: "ws_panel",
    root: "/tmp/project",
    mode: "checkout",
    contextFingerprint: "ctx-panel",
    agentsFiles: [
      { path: "/tmp/project/AGENTS.md", content: "INSTRUCTION-BODY-SENTINEL" },
    ],
    availableAgentsFiles: [
      { path: "/tmp/project/packages/app/AGENTS.md", content: "AVAILABLE-BODY-SENTINEL" },
    ],
    skills: [
      { name: "tdd", description: "Test-driven development", path: "/secret/skill/path" },
    ],
    agentProviders: [
      { name: "claude", available: true, secret: "PROVIDER-SECRET" },
    ],
    agents: [
      {
        name: "reviewer",
        description: "Reviews code",
        provider: "claude",
        model: "sonnet",
        thinking: "medium",
        providerAvailable: true,
        privateConfig: "AGENT-SECRET",
      },
    ],
    capabilityGuides: [{ name: "guide", content: "GUIDE-BODY-SENTINEL" }],
    skillDiagnostics: [{ message: "DIAGNOSTIC-SENTINEL" }],
    instruction: "INSTRUCTION-PROMPT-SENTINEL",
  });

  assert.deepEqual(presentation.agentsFiles, [{ path: "/tmp/project/AGENTS.md" }]);
  assert.deepEqual(presentation.availableAgentsFiles, [{ path: "/tmp/project/packages/app/AGENTS.md" }]);
  assert.deepEqual(presentation.skills, [{ name: "tdd" }]);
  assert.deepEqual(presentation.agentProviders, [{ name: "claude", available: true }]);
  assert.deepEqual(presentation.agents, [{
    name: "reviewer",
    provider: "claude",
    model: "sonnet",
    providerAvailable: true,
  }]);
  assert.equal(presentation.presentationRevision, "ctx-panel");

  const serialized = JSON.stringify(presentation);
  for (const sentinel of [
    "INSTRUCTION-BODY-SENTINEL",
    "AVAILABLE-BODY-SENTINEL",
    "PROVIDER-SECRET",
    "AGENT-SECRET",
    "GUIDE-BODY-SENTINEL",
    "DIAGNOSTIC-SENTINEL",
    "INSTRUCTION-PROMPT-SENTINEL",
    "/secret/skill/path",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
