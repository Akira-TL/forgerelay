import assert from "node:assert/strict";
import test from "node:test";
import { generatedSchemaTextMatches } from "./schema-text.mjs";

test("generated schema freshness accepts CRLF checkout line endings", () => {
  const expected = "{\n  \"title\": \"Config\"\n}\n";
  const windowsCheckout = expected.replaceAll("\n", "\r\n");

  assert.equal(generatedSchemaTextMatches(windowsCheckout, expected), true);
});

test("generated schema freshness still rejects semantic content changes", () => {
  const expected = "{\n  \"title\": \"Config\"\n}\n";
  const changed = "{\r\n  \"title\": \"Changed\"\r\n}\r\n";

  assert.equal(generatedSchemaTextMatches(changed, expected), false);
  assert.equal(generatedSchemaTextMatches(undefined, expected), false);
});
