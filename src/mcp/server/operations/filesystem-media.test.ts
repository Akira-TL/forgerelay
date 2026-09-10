import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  allResponseText,
  callOpen,
  fixture,
  responseCard,
  structuredContent,
} from "../../../runtime/testing/server-fixture.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcXcAAAAASUVORK5CYII=",
  "base64",
);

function callTool(
  client: Client,
  conversation: string,
  name: string,
  arguments_: Record<string, unknown>,
) {
  return client.callTool({
    name,
    arguments: arguments_,
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);
}

test("unscoped Read returns image media without opening a Workspace", async (t) => {
  const context = await fixture(t);
  const imagePath = join(context.project, "unscoped-image.dat");
  await writeFile(imagePath, PNG_BYTES);

  assert.equal(context.workspaces.cachedWorkspaceCount, 0);
  const result = await context.client.callTool({
    name: "read",
    arguments: { path: imagePath },
  });

  assert.equal(result.isError, undefined, allResponseText(result));
  const image = Array.isArray(result.content)
    ? result.content.find((entry) => entry.type === "image")
    : undefined;
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").equals(PNG_BYTES), true);
  assert.deepEqual(structuredContent(result).media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.doesNotMatch(JSON.stringify(structuredContent(result)), new RegExp(image.data.slice(0, 24)));
  assert.equal(context.workspaces.cachedWorkspaceCount, 0);
});

test("read recognizes supported image signatures and keeps media bytes transient", async (t) => {
  const context = await fixture(t, { env: { FORGERELAY_LOG_FORMAT: "json" } });
  const conversation = "chat-image-read";
  const imageFixtures = [
    { path: "png-disguised.txt", mimeType: "image/png", bytes: PNG_BYTES },
    {
      path: "jpeg-disguised.bin",
      mimeType: "image/jpeg",
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]),
    },
    {
      path: "gif-disguised.dat",
      mimeType: "image/gif",
      bytes: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x01, 0x02, 0x03]),
    },
    {
      path: "webp-disguised.jpg",
      mimeType: "image/webp",
      bytes: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    },
  ];
  for (const imageFixture of imageFixtures) {
    await writeFile(join(context.project, imageFixture.path), imageFixture.bytes);
  }
  await writeFile(join(context.project, "unsupported.bmp"), Buffer.from([0x42, 0x4d, 0x00, 0x01, 0x02, 0x03]));

  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const callRead = (arguments_: Record<string, unknown>) => callTool(
    context.client,
    conversation,
    "read",
    { workspaceId, ...arguments_ },
  );

  const originalLog = console.log;
  const originalWarn = console.warn;
  const logLines: string[] = [];
  console.log = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logLines.push(args.map(String).join(" "));
  const results: Awaited<ReturnType<typeof callRead>>[] = [];
  try {
    for (const imageFixture of imageFixtures) {
      results.push(await callRead({ path: imageFixture.path }));
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  for (const [index, imageFixture] of imageFixtures.entries()) {
    const result = results[index]!;
    assert.equal(result.isError, undefined, allResponseText(result));
    const content = Array.isArray(result.content)
      ? result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
      : [];
    const image = content.find((entry) => entry.type === "image");
    assert.ok(image?.data && image.mimeType);
    assert.equal(image.mimeType, imageFixture.mimeType);
    assert.equal(Buffer.from(image.data, "base64").equals(imageFixture.bytes), true);
    assert.match(allResponseText(result), new RegExp(`${imageFixture.mimeType}.*${imageFixture.bytes.byteLength} bytes`));
    assert.deepEqual(structuredContent(result).media, {
      type: "image",
      mimeType: imageFixture.mimeType,
      bytes: imageFixture.bytes.byteLength,
    });
    assert.doesNotMatch(JSON.stringify(structuredContent(result)), new RegExp(image.data.slice(0, 12)));
  }

  const firstResult = results[0]!;
  const firstImage = (firstResult.content as Array<{ type: string; data?: string }>).find((entry) => entry.type === "image");
  assert.ok(firstImage?.data);
  const card = responseCard(firstResult) as {
    summary?: { media?: { type?: string; mimeType?: string; bytes?: number } };
    payload?: { content?: Array<{ type?: string; data?: string }> };
  };
  assert.deepEqual(card.summary?.media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.equal(card.payload?.content?.some((entry) => entry.type === "image" || typeof entry.data === "string"), false);

  const audit = context.auditStore.getActivity("act_test_1");
  assert.deepEqual((audit?.result as Record<string, unknown> | undefined)?.media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(firstImage.data.slice(0, 24)));
  assert.doesNotMatch(logLines.join("\n"), new RegExp(firstImage.data.slice(0, 24)));
  assert.match(logLines.join("\n"), /"tool":"read"/);

  const unsupported = await callRead({ path: "unsupported.bmp" });
  assert.equal(unsupported.isError, undefined, allResponseText(unsupported));
  assert.equal(
    Array.isArray(unsupported.content) && unsupported.content.some((entry) => entry.type === "image"),
    false,
  );
  assert.equal(structuredContent(unsupported).media, undefined);

  for (const rangeArgument of [{ offset: 1 }, { limit: 1 }]) {
    const ranged = await callRead({ path: imageFixtures[0]!.path, ...rangeArgument });
    assert.equal(ranged.isError, true);
    assert.match(allResponseText(ranged), /image reads do not accept offset or limit/i);
  }
});

test("read enforces the decoded media budget before returning image data", async (t) => {
  const context = await fixture(t, { userConfig: { mediaMaxBytes: PNG_BYTES.byteLength - 1 } });
  const conversation = "chat-image-read-oversize";
  await writeFile(join(context.project, "oversize-image.png"), PNG_BYTES);
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);

  const result = await callTool(context.client, conversation, "read", {
    workspaceId,
    path: "oversize-image.png",
  });

  assert.equal(result.isError, true);
  assert.match(allResponseText(result), /media content exceeds the configured per-result limit/i);
  assert.equal(
    Array.isArray(result.content) && result.content.some((entry) => entry.type === "image"),
    false,
  );
  assert.equal(result.structuredContent, undefined);
  assert.doesNotMatch(JSON.stringify(context.auditStore.getActivity("act_test_1")), /iVBORw0KGgo/);
});

test("mixed bulk Read preserves order and applies one aggregate decoded media budget", async (t) => {
  const context = await fixture(t, { userConfig: { mediaMaxBytes: PNG_BYTES.byteLength } });
  const conversation = "chat-mixed-bulk-image-read";
  await writeFile(join(context.project, "bulk-text.txt"), "BULK-TEXT-SENTINEL\n");
  await writeFile(join(context.project, "bulk-image-a.png"), PNG_BYTES);
  await writeFile(join(context.project, "bulk-image-b.png"), PNG_BYTES);
  const opened = await callOpen(context.client, context.project, conversation);
  const workspaceId = String(structuredContent(opened).workspaceId);
  const turnId = String(structuredContent(await callTool(
    context.client,
    conversation,
    "activity_panel",
    { workspaceId },
  )).turnId);

  const result = await callTool(context.client, conversation, "read", {
    workspaceId,
    paths: ["bulk-text.txt", "bulk-image-a.png", "bulk-image-b.png"],
  });

  assert.equal(result.isError, undefined, allResponseText(result));
  const structured = structuredContent(result);
  const results = structured.results as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((entry) => [entry.path, entry.status]), [
    ["bulk-text.txt", "done"],
    ["bulk-image-a.png", "done"],
    ["bulk-image-b.png", "error"],
  ]);
  assert.match(String(results[0]?.result), /BULK-TEXT-SENTINEL/);
  assert.deepEqual(results[1]?.media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.equal(results[2]?.media, undefined);
  assert.match(String(results[2]?.result), /media content exceeds the configured per-result limit/i);
  assert.equal(structured.files, 3);
  assert.equal(structured.failed, 1);

  const liveImages = Array.isArray(result.content)
    ? result.content.filter((entry) => entry.type === "image")
    : [];
  assert.equal(liveImages.length, 1);
  assert.equal(liveImages[0]?.type, "image");
  if (liveImages[0]?.type === "image") {
    assert.equal(Buffer.from(liveImages[0].data, "base64").equals(PNG_BYTES), true);
    assert.doesNotMatch(JSON.stringify(structured), new RegExp(liveImages[0].data.slice(0, 24)));
  }

  const parentAudit = context.auditStore.getActivity("act_test_1");
  assert.deepEqual(parentAudit?.result, { childCount: 3, succeeded: 2, failed: 1 });
  const imageAudit = context.auditStore.getActivity("act_test_3");
  assert.deepEqual((imageAudit?.result as Record<string, unknown> | undefined)?.media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.doesNotMatch(JSON.stringify(parentAudit), /iVBORw0KGgo/);
  assert.doesNotMatch(JSON.stringify(imageAudit), /iVBORw0KGgo/);

  const activityIndex = structuredContent(await callTool(
    context.client,
    conversation,
    "activity_index",
    { turnId },
  ));
  assert.doesNotMatch(JSON.stringify(activityIndex), /iVBORw0KGgo/);
  const imageDetail = structuredContent(await callTool(
    context.client,
    conversation,
    "activity_detail",
    { turnId, activityId: "act_test_3" },
  ));
  assert.deepEqual((imageDetail.result as Record<string, unknown> | undefined)?.media, {
    type: "image",
    mimeType: "image/png",
    bytes: PNG_BYTES.byteLength,
  });
  assert.doesNotMatch(JSON.stringify(imageDetail), /iVBORw0KGgo/);
});
