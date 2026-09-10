import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExternalMcpCredentialStore, externalMcpCredentialIdentity } from "./external-mcp-auth-store.js";

void test("External MCP credential store isolates global and Project identities and writes 0600", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-auth-store-"));
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(configDir, { recursive: true, force: true })));
  const store = new ExternalMcpCredentialStore({ configDir });
  const globalIdentity = externalMcpCredentialIdentity("global", "example", "/unused");
  const projectA = externalMcpCredentialIdentity("project", "example", join(configDir, "project-a"));
  const projectB = externalMcpCredentialIdentity("project", "example", join(configDir, "project-b"));

  await store.replace(globalIdentity, "https://mcp.example.test/", {
    tokens: { access_token: "global-secret", token_type: "bearer" },
  });
  await store.replace(projectA, "https://mcp.example.test/", {
    tokens: { access_token: "project-a-secret", token_type: "bearer" },
  });
  await store.replace(projectB, "https://mcp.example.test/", {
    tokens: { access_token: "project-b-secret", token_type: "bearer" },
  });

  assert.equal(store.read(globalIdentity)?.tokens?.access_token, "global-secret");
  assert.equal(store.read(projectA)?.tokens?.access_token, "project-a-secret");
  assert.equal(store.read(projectB)?.tokens?.access_token, "project-b-secret");
  if (process.platform !== "win32") {
    assert.equal(statSync(store.filePath).mode & 0o777, 0o600);
  }
  const persisted = JSON.parse(readFileSync(store.filePath, "utf8")) as { version?: unknown; credentials?: unknown };
  assert.equal(persisted.version, 1);
  assert.equal(typeof persisted.credentials, "object");
});

void test("concurrent External MCP credential writers preserve unrelated identities", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-auth-concurrent-"));
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(configDir, { recursive: true, force: true })));
  const left = new ExternalMcpCredentialStore({ configDir });
  const right = new ExternalMcpCredentialStore({ configDir });
  const leftIdentity = externalMcpCredentialIdentity("global", "left", "/unused");
  const rightIdentity = externalMcpCredentialIdentity("global", "right", "/unused");

  await Promise.all([
    left.replace(leftIdentity, "https://left.example.test/mcp", {
      tokens: { access_token: "left-secret", token_type: "bearer" },
    }),
    right.replace(rightIdentity, "https://right.example.test/mcp", {
      tokens: { access_token: "right-secret", token_type: "bearer" },
    }),
  ]);

  assert.equal(left.read(leftIdentity)?.tokens?.access_token, "left-secret");
  assert.equal(left.read(rightIdentity)?.tokens?.access_token, "right-secret");
});

void test("External MCP credential parse errors never echo persisted secret contents", (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "forgerelay-mcp-auth-invalid-"));
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(configDir, { recursive: true, force: true })));
  const store = new ExternalMcpCredentialStore({ configDir });
  const leaked = "oauth-secret-that-must-not-appear";
  writeFileSync(store.filePath, `{\"secret\":\"${leaked}\"`, { mode: 0o600 });

  assert.throws(
    () => store.read(externalMcpCredentialIdentity("global", "example", "/unused")),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(leaked));
      assert.match(message, /invalid JSON/i);
      return true;
    },
  );
});
