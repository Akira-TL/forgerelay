import assert from "node:assert/strict";
import test from "node:test";
import {
  commandShellAgentInstruction,
  detectLauncherCommandShell,
  formatCommandShellRuntime,
  inferCommandShellFamily,
  resolveCommandShellRuntime,
  resolveCompatibilityCommandShellRuntime,
} from "./command-shell-runtime.js";

test("command shell precedence is explicit > launcher > recorded fallback", () => {
  const recorded = { family: "bash" as const, executable: "/bin/bash" };
  const launcher = { family: "zsh" as const, executable: "/bin/zsh" };
  const explicit = { family: "fish" as const, executable: "/opt/homebrew/bin/fish" };

  assert.equal(resolveCommandShellRuntime({ explicit, launcher, recordedFallback: recorded }).family, "fish");
  assert.equal(resolveCommandShellRuntime({ launcher, recordedFallback: recorded }).family, "zsh");
  assert.equal(resolveCommandShellRuntime({ recordedFallback: recorded }).family, "bash");
  assert.equal(resolveCommandShellRuntime({ explicit, launcher, recordedFallback: recorded }).source, "explicit");
  assert.equal(resolveCommandShellRuntime({ launcher, recordedFallback: recorded }).source, "launcher");
  assert.equal(resolveCommandShellRuntime({ recordedFallback: recorded }).source, "recorded");
});

test("missing command shell selection fails instead of guessing a command language", () => {
  assert.throws(
    () => resolveCommandShellRuntime({}),
    /Unable to determine ForgeRelay command shell/,
  );
  assert.throws(
    () => resolveCommandShellRuntime({ explicit: { executable: "/opt/custom/agent-shell" } }),
    /Configure the shell family explicitly/,
  );
});

test("shell family inference recognizes Windows and POSIX executable names", () => {
  assert.equal(inferCommandShellFamily("/bin/bash"), "bash");
  assert.equal(inferCommandShellFamily("/opt/homebrew/bin/zsh"), "zsh");
  assert.equal(inferCommandShellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
  assert.equal(inferCommandShellFamily("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), "powershell");
  assert.equal(inferCommandShellFamily("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(inferCommandShellFamily("/usr/bin/dash"), "sh");
});

test("runtime keeps version, capabilities, executable, and source stable", () => {
  const runtime = resolveCommandShellRuntime({
    explicit: {
      family: "pwsh",
      executable: "D:\\Portable PowerShell\\pwsh.exe",
      version: "7.6.0",
      capabilities: ["powershell-command-language", "pipeline-chain-operators"],
    },
  });

  assert.deepEqual(runtime, {
    family: "pwsh",
    executable: "D:\\Portable PowerShell\\pwsh.exe",
    source: "explicit",
    version: "7.6.0",
    capabilities: ["powershell-command-language", "pipeline-chain-operators"],
  });
  assert.match(formatCommandShellRuntime(runtime), /pwsh 7\.6\.0/);
  assert.match(commandShellAgentInstruction(runtime), /Write shell commands for this runtime rather than assuming Bash syntax/);
});

test("Bash stays compact while non-Bash runtimes produce mandatory identity guidance", () => {
  const bash = resolveCommandShellRuntime({ recordedFallback: { family: "bash", executable: "/bin/bash" } });
  const cmd = resolveCommandShellRuntime({
    recordedFallback: { family: "cmd", executable: "C:\\Windows\\System32\\cmd.exe" },
  });

  assert.equal(commandShellAgentInstruction(bash), "");
  assert.match(commandShellAgentInstruction(cmd), /Command shell runtime: cmd/);
  assert.match(commandShellAgentInstruction(cmd), /Selection source: recorded/);
});

test("launcher detection ignores npm lifecycle wrapper shells", () => {
  const ignored = detectLauncherCommandShell({
    platform: "win32",
    ppid: 42,
    environment: { npm_lifecycle_event: "start" },
    parentExecutable: () => "cmd.exe",
  });
  assert.equal(ignored, undefined);
});

test("launcher detection classifies the observable parent shell and resolves PATH when possible", () => {
  const detected = detectLauncherCommandShell({
    platform: "linux",
    ppid: 42,
    environment: { PATH: "/bin:/usr/bin" },
    parentExecutable: () => "/bin/zsh",
  });
  assert.deepEqual(detected, { family: "zsh", executable: "/bin/zsh" });
});

test("compatibility runtime preserves the current Bash and cmd defaults", () => {
  assert.deepEqual(resolveCompatibilityCommandShellRuntime("linux", {}), {
    family: "bash",
    executable: "/bin/bash",
    source: "compatibility-default",
    capabilities: ["bash", "profile-isolation", "posix-command-language"],
  });
  assert.deepEqual(resolveCompatibilityCommandShellRuntime("win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
    family: "cmd",
    executable: "C:\\Windows\\cmd.exe",
    source: "compatibility-default",
    capabilities: ["cmd-command-language"],
  });
  assert.equal(
    resolveCompatibilityCommandShellRuntime("linux", { FORGERELAY_COMMAND_SHELL: "/bin/zsh" }).source,
    "explicit",
  );
});
