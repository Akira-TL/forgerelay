#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("Windows packaged product acceptance skipped outside Windows.");
  process.exit(0);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Windows product acceptance must run through npm so npm_execpath is available");

const root = await import("node:fs/promises").then(({ mkdtemp }) =>
  mkdtemp(join(tmpdir(), "forgerelay-windows-product-acceptance-"))
);

try {
  const artifactDir = join(root, "artifact");
  const prefix = join(root, "prefix");
  const projectRoot = join(root, "project");
  await Promise.all([
    mkdir(artifactDir, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  await writeFile(join(projectRoot, "README.md"), "Windows product acceptance workspace\n", "utf8");

  const packed = runNpm(["pack", "--json", "--pack-destination", artifactDir]);
  const packResult = JSON.parse(packed.stdout);
  const filename = packResult?.[0]?.filename;
  if (!filename) throw new Error(`npm pack did not report a package filename: ${packed.stdout}`);
  const tarball = join(artifactDir, filename);
  assert.ok(existsSync(tarball), `packed artifact is missing: ${tarball}`);

  runNpm(["install", "--global", "--prefix", prefix, tarball]);
  const shim = join(prefix, "forgerelay.cmd");
  assert.ok(existsSync(shim), `npm did not create the Windows launcher shim: ${shim}`);

  const installedRoot = join(prefix, "node_modules", "@akira-tl", "forgerelay");
  assert.ok(existsSync(join(installedRoot, "dist", "cli.js")), `installed package is missing dist/cli.js: ${installedRoot}`);
  const workspaceProbe = join(root, "packaged-workspace-probe.mjs");
  await writeFile(workspaceProbe, packagedWorkspaceProbe(), "utf8");

  const pwsh = resolveWhere("pwsh.exe", "PowerShell 7");
  const powershell = resolveWhere("powershell.exe", "Windows PowerShell 5.1");
  const cmd = process.env.ComSpec ?? process.env.COMSPEC;
  assert.ok(cmd && existsSync(cmd), `Windows product acceptance requires a valid ComSpec; got ${cmd ?? "unset"}.`);

  const runtimes = [
    { family: "pwsh", executable: pwsh, doctorIdentity: /Command shell: pwsh / },
    { family: "powershell", executable: powershell, doctorIdentity: /Command shell: powershell 5\.1\./ },
    { family: "cmd", executable: cmd, doctorIdentity: /Command shell: cmd / },
  ];

  for (const runtime of runtimes) {
    await exercisePackagedRuntime({
      ...runtime,
      root,
      projectRoot,
      shim,
      installedRoot,
      workspaceProbe,
    });
  }

  await exercisePackagedElevationContract(installedRoot, { root, projectRoot, shim, cmd });
  console.log("Windows packaged product acceptance passed for pwsh, Windows PowerShell 5.1, cmd.exe, editable Instructions, and elevated startup protection.");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function exercisePackagedRuntime({ family, executable, doctorIdentity, root, projectRoot, shim, installedRoot, workspaceProbe }) {
  const configDir = join(root, `config-${family}`);
  const stateDir = join(root, `state-${family}`);
  const instructionsDir = join(configDir, "instructions");
  const instructionPath = join(instructionsDir, `${family}.md`);
  const instructionMarker = `WINDOWS-PACKAGED-${family.toUpperCase()}-EDITABLE-INSTRUCTION`;
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(instructionsDir, { recursive: true }),
  ]);
  await writeFile(
    instructionPath,
    `# User-edited ${family} Instructions\n\n${instructionMarker}\n`,
    "utf8",
  );
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port: 7678,
      allowedRoots: [projectRoot],
      stateDir,
      worktreeRoot: join(root, `worktrees-${family}`),
      commandShell: {
        mode: "pinned",
        family,
        executable,
      },
      shellInstructions: true,
      skillsEnabled: false,
    }, null, 2),
    "utf8",
  );

  const env = cleanAcceptanceEnv(configDir);
  const doctor = runPackagedShim(shim, ["doctor"], env);
  assert.match(doctor.stdout, doctorIdentity);
  assert.match(doctor.stdout, /Command shell source: explicit/);
  assert.match(doctor.stdout, /Command shell compatibility: /);
  assert.match(doctor.stdout, /Shell Instructions: enabled \(.+; available\)/);
  assert.doesNotMatch(doctor.stdout, /Bash shell:/);

  const probeResultPath = join(root, `workspace-probe-${family}.json`);
  const probe = spawnSync(
    process.execPath,
    [
      workspaceProbe,
      installedRoot,
      projectRoot,
      stateDir,
      instructionPath,
      instructionMarker,
      `windows-product-${family}`,
      probeResultPath,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error(`Packaged Workspace probe failed for ${family}: ${probe.error?.message ?? probe.stderr ?? probe.status}`);
  }
  const opened = JSON.parse(await readFile(probeResultPath, "utf8"));
  assert.equal(opened.workspaceRoot, projectRoot);
  assert.equal(opened.instructionPath, instructionPath);
  assert.match(opened.instructionContent ?? "", new RegExp(instructionMarker));
  assert.equal(opened.instructionStatus, "loaded", `${family} shell Instructions were not advertised as loaded`);
}

async function exercisePackagedElevationContract(installedRoot, { root, projectRoot, shim, cmd }) {
  const { assertRuntimePrivilegeAllowed, detectRuntimePrivilege, elevatedRuntimeWarning } = await importInstalled(
    installedRoot,
    "dist/runtime/security/runtime-privilege.js",
  );
  const actualPrivilege = detectRuntimePrivilege();
  if (actualPrivilege.level !== "standard") {
    const configDir = join(root, "config-elevated-refusal");
    const stateDir = join(root, "state-elevated-refusal");
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
    ]);
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: 7678,
        allowedRoots: [projectRoot],
        stateDir,
        worktreeRoot: join(root, "worktrees-elevated-refusal"),
        commandShell: { mode: "pinned", family: "cmd", executable: cmd },
        shellInstructions: false,
      }, null, 2),
      "utf8",
    );
    const refused = runPackagedShimResult(shim, ["serve"], cleanAcceptanceEnv(configDir));
    assert.equal(refused.status, 1, `elevated packaged serve should fail closed, got ${refused.status}`);
    assert.match(
      `${refused.stdout ?? ""}\n${refused.stderr ?? ""}`,
      /refuses to start its Agent\/Hook runtime with system-level or unknown privilege by default/,
    );
  }

  const elevated = {
    level: "elevated",
    platform: "win32",
    source: "windows-token",
    detail: "packaged acceptance synthetic high-integrity token",
  };
  assert.throws(
    () => assertRuntimePrivilegeAllowed(elevated, false),
    /refuses to start its Agent\/Hook runtime with system-level or unknown privilege by default/,
  );
  assert.doesNotThrow(() => assertRuntimePrivilegeAllowed(elevated, true));
  assert.match(elevatedRuntimeWarning(elevated), /system-wide or irreversible changes/);

  const unknown = {
    level: "unknown",
    platform: "win32",
    source: "windows-token",
    detail: "packaged acceptance token inspection unavailable",
  };
  assert.throws(
    () => assertRuntimePrivilegeAllowed(unknown, false),
    /could not safely determine whether this process is elevated/,
  );
  assert.doesNotThrow(() => assertRuntimePrivilegeAllowed(unknown, true));
}

function packagedWorkspaceProbe() {
  return String.raw`
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installedRoot, projectRoot, stateDir, instructionPath, instructionMarker, conversationScopeId, resultPath] = process.argv.slice(2);
const importInstalled = (relativePath) => import(pathToFileURL(join(installedRoot, relativePath)).href);
const [{ loadConfig }, { SqliteWorkspaceStore }, { WorkspaceRegistry }] = await Promise.all([
  importInstalled("dist/runtime/config/config.js"),
  importInstalled("dist/workspaces/state/workspace-store.js"),
  importInstalled("dist/workspaces.js"),
]);
const config = loadConfig(process.env);
const store = new SqliteWorkspaceStore(stateDir);
try {
  const registry = new WorkspaceRegistry(config, store);
  const opened = await registry.openWorkspace(
    { path: projectRoot, context: "full" },
    { conversationScopeId },
  );
  const loadedShellInstruction = opened.agentsFiles.find((file) => file.path === instructionPath);
  const instructionState = opened.workspace.workspaceInstructions.find((entry) => entry.path === instructionPath);
  if (!loadedShellInstruction || !loadedShellInstruction.content.includes(instructionMarker)) {
    throw new Error("Packaged shell Instructions were not loaded from the editable instruction file.");
  }
  await writeFile(resultPath, JSON.stringify({
    workspaceRoot: opened.workspace.root,
    instructionPath: loadedShellInstruction.path,
    instructionContent: loadedShellInstruction.content,
    instructionStatus: instructionState?.status ?? null,
  }), "utf8");
} finally {
  store.close();
}
`;
}

function cleanAcceptanceEnv(configDir) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("FORGERELAY_")),
  );
  delete env.npm_lifecycle_event;
  return {
    ...env,
    FORGERELAY_CONFIG_DIR: configDir,
    FORGERELAY_OAUTH_OWNER_TOKEN: "windows-product-acceptance-owner-token-long-enough",
    FORGERELAY_SKILLS: "0",
    FORGERELAY_WIDGETS: "off",
  };
}

function runPackagedShim(shim, args, env) {
  const result = runPackagedShimResult(shim, args, env);
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged launcher failed (${args.join(" ")}): ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result;
}

function runPackagedShimResult(shim, args, env) {
  const cmd = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const command = [`\"${shim}\"`, ...args.map(quoteCmdArg)].join(" ");
  return spawnSync(
    cmd,
    ["/d", "/s", "/c", `"${command}"`],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 10_000,
    },
  );
}

function resolveWhere(executable, label) {
  const result = spawnSync("where.exe", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Windows product acceptance requires ${label} (${executable}) on PATH.`);
  }
  const resolved = result.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!resolved) throw new Error(`where.exe reported no ${executable} path.`);
  return resolved;
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

function importInstalled(installedRoot, relativePath) {
  return import(pathToFileURL(join(installedRoot, relativePath)).href);
}

function quoteCmdArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
