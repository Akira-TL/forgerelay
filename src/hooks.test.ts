import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookExecutionError, HookRunner, parseHookConfig } from "./hooks.js";
import type { LoggingConfig } from "./logger.js";

const silentLogging: LoggingConfig = {
  level: "silent",
  format: "json",
  requests: false,
  assets: false,
  toolCalls: false,
  shellCommands: false,
  trustProxy: false,
};

test("hook config normalizes matcher rules and report defaults", () => {
  assert.deepEqual(
    parseHookConfig({
      BeforeTool: [
        {
          matcher: {
            tool: "bash",
            commandRegex: "^git\\s+push\\b.*v\\d+\\.\\d+\\.\\d+$",
          },
          handlers: [
            {
              name: "Local release CI",
              command: "npm run release:verify",
              timeoutSeconds: 300,
            },
            {
              name: "Package inspection",
              command: "npm pack --dry-run",
              report: false,
            },
          ],
        },
      ],
    }),
    {
      BeforeTool: [
        {
          matcher: {
            tool: "bash",
            commandRegex: "^git\\s+push\\b.*v\\d+\\.\\d+\\.\\d+$",
          },
          handlers: [
            {
              name: "Local release CI",
              command: "npm run release:verify",
              timeoutSeconds: 300,
              report: true,
            },
            {
              name: "Package inspection",
              command: "npm pack --dry-run",
              timeoutSeconds: 30,
              report: false,
            },
          ],
        },
      ],
    },
  );
});

test("tool and command matchers run only for matching operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "matched.mjs");
  await writeFile(
    script,
    'import { writeFileSync } from "node:fs"; writeFileSync("matched.txt", "yes");\n',
  );

  const runner = new HookRunner(
    parseHookConfig({
      BeforeTool: [
        {
          matcher: {
            tool: "bash",
            commandRegex: "^git\\s+push\\b.*v\\d+\\.\\d+\\.\\d+$",
          },
          handlers: [{ command: `node "${script}"` }],
        },
      ],
    }),
    silentLogging,
  );

  await runner.run("BeforeTool", {
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    payload: { tool: "bash", command: "git status" },
  });
  await assert.rejects(() => readFile(join(root, "matched.txt"), "utf8"), /ENOENT/);

  await runner.run("BeforeTool", {
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    payload: { tool: "bash", command: "git push origin v0.2.0" },
  });
  assert.equal(await readFile(join(root, "matched.txt"), "utf8"), "yes");
});

test("project hooks resolve from workspace root instead of a nested tool cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, "packages", "app");
  const hookDir = join(root, ".forgerelay");
  const marker = join(root, "project-hook-ran.txt");
  const hookScript = join(root, "project-root-hook.mjs");
  await mkdir(nested, { recursive: true });
  await mkdir(hookDir, { recursive: true });
  await writeFile(
    hookScript,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");\n`,
  );
  await writeFile(
    join(hookDir, "hooks.json"),
    JSON.stringify({
      AfterTool: [{
        matcher: { tool: "bash" },
        handlers: [{
          name: "Project root hook",
          command: `node "${hookScript}"`,
        }],
      }],
    }),
  );

  const runner = new HookRunner({}, silentLogging);
  const reports = await runner.run("AfterTool", {
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    cwd: nested,
    payload: { tool: "bash", command: "printf nested" },
  });

  assert.equal(await readFile(marker, "utf8"), "yes");
  assert.equal(reports[0]?.scope, "project");
});

test("blocking hook receives workspace and payload environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "capture.mjs");
  await writeFile(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync('hook.json', JSON.stringify({",
      "  event: process.env.FORGERELAY_HOOK_EVENT,",
      "  workspaceId: process.env.FORGERELAY_WORKSPACE_ID,",
      "  workspaceRoot: process.env.FORGERELAY_WORKSPACE_ROOT,",
      "  workspaceMode: process.env.FORGERELAY_WORKSPACE_MODE,",
      "  tool: process.env.FORGERELAY_TOOL_NAME,",
      "  payload: JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? '{}'),",
      "}));",
    ].join("\n"),
  );

  const runner = new HookRunner(
    parseHookConfig({ BeforeTool: [{ command: `node "${script}"` }] }),
    silentLogging,
  );
  await runner.run("BeforeTool", {
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    payload: { tool: "write", path: "src/example.ts" },
  });

  assert.deepEqual(JSON.parse(await readFile(join(root, "hook.json"), "utf8")), {
    event: "BeforeTool",
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    tool: "write",
    payload: { tool: "write", path: "src/example.ts" },
  });
});

test("blocking hook failure rejects the lifecycle operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fail.mjs");
  await writeFile(script, 'console.error("policy denied"); process.exit(7);\n');

  const runner = new HookRunner(
    parseHookConfig({ BeforeTool: [{ command: `node "${script}"` }] }),
    silentLogging,
  );

  await assert.rejects(
    () => runner.run("BeforeTool", {
      workspaceId: "ws_test",
      workspaceRoot: root,
      workspaceMode: "checkout",
      payload: { tool: "bash" },
    }),
    (error: unknown) => {
      assert.equal(error instanceof HookExecutionError, true);
      assert.match(String(error), /BeforeTool handler 1 exited with code 7: policy denied/);
      return true;
    },
  );
});

test("missing optional hook context clears inherited ForgeRelay values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "capture-optional.mjs");
  await writeFile(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync('optional.json', JSON.stringify({",
      "  workspaceId: process.env.FORGERELAY_WORKSPACE_ID ?? null,",
      "  workspaceMode: process.env.FORGERELAY_WORKSPACE_MODE ?? null,",
      "  sourceRoot: process.env.FORGERELAY_SOURCE_ROOT ?? null,",
      "  tool: process.env.FORGERELAY_TOOL_NAME ?? null,",
      "}));",
    ].join("\n"),
  );

  const runner = new HookRunner(
    parseHookConfig({ SubagentStart: [{ command: `node "${script}"` }] }),
    silentLogging,
    {
      ...process.env,
      FORGERELAY_WORKSPACE_ID: "ws_stale",
      FORGERELAY_WORKSPACE_MODE: "worktree",
      FORGERELAY_SOURCE_ROOT: "/stale/source",
      FORGERELAY_TOOL_NAME: "stale_tool",
    },
  );
  await runner.run("SubagentStart", {
    workspaceRoot: root,
    payload: { agentId: "agt_test" },
  });

  assert.deepEqual(JSON.parse(await readFile(join(root, "optional.json"), "utf8")), {
    workspaceId: null,
    workspaceMode: null,
    sourceRoot: null,
    tool: null,
  });
});

test("blocking hook timeout terminates the handler and rejects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "hang.mjs");
  await writeFile(script, "setTimeout(() => {}, 10_000);\n");

  const runner = new HookRunner(
    parseHookConfig({ BeforeTool: [{ command: `node "${script}"`, timeoutSeconds: 1 }] }),
    silentLogging,
  );

  await assert.rejects(
    () => runner.run("BeforeTool", {
      workspaceId: "ws_test",
      workspaceRoot: root,
      workspaceMode: "checkout",
      payload: { tool: "bash" },
    }),
    /BeforeTool handler 1 timed out after 1s/,
  );
});

test("observational hook failure does not stop later handlers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failScript = join(root, "fail.mjs");
  const successScript = join(root, "success.mjs");
  await writeFile(failScript, "process.exit(9);\n");
  await writeFile(
    successScript,
    'import { writeFileSync } from "node:fs"; writeFileSync("continued.txt", "yes");\n',
  );

  const runner = new HookRunner(
    parseHookConfig({
      AfterTool: [
        { command: `node "${failScript}"` },
        { command: `node "${successScript}"` },
      ],
    }),
    silentLogging,
  );

  await runner.run("AfterTool", {
    workspaceId: "ws_test",
    workspaceRoot: root,
    workspaceMode: "checkout",
    payload: { tool: "read" },
  });

  assert.equal(await readFile(join(root, "continued.txt"), "utf8"), "yes");
});
