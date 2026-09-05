#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  await exerciseAgentRuntime(runtime);
  await exerciseHookRuntime(runtime);
  await exercisePackagedPowerShellShim(pwsh, version);

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
  const { ProcessManager } = await import("../../dist/mcp/process/process-sessions.js");
  const manager = new ProcessManager({ commandShellRuntime: runtime });
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

    const pty = await manager.start({
      workspaceId: "pwsh-agent",
      cwd: process.cwd(),
      command: "Write-Output 'pwsh-pty-ok'",
      tty: true,
      yieldTimeMs: 10_000,
    });
    assert.equal(pty.running, false);
    assert.equal(pty.exitCode, 0);
    assert.match(pty.output, /pwsh-pty-ok/);
  } finally {
    if (originalMarker === undefined) delete process.env.FORGERELAY_PWSH_ACCEPTANCE;
    else process.env.FORGERELAY_PWSH_ACCEPTANCE = originalMarker;
    manager.shutdown();
  }
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

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
