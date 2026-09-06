#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("cmd.exe packaged acceptance skipped outside Windows.");
  process.exit(0);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("cmd acceptance must run through npm so npm_execpath is available");

const root = await mkdtemp(join(tmpdir(), "forgerelay-cmd-acceptance-"));
try {
  const cmd = resolveCmd();
  const runtime = {
    family: "cmd",
    executable: cmd,
    source: "explicit",
    capabilities: ["cmd-command-language"],
  };

  await exercisePtyLifecycle(runtime);
  await exercisePackagedCmdShim(cmd);

  console.log(`cmd.exe acceptance passed with ${cmd}.`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function resolveCmd() {
  const executable = process.env.ComSpec ?? process.env.COMSPEC;
  if (!executable || !existsSync(executable)) {
    throw new Error(`Windows cmd acceptance requires a valid ComSpec; got ${executable ?? "unset"}.`);
  }
  return executable;
}

async function exercisePtyLifecycle(runtime) {
  const [{ ProcessManager }, { BashOutputStore }] = await Promise.all([
    import("../../dist/mcp/process/process-sessions.js"),
    import("../../dist/activity/history/bash-output-store.js"),
  ]);
  const durableStateDir = join(root, "durable-output-state");
  const outputStore = new BashOutputStore(durableStateDir, {
    outputId: () => "out_cmd_pty_acceptance",
    flushBytes: 1,
  });
  const manager = new ProcessManager({
    commandShellRuntime: runtime,
    outputAudit: outputStore,
  });

  try {
    const node = quoteCmdArg(process.execPath);
    const pty = await manager.start({
      workspaceId: "cmd-agent",
      workspaceRoot: process.cwd(),
      audit: {
        activityId: "act-cmd-pty",
        turnId: "turn-cmd-pty",
        conversationScopeId: "conversation-cmd-pty",
      },
      cwd: process.cwd(),
      command: [
        "chcp 65001 >nul",
        "setlocal EnableDelayedExpansion",
        "echo cmd-pty-ready-雪",
        "set /p FR_CMD_LINE=",
        "echo stdin=!FR_CMD_LINE!",
        `${node} -e "console.log('cols=' + process.stdout.columns + ';rows=' + process.stdout.rows)"`,
        `${node} -e "console.log('cmd-pty-unicode-🙂')"`,
        "exit /b 23",
      ].join(" & "),
      tty: true,
      columns: 80,
      rows: 24,
      yieldTimeMs: 5,
    });
    assert.equal(pty.running, true);
    assert.ok(pty.processId);
    assert.equal(pty.outputId, "out_cmd_pty_acceptance");

    const interacted = await manager.write({
      workspaceId: "cmd-agent",
      processId: pty.processId,
      columns: 120,
      rows: 30,
      chars: "input-plain\r",
      yieldTimeMs: 5_000,
    });
    assert.equal(interacted.running, false);
    assert.equal(interacted.exitCode, 23);
    const ptyOutput = `${pty.output}${interacted.output}`;
    assert.match(ptyOutput, /cmd-pty-ready-雪/);
    assert.match(ptyOutput, /stdin=input-plain/);
    assert.match(ptyOutput, /cols=120;rows=30/);
    assert.match(ptyOutput, /cmd-pty-unicode-🙂/);

    const durable = outputStore.read(pty.outputId);
    assert.ok(durable);
    assert.equal(durable.tty, true);
    assert.equal(durable.exitCode, 23);
    assert.equal(durable.status, "failed");
    assert.match(durable.output, /cmd-pty-ready-雪/);
    assert.match(durable.output, /stdin=input-plain/);
    assert.match(durable.output, /cmd-pty-unicode-🙂/);

    const background = await manager.start({
      workspaceId: "cmd-agent",
      cwd: process.cwd(),
      command: `${node} -e "console.log('cmd-pty-background-start'); setTimeout(() => console.log('cmd-pty-background-done'), 250)"`,
      tty: true,
      yieldTimeMs: 5,
    });
    assert.equal(background.running, true);
    assert.ok(background.processId);
    const backgroundDone = await manager.write({
      workspaceId: "cmd-agent",
      processId: background.processId,
      yieldTimeMs: 5_000,
    });
    assert.equal(backgroundDone.running, false);
    assert.equal(backgroundDone.exitCode, 0);
    assert.match(`${background.output}${backgroundDone.output}`, /cmd-pty-background-done/);

    const timedOut = await manager.start({
      workspaceId: "cmd-agent",
      cwd: process.cwd(),
      command: `${node} -e "setTimeout(() => {}, 30000)"`,
      tty: true,
      yieldTimeMs: 5_000,
      timeoutMs: 100,
    });
    assert.equal(timedOut.running, false);
    assert.equal(timedOut.timedOut, true);

    const pidPath = join(root, "cmd-pty-child.pid");
    const childScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    const interruptible = await manager.start({
      workspaceId: "cmd-agent",
      cwd: process.cwd(),
      command: `${node} -e ${quoteCmdArg(childScript)} ${quoteCmdArg(pidPath)}`,
      tty: true,
      yieldTimeMs: 5,
    });
    assert.equal(interruptible.running, true);
    assert.ok(interruptible.processId);
    const childPid = Number.parseInt(await waitForFile(pidPath), 10);
    assert.ok(Number.isInteger(childPid) && childPid > 0, `invalid PTY child pid: ${childPid}`);
    assert.equal(windowsProcessExists(childPid), true);

    const interrupted = await manager.write({
      workspaceId: "cmd-agent",
      processId: interruptible.processId,
      chars: "\u0003",
      yieldTimeMs: 5_000,
    });
    assert.equal(interrupted.running, false);
    await waitForWindowsProcessExit(childPid);
    assert.equal(windowsProcessExists(childPid), false, `PTY child process ${childPid} leaked after interrupt`);
  } finally {
    manager.shutdown();
    outputStore.close();
  }
}

async function exercisePackagedCmdShim(cmd) {
  const artifactDir = join(root, "artifact");
  const prefix = join(root, "prefix");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await Promise.all([
    mkdir(artifactDir, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);

  const packed = runNpm(["pack", "--json", "--pack-destination", artifactDir]);
  const packResult = JSON.parse(packed.stdout);
  const filename = packResult?.[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a package filename: ${packed.stdout}`);
  const tarball = join(artifactDir, filename);
  assert.ok(existsSync(tarball), `packed artifact is missing: ${tarball}`);

  runNpm(["install", "--global", "--prefix", prefix, tarball]);
  const shim = join(prefix, "forgerelay.cmd");
  assert.ok(existsSync(shim), `npm did not create the cmd launcher shim: ${shim}`);

  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 7678,
      allowedRoots: [process.cwd()],
      stateDir,
      worktreeRoot: join(root, "worktrees"),
      commandShell: {
        mode: "follow-launcher",
        family: "cmd",
        executable: cmd,
      },
      shellInstructions: false,
    }, null, 2),
    "utf8",
  );

  const launcherEnv = {
    ...process.env,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_OAUTH_OWNER_TOKEN: "cmd-acceptance-owner-token-that-is-long-enough",
  };
  delete launcherEnv.npm_lifecycle_event;
  delete launcherEnv.FORGERELAY_COMMAND_SHELL;

  const result = spawnSync(
    cmd,
    ["/d", "/s", "/c", `"\"${shim}\" doctor"`],
    {
      cwd: process.cwd(),
      env: launcherEnv,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged cmd launcher failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  assert.match(result.stdout ?? "", /Command shell: cmd \(.+; launcher\)/);
}

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result;
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

function windowsProcessExists(pid) {
  const result = spawnSync(
    "tasklist.exe",
    ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tasklist.exe failed with exit ${result.status ?? "unknown"}`);
  return new RegExp(`"${pid}"(?:,|$)`).test(result.stdout ?? "");
}

async function waitForWindowsProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!windowsProcessExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function quoteCmdArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
