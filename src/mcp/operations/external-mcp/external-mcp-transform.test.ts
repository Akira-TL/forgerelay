import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
  type ServerFixture,
} from "../../../runtime/testing/server-fixture.js";

const fixtureServer = fileURLToPath(new URL("./test-fixtures/external-mcp-server.mjs", import.meta.url));
const IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcXcAAAAASUVORK5CYII=";
const IMAGE_BYTES = Buffer.byteLength(IMAGE_BASE64, "base64");
const ARG_SECRET = "EXTERNAL_TRANSFORM_ARGUMENT_SECRET";
const FAILURE_SECRET = "EXTERNAL_TRANSFORM_FAILURE_SECRET";

void test("external MCP transform Hooks explicitly adapt request/result while unmatched references remain pass-through", async (t) => {
  const scripts = await createTransformScripts(t);
  const context = await createExternalTransformFixture(t, {
    beforeCommand: scripts.transform,
    afterCommand: scripts.transform,
  });
  await mkdir(join(context.project, "renders"), { recursive: true });
  await writeFile(join(context.project, "renders", "output.png"), Buffer.from(IMAGE_BASE64, "base64"));
  const { workspaceId, call } = await openExternalCapability(context, "chat-external-transform-success");

  const echoed = await call("echo_text", { message: ARG_SECRET });
  assert.equal(echoed.isError, undefined, allResponseText(echoed));
  assert.equal(allResponseText(echoed), `echo:hooked:${ARG_SECRET}`);
  assert.deepEqual((structuredContent(echoed).result as Record<string, unknown>).transforms, [{
    phase: "request",
    name: "Rewrite external request",
    scope: "global",
    status: "passed",
  }]);

  const pathOnly = await call("path_only");
  assert.equal(pathOnly.isError, undefined, allResponseText(pathOnly));
  const pathContent = Array.isArray(pathOnly.content)
    ? pathOnly.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    : [];
  assert.deepEqual(pathContent.map((entry) => entry.type), ["text", "image"]);
  assert.equal(pathContent[0]?.text, "transformed:renders/output.png");
  const image = pathContent[1];
  assert.equal(image?.mimeType, "image/png");
  assert.equal(image?.data, IMAGE_BASE64);
  const pathResult = structuredContent(pathOnly).result as Record<string, unknown>;
  assert.deepEqual(pathResult.content, [
    { type: "text", text: "transformed:renders/output.png" },
    { type: "image", mimeType: "image/png", bytes: IMAGE_BYTES },
  ]);
  assert.deepEqual(pathResult.transforms, [{
    phase: "result",
    name: "Convert renderer path",
    scope: "global",
    status: "passed",
  }]);
  assert.doesNotMatch(JSON.stringify(pathOnly.structuredContent), new RegExp(IMAGE_BASE64));

  const urlOnly = await call("url_only");
  assert.equal(urlOnly.isError, undefined, allResponseText(urlOnly));
  assert.equal(allResponseText(urlOnly), "https://renderer.invalid/renders/output.png");
  assert.deepEqual((structuredContent(urlOnly).result as Record<string, unknown>).transforms, undefined);

  const requestMetadata = JSON.parse(await readFile(join(context.project, "request-transform-metadata.json"), "utf8"));
  assert.deepEqual(requestMetadata, {
    event: "ExternalMcpBeforeForward",
    payload: {
      tool: "capability",
      capability: "mcp.external",
      externalServer: "blender",
      externalTool: "echo_text",
      transformPhase: "request",
    },
  });
  assert.doesNotMatch(JSON.stringify(requestMetadata), new RegExp(ARG_SECRET));
  const resultMetadata = JSON.parse(await readFile(join(context.project, "result-transform-metadata.json"), "utf8"));
  assert.deepEqual(resultMetadata, {
    event: "ExternalMcpAfterForward",
    payload: {
      tool: "capability",
      capability: "mcp.external",
      externalServer: "blender",
      externalTool: "path_only",
      transformPhase: "result",
    },
  });

  const activities = Array.from({ length: 8 }, (_, index) => context.auditStore.getActivity(`act_test_${index + 1}`))
    .filter((activity) => activity !== undefined);
  const transformedActivity = activities.find((activity) =>
    JSON.stringify(activity?.request).includes("path_only")
  );
  assert.ok(transformedActivity);
  assert.deepEqual(transformedActivity.result, {
    name: "mcp.external",
    action: "run",
    result: {
      operation: "call",
      server: "blender",
      tool: "path_only",
      contentTypes: ["text", "image"],
      media: [{ index: 1, mimeType: "image/png", bytes: IMAGE_BYTES }],
      transforms: [{ phase: "result", name: "Convert renderer path", scope: "global", status: "passed" }],
    },
  });
  assert.doesNotMatch(JSON.stringify(activities), new RegExp(IMAGE_BASE64));
  assert.doesNotMatch(JSON.stringify(activities), new RegExp(ARG_SECRET));
  assert.equal(workspaceId.startsWith("ws_"), true);
});

void test("transformed external MCP media is revalidated by the normal media budget", async (t) => {
  const scripts = await createTransformScripts(t);
  const context = await createExternalTransformFixture(t, {
    afterCommand: scripts.transform,
    mediaMaxBytes: IMAGE_BYTES - 1,
  });
  await mkdir(join(context.project, "renders"), { recursive: true });
  await writeFile(join(context.project, "renders", "output.png"), Buffer.from(IMAGE_BASE64, "base64"));
  const { call } = await openExternalCapability(context, "chat-external-transform-budget");

  const transformed = await call("path_only");
  assert.equal(transformed.isError, true);
  assert.match(allResponseText(transformed), /mcp\.media_too_large.*blender.*path_only/i);
  assert.equal(Array.isArray(transformed.content) && transformed.content.some((entry) => entry.type === "image"), false);
  assert.doesNotMatch(JSON.stringify(transformed), new RegExp(IMAGE_BASE64));
});

void test("external MCP transform Hook failure is attributable and does not leak hook output", async (t) => {
  const scripts = await createTransformScripts(t);
  const context = await createExternalTransformFixture(t, { afterCommand: scripts.fail });
  const { call } = await openExternalCapability(context, "chat-external-transform-failure");
  const logLines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...values: unknown[]) => logLines.push(values.map(String).join(" "));
  console.warn = (...values: unknown[]) => logLines.push(values.map(String).join(" "));
  let result;
  try {
    result = await call("path_only");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.equal(result.isError, true);
  assert.match(allResponseText(result), /mcp\.transform_failed.*blender.*path_only.*Convert renderer path/i);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(FAILURE_SECRET));
  assert.doesNotMatch(logLines.join("\n"), new RegExp(FAILURE_SECRET));
  const activity = context.auditStore.getActivity("act_test_1");
  assert.equal(activity?.state, "failed");
  assert.deepEqual(activity?.result, {
    name: "mcp.external",
    action: "run",
    error: { code: "mcp.transform_failed" },
  });
  assert.doesNotMatch(JSON.stringify(activity), new RegExp(FAILURE_SECRET));
});

void test("external MCP transform output cannot retarget the configured server/tool", async (t) => {
  const scripts = await createTransformScripts(t);
  const context = await createExternalTransformFixture(t, { beforeCommand: scripts.retarget });
  const { call } = await openExternalCapability(context, "chat-external-transform-retarget");

  const result = await call("echo_text", { message: "original" });
  assert.equal(result.isError, true);
  assert.match(allResponseText(result), /mcp\.transform_failed.*structured transform output/i);
  assert.doesNotMatch(JSON.stringify(result), /not-configured/);
});

async function createExternalTransformFixture(
  t: TestContext,
  options: {
    beforeCommand?: string;
    afterCommand?: string;
    mediaMaxBytes?: number;
  },
): Promise<ServerFixture> {
  return fixture(t, {
    hooks: {
      ...(options.beforeCommand
        ? {
            ExternalMcpBeforeForward: [{
              matcher: {
                tool: "capability",
                capability: "mcp.external",
                externalServer: "blender",
                externalTool: "echo_text",
              },
              handlers: [{ name: "Rewrite external request", command: options.beforeCommand }],
            }],
          }
        : {}),
      ...(options.afterCommand
        ? {
            ExternalMcpAfterForward: [{
              matcher: {
                tool: "capability",
                capability: "mcp.external",
                externalServer: "blender",
                externalTool: "path_only",
              },
              handlers: [{ name: "Convert renderer path", command: options.afterCommand }],
            }],
          }
        : {}),
    },
    userConfig: {
      ...(options.mediaMaxBytes !== undefined ? { mediaMaxBytes: options.mediaMaxBytes } : {}),
      mcpServers: {
        blender: {
          transport: "stdio",
          command: process.execPath,
          args: [fixtureServer],
        },
      },
    },
  });
}

async function openExternalCapability(
  context: ServerFixture,
  conversation: string,
): Promise<{
  workspaceId: string;
  call: (tool: string, arguments_?: Record<string, unknown>) => Promise<Awaited<ReturnType<Client["callTool"]>>>;
}> {
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  return {
    workspaceId,
    call: (tool, arguments_ = {}) => context.client.callTool({
      name: "capability",
      arguments: {
        workspaceId,
        name: "mcp.external",
        action: "run",
        arguments: { operation: "call", server: "blender", tool, arguments: arguments_ },
      },
      _meta: { "openai/session": conversation },
    } as Parameters<Client["callTool"]>[0]),
  };
}

async function createTransformScripts(t: TestContext): Promise<{
  transform: string;
  fail: string;
  retarget: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "forgerelay-external-transform-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transformScript = join(root, "transform.mjs");
  const failureScript = join(root, "fail.mjs");
  const retargetScript = join(root, "retarget.mjs");
  await writeFile(transformScript, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'let raw = "";',
    'for await (const chunk of process.stdin) raw += chunk;',
    'const input = JSON.parse(raw);',
    'const payload = JSON.parse(process.env.FORGERELAY_HOOK_PAYLOAD ?? "{}");',
    'if (input.phase === "request") {',
    '  writeFileSync("request-transform-metadata.json", JSON.stringify({ event: process.env.FORGERELAY_HOOK_EVENT, payload }));',
    '  process.stdout.write(JSON.stringify({ version: 1, request: { arguments: { ...input.request.arguments, message: `hooked:${input.request.arguments.message}` } } }));',
    '} else {',
    '  writeFileSync("result-transform-metadata.json", JSON.stringify({ event: process.env.FORGERELAY_HOOK_EVENT, payload }));',
    '  const path = input.result.content.find((entry) => entry.type === "text")?.text;',
    '  const data = readFileSync(path).toString("base64");',
    '  process.stdout.write(JSON.stringify({ version: 1, result: { content: [{ type: "text", text: `transformed:${path}` }, { type: "image", data, mimeType: "image/png" }] } }));',
    '}',
    '',
  ].join("\n"));
  await writeFile(failureScript, [
    `console.error(${JSON.stringify(FAILURE_SECRET)});`,
    "process.exit(7);",
    "",
  ].join("\n"));
  await writeFile(retargetScript, [
    'let raw = "";',
    'for await (const chunk of process.stdin) raw += chunk;',
    'const input = JSON.parse(raw);',
    'process.stdout.write(JSON.stringify({ version: 1, server: "not-configured", request: input.request }));',
    '',
  ].join("\n"));
  return {
    transform: hookCommand(transformScript),
    fail: hookCommand(failureScript),
    retarget: hookCommand(retargetScript),
  };
}

function hookCommand(path: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}
