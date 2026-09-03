import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  allResponseText,
  callOpen,
  fixture,
  structuredContent,
} from "../../../runtime/testing/server-fixture.js";

const fakeServerPath = fileURLToPath(new URL("../../../lsp/test-fixtures/fake-lsp-server.mjs", import.meta.url));

test("Codex apply_patch automatically returns Language Server diagnostics in the mutation result", async (t) => {
  const context = await fixture(t, {
    env: { FORGERELAY_TOOL_MODE: "codex" },
  });
  await mkdir(join(context.project, "src"), { recursive: true });
  await writeFile(join(context.project, "tsconfig.json"), "{}\n");
  await writeFile(
    join(context.project, ".forgerelay", "language-servers.json"),
    JSON.stringify({
      "automatic-test": {
        command: process.execPath,
        args: [fakeServerPath],
        env: {
          FORGERELAY_FAKE_LSP_DIAGNOSTICS_MODE: "pull",
          FORGERELAY_FAKE_LSP_DIAGNOSTIC_COUNT: "1",
        },
        languages: ["typescript"],
        extensions: [".ts"],
        projectMarkers: ["tsconfig.json"],
      },
    }, null, 2) + "\n",
  );

  const conversation = "chat-automatic-codex-diagnostics";
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const result = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Add File: src/main.ts",
        "+const value: string = 1;",
        "*** End Patch",
      ].join("\n"),
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  assert.equal(result.isError, undefined);
  assert.match(allResponseText(result), /Automatic Language Server validation/);
  assert.match(allResponseText(result), /automatic-test · src\/main\.ts/);
  assert.match(allResponseText(result), /pulled diagnostic 1/);
  assert.equal(context.auditStore.getActivity("act_test_1")?.tool, "apply_patch");
  assert.equal(context.auditStore.getActivity("act_test_2"), undefined);
});
