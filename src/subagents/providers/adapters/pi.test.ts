import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLineRpc } from "./pi.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function rpcFixture(): { child: FakeChild; rpc: JsonLineRpc } {
  const child = new FakeChild();
  return {
    child,
    rpc: new JsonLineRpc(child as unknown as ChildProcessWithoutNullStreams),
  };
}

test("Pi RPC rejects an unterminated oversized stdout line and terminates the child", async () => {
  const { child, rpc } = rpcFixture();
  const pending = rpc.request({ type: "get_state" });
  child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));

  await assert.rejects(pending, /line exceeded 8388608 bytes/i);
  assert.equal(child.killed, true);
});

test("Pi RPC waiters fail immediately when the transport becomes fatal", async () => {
  const { child, rpc } = rpcFixture();
  const waiting = rpc.waitForEvent(() => false, 60_000);
  child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));

  await assert.rejects(waiting, /line exceeded 8388608 bytes/i);
});

test("Pi RPC retains only a bounded stderr tail for process failures", async () => {
  const { child, rpc } = rpcFixture();
  const pending = rpc.request({ type: "get_state" });
  child.stderr.write(`${"x".repeat(256 * 1024)}TAIL_MARKER`);
  child.emit("exit", 1, null);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /TAIL_MARKER/);
    assert.ok(Buffer.byteLength(error.message, "utf8") < 140 * 1024);
    return true;
  });
});
