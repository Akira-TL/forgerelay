import assert from "node:assert/strict";
import {
  HeadTailBuffer,
  ProcessManager,
  ProcessSessionManager,
  resolveProcessId,
} from "./process-sessions.js";

const smallBuffer = new HeadTailBuffer(100);
smallBuffer.append("hello\n");
assert.deepEqual(smallBuffer.drain(100), { output: "hello\n", truncated: false });
assert.deepEqual(smallBuffer.drain(100), { output: "", truncated: false });

const headTail = new HeadTailBuffer(10);
headTail.append("start-middle-end");
const headTailResult = headTail.drain(1_000);
assert.equal(headTailResult.truncated, true);
assert.match(headTailResult.output, /^start/);
assert.match(headTailResult.output, /e-end$/);
assert.match(headTailResult.output, /characters omitted/);

const responseLimited = new HeadTailBuffer(100);
responseLimited.append("abcdef".repeat(20));
const responseLimitedResult = responseLimited.drain(40);
assert.equal(responseLimitedResult.truncated, true);
assert.match(responseLimitedResult.output, /^abc/);
assert.match(responseLimitedResult.output, /def$/);

const unicodeBuffer = new HeadTailBuffer(4);
unicodeBuffer.append("a🙂b🙂c");
const unicodeResult = unicodeBuffer.drain(1_000);
assert.equal(unicodeResult.truncated, true);
assert.match(unicodeResult.output, /^a🙂/);
assert.match(unicodeResult.output, /🙂c$/);

assert.equal(ProcessSessionManager, ProcessManager);
assert.equal(resolveProcessId(7, undefined), 7);
assert.equal(resolveProcessId(undefined, 7), 7);
assert.equal(resolveProcessId(7, 7), 7);
assert.throws(() => resolveProcessId(undefined, undefined), /processId is required/);
assert.throws(() => resolveProcessId(7, 8), /must identify the same process/);

const manager = new ProcessManager({
  maxBufferCharacters: 1_024,
  completedProcessTtlMs: 1_000,
});

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

async function waitForCompleted(
  processManager: ProcessManager,
  workspaceId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed = processManager.takeCompleted(workspaceId);
    if (completed.length > 0) return completed;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processManager.takeCompleted(workspaceId);
}

const foreground = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('foreground')"`,
  yieldTimeMs: 2_000,
});
assert.equal(foreground.running, false);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.output, /foreground/);
assert.equal(foreground.processId, undefined);
assert.equal(foreground.sessionId, undefined);
assert.ok(foreground.wallTimeMs >= 0);

const regularEnvironment = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log(process.env.CODEX_CI ?? 'unset')"`,
  yieldTimeMs: 2_000,
});
assert.equal(regularEnvironment.running, false);
assert.match(regularEnvironment.output, /unset/);

const environment = await manager.start({
  workspaceId: "workspace-a",
  workspaceRoot: "/tmp/devspace-workspace-a",
  cwd: process.cwd(),
  codexCi: true,
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.DEVSPACE_WORKSPACE_ID, process.env.DEVSPACE_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/devspace-workspace-a/);

const background = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('finished'), 100)"`,
  yieldTimeMs: 5,
});
assert.equal(background.running, true);
assert.ok(background.processId);
assert.equal(typeof background.processId, "number");
assert.equal(background.sessionId, background.processId);

await assert.rejects(
  manager.write({
    workspaceId: "workspace-b",
    processId: background.processId,
    yieldTimeMs: 1,
  }),
  /does not belong to workspace/,
);

// Deprecated sessionId remains accepted during the compatibility window.
const completed = await manager.write({
  workspaceId: "workspace-a",
  sessionId: background.processId,
  yieldTimeMs: 2_000,
});
assert.equal(completed.running, false);
assert.equal(completed.exitCode, 0);
assert.match(completed.output, /finished/);
assert.deepEqual(manager.takeCompleted("workspace-a"), []);

const autoCompleted = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('auto-finished'), 40)"`,
  yieldTimeMs: 1,
});
assert.equal(autoCompleted.running, true);
assert.ok(autoCompleted.processId);
assert.equal(manager.activeWorkspaceIds().has("workspace-a"), true);
const notices = await waitForCompleted(manager, "workspace-a");
assert.equal(notices.length, 1);
assert.equal(notices[0]?.processId, autoCompleted.processId);
assert.equal(notices[0]?.sessionId, autoCompleted.processId);
assert.match(notices[0]?.command ?? "", /auto-finished/);
assert.match(notices[0]?.output ?? "", /auto-finished/);

const interactive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 5,
});
assert.equal(interactive.running, true);
assert.ok(interactive.processId);
assert.equal(typeof interactive.processId, "number");

const inputResult = await manager.write({
  workspaceId: "workspace-a",
  processId: interactive.processId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(inputResult.running, false);
assert.match(inputResult.output, /input:hello/);

const defaultInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
  yieldTimeMs: 5,
});
assert.equal(defaultInteractive.running, true);
assert.ok(defaultInteractive.processId);

const defaultInputResult = await manager.write({
  workspaceId: "workspace-a",
  processId: defaultInteractive.processId,
  chars: "hello\n",
});
assert.equal(defaultInputResult.running, false);
assert.match(defaultInputResult.output, /default-input:hello/);

const noisyInteractive = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10); process.stdin.once('data', data => { console.log('input:' + data.toString().trim()); process.exit(0); })"`,
  yieldTimeMs: 100,
});
assert.equal(noisyInteractive.running, true);
assert.ok(noisyInteractive.processId);

await new Promise((resolve) => setTimeout(resolve, 50));
const noisyInputResult = await manager.write({
  workspaceId: "workspace-a",
  processId: noisyInteractive.processId,
  chars: "hello\n",
  yieldTimeMs: 2_000,
});
assert.equal(noisyInputResult.running, false);
assert.match(noisyInputResult.output, /input:hello/);

const interruptible = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "setInterval(() => console.log('tick'), 10)"`,
  yieldTimeMs: 100,
});
assert.equal(interruptible.running, true);
assert.ok(interruptible.processId);

await new Promise((resolve) => setTimeout(resolve, 50));
const interrupted = await manager.write({
  workspaceId: "workspace-a",
  processId: interruptible.processId,
  chars: "\u0003",
  yieldTimeMs: 2_000,
});
assert.equal(interrupted.running, false);
if (process.platform !== "win32") assert.equal(interrupted.signal, "SIGINT");

let buffered = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('x'.repeat(5000)); setTimeout(() => {}, 100)"`,
  yieldTimeMs: 50,
  maxOutputTokens: 100,
});
if (!buffered.outputTruncated && buffered.processId) {
  buffered = await manager.write({
    workspaceId: "workspace-a",
    processId: buffered.processId,
    yieldTimeMs: 2_000,
    maxOutputTokens: 100,
  });
}
assert.equal(buffered.outputTruncated, true);
if (buffered.processId) manager.terminate("workspace-a", buffered.processId);

try {
  if (process.platform === "win32") {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: "echo pty-ok",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.match(pty.output, /pty-ok/);
  } else {
    const pty = await manager.start({
      workspaceId: "workspace-a",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => console.log('columns:' + process.stdout.columns), 250)"`,
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 10,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.processId);

    const resizedPty = await manager.write({
      workspaceId: "workspace-a",
      processId: pty.processId,
      columns: 120,
      rows: 30,
      yieldTimeMs: 2_000,
    });
    assert.equal(resizedPty.running, false);
    assert.match(resizedPty.output, /columns:120/);
  }
} finally {
  manager.shutdown();
}

let monotonicNow = 100;
const timingManager = new ProcessManager({ monotonicNow: () => monotonicNow });
const timingResultPromise = timingManager.start({
  workspaceId: "workspace-time",
  cwd: process.cwd(),
  command: `${node} -e "process.exit(0)"`,
  yieldTimeMs: 2_000,
});
monotonicNow = 90;
const timingResult = await timingResultPromise;
assert.equal(timingResult.wallTimeMs, 0);
timingManager.shutdown();
