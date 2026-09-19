import assert from "node:assert/strict";
import type { ProcessOutputAuditSink } from "../../activity/runtime/process-output-audit.js";
import {
  DEFAULT_POLL_YIELD_MS,
  HeadTailBuffer,
  ProcessManager,
  ProcessSessionManager,
  resolveProcessId,
} from "./process-sessions.js";
import { waitOnlyYieldMs } from "./process-wait-policy.js";

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

assert.equal(DEFAULT_POLL_YIELD_MS, 60_000);
assert.equal(waitOnlyYieldMs(undefined), 60_000);
assert.equal(waitOnlyYieldMs(5_000), 60_000);
assert.equal(waitOnlyYieldMs(60_000), 60_000);
assert.equal(waitOnlyYieldMs(90_000), 90_000);
assert.equal(waitOnlyYieldMs(25, 80), 80);
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

if (process.platform !== "win32") {
  const runtime = {
    family: "bash" as const,
    executable: "/bin/bash",
    source: "recorded" as const,
    capabilities: ["bash", "profile-isolation", "posix-command-language"],
  };
  const stableRuntimeManager = new ProcessManager({ commandShellRuntime: runtime });
  runtime.family = "bash";
  runtime.executable = "/definitely/not/the-runtime-after-construction";
  const stableRuntime = await stableRuntimeManager.start({
    workspaceId: "stable-runtime",
    cwd: process.cwd(),
    command: "printf stable-shell-runtime",
    yieldTimeMs: 2_000,
  });
  assert.equal(stableRuntime.exitCode, 0);
  assert.match(stableRuntime.output, /stable-shell-runtime/);
  stableRuntimeManager.shutdown();
}

const node = process.platform === "win32"
  ? `"${process.execPath}"`
  : JSON.stringify(process.execPath);

if (process.platform === "win32") {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cmdExecutable = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const cmdRoot = await mkdtemp(join(tmpdir(), "forgerelay-cmd-runtime-test-"));
  const cmdManager = new ProcessManager({
    commandShellRuntime: {
      family: "cmd",
      executable: cmdExecutable,
      source: "explicit",
      capabilities: ["cmd-command-language"],
    },
  });
  try {
    const environmentExpansion = await cmdManager.start({
      workspaceId: "cmd-runtime",
      cwd: process.cwd(),
      command: "echo [%ComSpec%]",
      yieldTimeMs: 2_000,
    });
    assert.equal(environmentExpansion.exitCode, 0);
    assert.match(environmentExpansion.output.toLowerCase(), /\\cmd\.exe\]/);

    const quotedNativeExecutable = await cmdManager.start({
      workspaceId: "cmd-runtime",
      cwd: process.cwd(),
      command: `"${process.execPath}" -e "console.log('cmd-native-ok')"`,
      yieldTimeMs: 2_000,
    });
    assert.equal(quotedNativeExecutable.exitCode, 0);
    assert.match(quotedNativeExecutable.output, /cmd-native-ok/);

    await writeFile(
      join(cmdRoot, "errorlevel.cmd"),
      `@"${process.execPath}" -e "process.exit(7)"\r\n@echo error=%ERRORLEVEL%\r\n@exit /b 0\r\n`,
    );
    const errorLevel = await cmdManager.start({
      workspaceId: "cmd-runtime",
      cwd: cmdRoot,
      command: "errorlevel.cmd",
      yieldTimeMs: 2_000,
    });
    assert.equal(errorLevel.exitCode, 0);
    assert.match(errorLevel.output, /error=7/);

    const propagatedFailure = await cmdManager.start({
      workspaceId: "cmd-runtime",
      cwd: process.cwd(),
      command: "exit /b 23",
      yieldTimeMs: 2_000,
    });
    assert.equal(propagatedFailure.exitCode, 23);
  } finally {
    cmdManager.shutdown();
    await rm(cmdRoot, { recursive: true, force: true });
  }
}

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
  workspaceRoot: "/tmp/forgerelay-workspace-a",
  cwd: process.cwd(),
  codexCi: true,
  command: `${node} -e "console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER, process.env.GH_PAGER, process.env.CODEX_CI, process.env.FORGERELAY_WORKSPACE_ID, process.env.FORGERELAY_WORKSPACE_ROOT].join(','))"`,
  yieldTimeMs: 2_000,
});
assert.equal(environment.running, false);
assert.match(environment.output, /1,dumb,cat,cat,cat,1,workspace-a,\/tmp\/forgerelay-workspace-a/);

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

let resolveBufferedOutput!: () => void;
const bufferedOutputReady = new Promise<void>((resolve) => {
  resolveBufferedOutput = resolve;
});
const pollingAudit: ProcessOutputAuditSink = {
  begin: () => "out_polling_test",
  append: (_outputId, _channel, data) => {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    if (text.includes("buffered-default-ready")) resolveBufferedOutput();
  },
  finish: () => undefined,
};
const pollingManager = new ProcessManager({
  minimumPollYieldMs: 80,
  outputAudit: pollingAudit,
});
try {
  const minimumPollWait = await pollingManager.start({
    workspaceId: "workspace-polling",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => {}, 1000)"`,
    yieldTimeMs: 0,
  });
  assert.equal(minimumPollWait.running, true);
  assert.ok(minimumPollWait.processId);
  const minimumPollStartedAt = performance.now();
  const minimumPollResult = await pollingManager.write({
    workspaceId: "workspace-polling",
    processId: minimumPollWait.processId,
    yieldTimeMs: 25,
  });
  const minimumPollElapsedMs = performance.now() - minimumPollStartedAt;
  assert.equal(minimumPollResult.running, true);
  assert.ok(
    minimumPollElapsedMs >= 65,
    `positive short wait-only polls must honor the configured minimum; elapsed=${minimumPollElapsedMs}`,
  );

  const immediateProbe = await pollingManager.write({
    workspaceId: "workspace-polling",
    processId: minimumPollWait.processId,
    yieldTimeMs: 0,
  });
  assert.equal(immediateProbe.running, true);
  await assert.rejects(
    () => pollingManager.write({
      workspaceId: "workspace-polling",
      processId: minimumPollWait.processId,
      yieldTimeMs: 0,
    }),
    /immediate wait-only status probe.*already used/i,
  );

  const bufferedDefaultWait = await pollingManager.start({
    workspaceId: "workspace-polling",
    cwd: process.cwd(),
    command: `${node} -e "console.log('buffered-default-ready'); setTimeout(() => {}, 1000)"`,
    yieldTimeMs: 0,
    audit: { activityId: "act_polling", turnId: "turn_polling" },
  });
  assert.equal(bufferedDefaultWait.running, true);
  assert.ok(bufferedDefaultWait.processId);
  await Promise.race([
    bufferedOutputReady,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("buffered output was not observed")), 1_000);
    }),
  ]);
  const bufferedPollStartedAt = performance.now();
  const bufferedDefaultResult = await pollingManager.write({
    workspaceId: "workspace-polling",
    processId: bufferedDefaultWait.processId,
  });
  const bufferedPollElapsedMs = performance.now() - bufferedPollStartedAt;
  assert.equal(bufferedDefaultResult.running, true);
  assert.ok(
    bufferedPollElapsedMs >= 65,
    `buffered output must not bypass the configured wait-only minimum; elapsed=${bufferedPollElapsedMs}`,
  );
} finally {
  pollingManager.shutdown();
}

const earlyCompletionManager = new ProcessManager({ minimumPollYieldMs: 1_000 });
try {
  const completesEarly = await earlyCompletionManager.start({
    workspaceId: "workspace-early-completion",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('completed-before-minimum'), 75)"`,
    yieldTimeMs: 0,
  });
  assert.equal(completesEarly.running, true);
  assert.ok(completesEarly.processId);
  const completedBeforeMinimum = await Promise.race([
    earlyCompletionManager.write({
      workspaceId: "workspace-early-completion",
      processId: completesEarly.processId,
      yieldTimeMs: 25,
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("process completion did not return before the one-second poll minimum")),
        600,
      );
    }),
  ]);
  assert.equal(completedBeforeMinimum.running, false);
  assert.match(completedBeforeMinimum.output, /completed-before-minimum/);
} finally {
  earlyCompletionManager.shutdown();
}

const bufferedWait = await manager.start({
  workspaceId: "workspace-a",
  cwd: process.cwd(),
  command: `${node} -e "console.log('wait-ready'); const timer = setInterval(() => console.log('wait-tick'), 10); setTimeout(() => { clearInterval(timer); console.log('wait-finished'); }, 2000)"`,
  yieldTimeMs: 1,
});
assert.equal(bufferedWait.running, true);
assert.ok(bufferedWait.processId);

const initialBufferedOutput = await manager.write({
  workspaceId: "workspace-a",
  processId: bufferedWait.processId,
  yieldTimeMs: 0,
});
assert.equal(initialBufferedOutput.running, true);

// A later explicit wait must wait for completion instead of degrading to repeated
// non-blocking status probes.
const waitedToCompletion = await manager.write({
  workspaceId: "workspace-a",
  processId: bufferedWait.processId,
  yieldTimeMs: 2_000,
});
assert.equal(waitedToCompletion.running, false);
assert.equal(waitedToCompletion.exitCode, 0);
assert.match(waitedToCompletion.output, /wait-finished/);

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
  command: `${node} -e "console.log('default-ready'); process.stdin.once('data', data => setTimeout(() => { console.log('default-input:' + data.toString().trim()); process.exit(0); }, 100))"`,
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

const activeLimitManager = new ProcessManager({ maxActiveProcesses: 2 });
try {
  for (let index = 0; index < 2; index += 1) {
    const started = await activeLimitManager.start({
      workspaceId: "workspace-active-limit",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 5_000)"`,
      yieldTimeMs: 1,
    });
    assert.equal(started.running, true);
  }
  await assert.rejects(
    () => activeLimitManager.start({
      workspaceId: "workspace-active-limit",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 5_000)"`,
      yieldTimeMs: 1,
    }),
    /Active process limit reached \(2\)/,
  );
} finally {
  activeLimitManager.shutdown();
}

const retentionManager = new ProcessManager();
const retainedBackground = await retentionManager.start({
  workspaceId: "workspace-retention",
  cwd: process.cwd(),
  command: `${node} -e "setTimeout(() => console.log('retained'), 40)"`,
  yieldTimeMs: 1,
});
assert.equal(retainedBackground.running, true);
assert.ok(retainedBackground.processId);
const retentionInternals = retentionManager as unknown as {
  processes: Map<number, {
    running: boolean;
    process?: unknown;
    cleanupTimer?: NodeJS.Timeout;
  }>;
};
const retentionDeadline = Date.now() + 2_000;
while (
  retentionInternals.processes.get(retainedBackground.processId)?.running &&
  Date.now() < retentionDeadline
) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const retainedEntries = [...retentionInternals.processes.values()];
assert.equal(retainedEntries.length, 1);
assert.equal(retainedEntries[0]?.running, false);
assert.equal(retainedEntries[0]?.process, undefined);
const cleanupTimerMs = Number(
  (retainedEntries[0]?.cleanupTimer as unknown as { _idleTimeout?: number } | undefined)?._idleTimeout
    ?? Infinity,
);
assert.ok(
  cleanupTimerMs <= 5 * 60 * 1_000,
  "completed processes must expire within five minutes",
);
retentionManager.shutdown();

const boundedManager = new ProcessManager({
  maxBufferCharacters: 256,
  maxCompletedProcesses: 2,
});
const boundedProcessIds: number[] = [];
const boundedInternals = boundedManager as unknown as {
  processes: Map<number, { running: boolean }>;
};
for (let index = 0; index < 3; index += 1) {
  const started = await boundedManager.start({
    workspaceId: "workspace-bounded",
    cwd: process.cwd(),
    command: `${node} -e "setTimeout(() => console.log('${index}'), 30)"`,
    yieldTimeMs: 1,
  });
  assert.equal(started.running, true);
  assert.ok(started.processId);
  boundedProcessIds.push(started.processId);
  const completionDeadline = Date.now() + 2_000;
  while (
    boundedInternals.processes.get(started.processId)?.running &&
    Date.now() < completionDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(boundedInternals.processes.get(started.processId)?.running, false);
}
assert.equal(boundedInternals.processes.size, 2);
assert.equal(boundedInternals.processes.has(boundedProcessIds[0]!), false);
assert.equal(boundedInternals.processes.has(boundedProcessIds[1]!), true);
assert.equal(boundedInternals.processes.has(boundedProcessIds[2]!), true);
boundedManager.shutdown();

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
