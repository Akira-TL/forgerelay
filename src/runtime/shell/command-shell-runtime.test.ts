import assert from "node:assert/strict";
import test from "node:test";
import {
  commandShellAgentInstruction,
  detectLauncherCommandShell,
  formatCommandShellRuntime,
  inferCommandShellFamily,
  resolveCommandShellRuntime,
  resolveCompatibilityCommandShellRuntime,
  resolveConfiguredCommandShellRuntime,
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

test("configured pinned shell outranks launcher detection and keeps the recorded executable", () => {
  const runtime = resolveConfiguredCommandShellRuntime({
    mode: "pinned",
    family: "bash",
    executable: "/bin/bash",
  }, "linux", { PATH: "/bin:/usr/bin" });
  assert.equal(runtime.family, "bash");
  assert.equal(runtime.executable, "/bin/bash");
  assert.equal(runtime.source, "explicit");
});

test("follow-launcher falls back to the recorded shell when npm hides its wrapper launcher", () => {
  const runtime = resolveConfiguredCommandShellRuntime({
    mode: "follow-launcher",
    family: "bash",
    executable: "/bin/bash",
  }, "linux", {
    PATH: "/bin:/usr/bin",
    npm_lifecycle_event: "start",
  });
  assert.equal(runtime.family, "bash");
  assert.equal(runtime.source, "recorded");
});

test("configured pwsh records the probed PowerShell 7 version and runtime capabilities", () => {
  const runtime = resolveConfiguredCommandShellRuntime({
    mode: "pinned",
    family: "pwsh",
    executable: process.execPath,
  }, "linux", { PATH: process.env.PATH }, {
    probePowerShell7Version: (executable) => {
      assert.equal(executable, process.execPath);
      return "7.6.1";
    },
  });

  assert.equal(runtime.family, "pwsh");
  assert.equal(runtime.version, "7.6.1");
  assert.equal(runtime.source, "explicit");
  assert.ok(runtime.capabilities.includes("powershell-core"));
  assert.ok(runtime.capabilities.includes("profile-isolation"));
  assert.ok(runtime.capabilities.includes("pipeline-chain-operators"));
  assert.match(commandShellAgentInstruction(runtime), /Command shell runtime: pwsh 7\.6\.1/);
});

test("configured pwsh rejects runtimes older than PowerShell 7", () => {
  assert.throws(
    () => resolveConfiguredCommandShellRuntime({
      mode: "pinned",
      family: "pwsh",
      executable: process.execPath,
    }, "linux", { PATH: process.env.PATH }, {
      probePowerShell7Version: () => "6.2.7",
    }),
    /must be PowerShell 7 or newer/,
  );
});

test("unavailable pinned shell fails instead of changing command language", () => {
  assert.throws(
    () => resolveConfiguredCommandShellRuntime({
      mode: "pinned",
      family: "zsh",
      executable: "/definitely/missing/forgerelay-zsh",
    }, "linux", { PATH: "/bin:/usr/bin" }),
    /Configured command-shell executable is unavailable/,
  );
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
