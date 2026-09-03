import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { findExecutable, probeExecutable } from "./interop-support.mjs";

const root = mkdtempSync(join(tmpdir(), "forgerelay-lsp-preflight-test-"));

try {
  const env = { ...process.env, PATH: root };
  if (process.platform === "win32") {
    env.PATHEXT = ".CMD";
    writeFileSync(join(root, "working.cmd"), "@echo off\r\nif \"%1\"==\"--version\" echo fake-lsp 1.0.0 & exit /b 0\r\n", "utf8");
    writeFileSync(join(root, "broken.cmd"), "@echo off\r\necho error: Unknown binary 1>&2\r\nexit /b 1\r\n", "utf8");
  } else {
    writeFileSync(join(root, "working"), "#!/bin/sh\necho fake-lsp 1.0.0\nexit 0\n", "utf8");
    writeFileSync(join(root, "broken"), "#!/bin/sh\necho 'error: Unknown binary' >&2\nexit 1\n", "utf8");
    chmodSync(join(root, "working"), 0o755);
    chmodSync(join(root, "broken"), 0o755);
  }

  test("interop preflight distinguishes runnable executables from PATH proxies that fail", () => {
    const working = findExecutable("working", env);
    const broken = findExecutable("broken", env);
    assert.ok(working);
    assert.ok(broken);
    assert.deepEqual(probeExecutable(working, env), { available: true });
    const unavailable = probeExecutable(broken, env);
    assert.equal(unavailable.available, false);
    assert.match(unavailable.reason, /Unknown binary|exit 1/i);
  });

  test("interop preflight treats a missing command as unavailable without installation", () => {
    assert.equal(findExecutable("missing-language-server", env), undefined);
    assert.equal(env.PATH.split(delimiter).length, 1);
  });
} finally {
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
}
