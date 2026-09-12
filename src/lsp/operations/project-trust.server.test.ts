import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigRuntime } from "../../runtime/config/runtime/config-runtime.js";
import type {
  ProjectExecutionRequirement,
  ProjectExecutionTrustPolicy,
} from "../../runtime/security/project-execution-trust.js";
import { CodeIntelligenceManager } from "../runtime/manager.js";

test("Project Language Server authorization runs before Language service spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-lsp-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".forgerelay"), { recursive: true });
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(projectRoot, "package.json"), "{}\n");
  await writeFile(join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
  await writeFile(join(projectRoot, ".forgerelay", "language-servers.json"), JSON.stringify({
    projectTs: {
      command: "definitely-not-a-real-language-server-command",
      args: ["--stdio"],
      languages: ["typescript"],
      extensions: [".ts"],
      projectMarkers: ["package.json"],
    },
  }) + "\n");

  const seen: ProjectExecutionRequirement[] = [];
  const denyPolicy: ProjectExecutionTrustPolicy = {
    async authorize(requirement) {
      seen.push(requirement);
      throw new Error("PROJECT_LSP_TRUST_DENIED");
    },
  };
  const manager = new CodeIntelligenceManager(
    { languageServers: {}, configDir, configRuntime: new ConfigRuntime() },
    { projectExecutionTrustPolicy: denyPolicy },
  );
  t.after(() => manager.shutdown());

  await assert.rejects(
    manager.run(projectRoot, { operation: "hover", path: "src/main.ts", line: 1, column: 1 }),
    /PROJECT_LSP_TRUST_DENIED/,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.domain, "language-servers");
  assert.equal(seen[0]?.logicalPath, "language-servers.servers.projectTs");
  assert.deepEqual(seen[0]?.display, { kind: "language-server", name: "projectTs" });
  assert.doesNotMatch(JSON.stringify(seen[0]), /definitely-not-a-real-language-server-command|--stdio/);
});
