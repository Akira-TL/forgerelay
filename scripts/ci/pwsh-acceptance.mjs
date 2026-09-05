#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("PowerShell 7 packaged acceptance skipped outside Windows.");
  process.exit(0);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("pwsh acceptance must run through npm so npm_execpath is available");

const root = await mkdtemp(join(tmpdir(), "forgerelay-pwsh-acceptance-"));
try {
  const pwsh = resolvePowerShell7();
  const version = powerShellVersion(pwsh);
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  assert.ok(Number.isInteger(major) && major >= 7, `PowerShell 7 acceptance requires pwsh >= 7; got ${version}`);

  const runtime = {
    family: "pwsh",
    executable: pwsh,
    source: "explicit",
    version,
    capabilities: [
      "powershell-command-language",
      "powershell-core",
      "profile-isolation",
      "pipeline-chain-operators",
    ],
  };

  console.error(`[pwsh-acceptance:baseline-resources] ${JSON.stringify({
    resources: process.getActiveResourcesInfo?.() ?? [],
  })}`);
  await exerciseAgentRuntime(runtime);
  await exerciseHookRuntime(runtime);
  await exercisePackagedPowerShellShim(pwsh, version);

  console.error(`[pwsh-acceptance:exit-diagnostic] ${JSON.stringify({
    resources: process.getActiveResourcesInfo?.() ?? [],
  })}`);
  console.log(`PowerShell 7 acceptance passed with ${pwsh} (${version}).`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function resolvePowerShell7() {
  const result = spawnSync("where.exe", ["pwsh.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Windows release acceptance requires PowerShell 7 (pwsh.exe) on PATH.");
  }
  const executable = result.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!executable) throw new Error("where.exe reported no pwsh.exe path.");
  return executable;
}

function powerShellVersion(executable) {
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to query ${executable} version: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  const version = result.stdout?.trim();
  if (!version) throw new Error(`${executable} did not report a version.`);
  return version;
}

async function exerciseAgentRuntime(runtime) {
  const [{ ProcessManager }, { BashOutputStore }] = await Promise.all([
    import("../../dist/mcp/process/process-sessions.js"),
    import("../../dist/activity/history/bash-output-store.js"),
  ]);
  const durableStateDir = join(root, "durable-output-state");
  const outputStore = new BashOutputStore(durableStateDir, {
    outputId: () => "out_pwsh_pty_acceptance",
    flushBytes: 1,
  });
  const manager = new ProcessManager({
    commandShellRuntime: runtime,
    outputAudit: outputStore,
  });
  const originalMarker = process.env.FORGERELAY_PWSH_ACCEPTANCE;
  process.env.FORGERELAY_PWSH_ACCEPTANCE = "inherited environment";
  try {
    const node = powerShellLiteral(process.execPath);
    const semantics = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: [
        'Write-Output "env=$env:FORGERELAY_PWSH_ACCEPTANCE"',
        '1,2,3 | Measure-Object -Sum | ForEach-Object { Write-Output "sum=$($_.Sum)" }',
        `$exe = ${node}`,
        "& $exe -e 'console.log(JSON.stringify(process.argv.slice(1)))' 'native arg with spaces' 'quote\"inside' 'unicode-雪'",
        "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
        "$redirect = Join-Path $env:TEMP 'forgerelay-pwsh-redirection.txt'",
        "'redirected-through-pwsh' > $redirect",
        "Get-Content $redirect",
        "Remove-Item $redirect -Force",
      ].join("; "),
      yieldTimeMs: 10_000,
    });
    assert.equal(semantics.running, false);
    assert.equal(semantics.exitCode, 0);
    assert.match(semantics.output, /env=inherited environment/);
    assert.match(semantics.output, /sum=6/);
    assert.match(semantics.output, /\["native arg with spaces","quote\\\"inside","unicode-雪"\]/);
    assert.match(semantics.output, /redirected-through-pwsh/);

    const errorSemantics = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: [
        "Write-Error 'nonterminating-pwsh-error'",
        "Write-Output 'continued-after-nonterminating-error'",
        "try { Get-Item 'forgerelay-definitely-missing-item' -ErrorAction Stop; exit 31 } catch { Write-Output 'terminating-error-caught' }",
      ].join("; "),
      yieldTimeMs: 10_000,
    });
    assert.equal(errorSemantics.exitCode, 0);
    assert.match(errorSemantics.output, /nonterminating-pwsh-error/);
    assert.match(errorSemantics.output, /continued-after-nonterminating-error/);
    assert.match(errorSemantics.output, /terminating-error-caught/);

    const nativeExit = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: `$exe = ${node}; & $exe -e 'process.exit(7)'; exit $LASTEXITCODE`,
      yieldTimeMs: 10_000,
    });
    assert.equal(nativeExit.exitCode, 7);

    const background = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: "Write-Output 'pwsh-background-start'; Start-Sleep -Milliseconds 250; Write-Output 'pwsh-background-done'",
      yieldTimeMs: 5,
    });
    assert.equal(background.running, true);
    assert.ok(background.processId);
    const completed = await manager.write({
      workspaceId: "pwsh-agent",
      processId: background.processId,
      yieldTimeMs: 5_000,
    });
    assert.equal(completed.running, false);
    assert.equal(completed.exitCode, 0);
    assert.match(completed.output, /pwsh-background-done/);

    const timedOut = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: "Start-Sleep -Seconds 30",
      yieldTimeMs: 5_000,
      timeoutMs: 100,
    });
    assert.equal(timedOut.running, false);
    assert.equal(timedOut.timedOut, true);

    const interruptible = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: "Write-Output 'pwsh-interrupt-ready'; Start-Sleep -Seconds 30",
      yieldTimeMs: 5,
    });
    assert.equal(interruptible.running, true);
    assert.ok(interruptible.processId);
    const interrupted = await manager.write({
      workspaceId: "pwsh-agent",
      processId: interruptible.processId,
      chars: "\u0003",
      yieldTimeMs: 5_000,
    });
    assert.equal(interrupted.running, false);

    await exercisePtyLifecycle(manager, outputStore, node);
  } finally {
    if (originalMarker === undefined) delete process.env.FORGERELAY_PWSH_ACCEPTANCE;
    else process.env.FORGERELAY_PWSH_ACCEPTANCE = originalMarker;
    manager.shutdown();
    outputStore.close();
  }
}

async function exercisePtyLifecycle(manager, outputStore, node) {
  const pty = await manager.start({
    workspaceId: "pwsh-agent",
    workspaceRoot: process.cwd(),
    audit: {
      activityId: "act-pwsh-pty",
      turnId: "turn-pwsh-pty",
      conversationScopeId: "conversation-pwsh-pty",
    },
    cwd: process.cwd(),
    command: [
      "Write-Output 'pwsh-pty-ready-雪'",
      "$line = [Console]::In.ReadLine()",
      "Start-Sleep -Milliseconds 100",
      'Write-Output "stdin=$line"',
      'Write-Output "cols=$([Console]::WindowWidth);rows=$([Console]::WindowHeight)"',
      "Write-Output 'pwsh-pty-unicode-🙂'",
      "exit 23",
    ].join("; "),
    tty: true,
    columns: 80,
    rows: 24,
    yieldTimeMs: 5,
  });
  assert.equal(pty.running, true);
  assert.ok(pty.processId);
  assert.equal(pty.outputId, "out_pwsh_pty_acceptance");

  const interacted = await manager.write({
    workspaceId: "pwsh-agent",
    processId: pty.processId,
    columns: 120,
    rows: 30,
    chars: "input-plain\r",
    yieldTimeMs: 5_000,
  });
  assert.equal(interacted.running, false);
  assert.equal(interacted.exitCode, 23);
  const ptyOutput = `${pty.output}${interacted.output}`;
  assert.match(ptyOutput, /pwsh-pty-ready-雪/);
  assert.match(ptyOutput, /stdin=input-plain/);
  assert.match(ptyOutput, /cols=120;rows=30/);
  assert.match(ptyOutput, /pwsh-pty-unicode-🙂/);

  const durable = outputStore.read(pty.outputId);
  assert.ok(durable);
  assert.equal(durable.tty, true);
  assert.equal(durable.exitCode, 23);
  assert.equal(durable.status, "failed");
  assert.match(durable.output, /pwsh-pty-ready-雪/);
  assert.match(durable.output, /stdin=input-plain/);
  assert.match(durable.output, /pwsh-pty-unicode-🙂/);

  const background = await manager.start({
    workspaceId: "pwsh-agent",
    cwd: process.cwd(),
    command: "Write-Output 'pwsh-pty-background-start'; Start-Sleep -Milliseconds 250; Write-Output 'pwsh-pty-background-done'",
    tty: true,
    yieldTimeMs: 5,
  });
  assert.equal(background.running, true);
  assert.ok(background.processId);
  const backgroundDone = await manager.write({
    workspaceId: "pwsh-agent",
    processId: background.processId,
    yieldTimeMs: 5_000,
  });
  assert.equal(backgroundDone.running, false);
  assert.equal(backgroundDone.exitCode, 0);
  assert.match(`${background.output}${backgroundDone.output}`, /pwsh-pty-background-done/);

  const timedOut = await manager.start({
    workspaceId: "pwsh-agent",
    cwd: process.cwd(),
    command: "Start-Sleep -Seconds 30",
    tty: true,
    yieldTimeMs: 5_000,
    timeoutMs: 100,
  });
  assert.equal(timedOut.running, false);
  assert.equal(timedOut.timedOut, true);

  const pidPath = join(root, "pwsh-pty-child.pid");
  const childScript = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
  const interruptible = await manager.start({
    workspaceId: "pwsh-agent",
    cwd: process.cwd(),
    command: [
      "Write-Output 'pwsh-pty-interrupt-ready'",
      `$exe = ${node}`,
      `& $exe -e ${powerShellLiteral(childScript)} ${powerShellLiteral(pidPath)}`,
    ].join("; "),
    tty: true,
    yieldTimeMs: 5,
  });
  assert.equal(interruptible.running, true);
  assert.ok(interruptible.processId);
  const childPid = Number.parseInt(await waitForFile(pidPath), 10);
  assert.ok(Number.isInteger(childPid) && childPid > 0, `invalid PTY child pid: ${childPid}`);
  assert.equal(windowsProcessExists(childPid), true);

  const interrupted = await manager.write({
    workspaceId: "pwsh-agent",
    processId: interruptible.processId,
    chars: "\u0003",
    yieldTimeMs: 5_000,
  });
  assert.equal(interrupted.running, false);
  await waitForWindowsProcessExit(childPid);
  assert.equal(windowsProcessExists(childPid), false, `PTY child process ${childPid} leaked after interrupt`);
}

async function exerciseHookRuntime(runtime) {
  const { HookRunner, parseHookConfig } = await import("../../dist/mcp/hooks/hooks.js");
  const logging = {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  };
  const runner = new HookRunner(
    parseHookConfig({
      BeforeTool: [{
        handlers: [{
          name: "PowerShell policy",
          command: "if ($env:FORGERELAY_WORKSPACE_ID -ne 'pwsh-hook') { exit 19 }; Write-Error 'pwsh policy denied'; exit 13",
        }],
      }],
    }),
    logging,
    process.env,
    undefined,
    runtime,
  );

  await assert.rejects(
    () => runner.run("BeforeTool", {
      workspaceId: "pwsh-hook",
      workspaceRoot: process.cwd(),
      workspaceMode: "checkout",
      payload: { tool: "bash", command: "Write-Output 'agent command'" },
    }),
    /PowerShell policy exited with code 13: .*pwsh policy denied/i,
  );
}

async function exercisePackagedPowerShellShim(pwsh, expectedVersion) {
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
  const shim = join(prefix, "forgerelay.ps1");
  assert.ok(existsSync(shim), `npm did not create the PowerShell launcher shim: ${shim}`);

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
        family: "pwsh",
        executable: pwsh,
      },
      shellInstructions: false,
    }, null, 2),
    "utf8",
  );

  const launcherEnv = {
    ...process.env,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_OAUTH_OWNER_TOKEN: "pwsh-acceptance-owner-token-that-is-long-enough",
  };
  delete launcherEnv.npm_lifecycle_event;
  delete launcherEnv.FORGERELAY_COMMAND_SHELL;

  const result = spawnSync(
    pwsh,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", shim, "doctor"],
    {
      cwd: process.cwd(),
      env: launcherEnv,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged PowerShell launcher failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  assert.match(result.stdout ?? "", new RegExp(`Command shell: pwsh ${escapeRegExp(expectedVersion)} \\(.+; launcher\\)`));
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

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
