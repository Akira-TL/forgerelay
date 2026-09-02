import assert from "node:assert/strict";
import test from "node:test";
import { activityDetailCard, hasRichActivityPayload } from "./detail-card.js";
import type { ActivityDetail } from "./model.js";

function detail(result: unknown, request: unknown = { workspaceId: "ws_test", path: "src/example.ts" }): ActivityDetail {
  return {
    activity: {
      activityId: "act_edit",
      tool: "edit",
      kind: "edit",
      status: "done",
      state: "done",
      title: "Edit",
      target: "src/example.ts",
      detailAvailable: true,
      startedAt: "2026-09-02T00:00:00.000Z",
    },
    request,
    result,
  };
}

test("Activity detail reconstructs the original rich Edit card only after lazy detail is loaded", () => {
  const card = activityDetailCard(detail({
    _meta: {
      tool: "edit",
      card: {
        path: "src/example.ts",
        summary: { additions: 1, removals: 1 },
        payload: { patch: "@@ -1 +1 @@\n-before\n+after\n" },
      },
    },
  }));

  assert.ok(card);
  assert.equal(card.tool, "edit");
  assert.equal(card.workspaceId, "ws_test");
  assert.equal(card.path, "src/example.ts");
  assert.equal(hasRichActivityPayload(card), true);
});

test("Activity detail does not invent a rich payload when audit metadata has no display card", () => {
  assert.equal(activityDetailCard(detail({ structuredContent: { result: "Edited." } })), undefined);
});
