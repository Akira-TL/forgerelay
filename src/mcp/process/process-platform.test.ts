import assert from "node:assert/strict";
import {
  releasePtyProcessResources,
  resolveShellCommand,
  resolveShellCommandForRuntime,
  terminateProcessTree,
  terminatePtyProcessTree,
} from "./process-platform.js";

assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "\"echo ok\""],
  windowsVerbatimArguments: true,
});

assert.deepEqual(
  resolveShellCommand(
    "\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log('foreground')\"",
    "win32",
    { ComSpec: "C:\\Windows\\cmd.exe" },
  ),
  {
    executable: "C:\\Windows\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      "\"\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log('foreground')\"\"",
    ],
    windowsVerbatimArguments: true,
  },
);

assert.deepEqual(
  resolveShellCommandForRuntime(
    "\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log('pty')\" & exit /b 23",
    {
      family: "cmd",
      executable: "C:\\Windows\\System32\\cmd.exe",
      source: "explicit",
      capabilities: ["cmd-command-language"],
    },
    { interactive: true },
  ),
  {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      "\"\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log('pty')\" & exit /b 23\"",
    ],
    ptyCommandLine: "/d /s /c \"\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log('pty')\" & exit /b 23\"",
    windowsVerbatimArguments: true,
  },
);

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/bash",
  args: ["--noprofile", "--norc", "-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/bash",
  args: ["--noprofile", "--norc", "-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", {
  SHELL: "/bin/zsh",
  FORGERELAY_COMMAND_SHELL: "/bin/zsh",
}), {
  executable: "/bin/zsh",
  args: ["-f", "-c", "echo ok"],
});

assert.deepEqual(resolveShellCommandForRuntime("echo ok", {
  family: "sh",
  executable: "/bin/dash",
  source: "recorded",
  capabilities: ["posix-sh", "posix-command-language"],
}), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

const pwshRuntime = {
  family: "pwsh" as const,
  executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  source: "launcher" as const,
  version: "7.6.0",
  capabilities: ["powershell-command-language", "powershell-core"],
};
assert.deepEqual(resolveShellCommandForRuntime("Write-Output ok", pwshRuntime), {
  executable: pwshRuntime.executable,
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"],
});
assert.deepEqual(resolveShellCommandForRuntime("Write-Output ok", pwshRuntime, { interactive: true }), {
  executable: pwshRuntime.executable,
  args: ["-NoLogo", "-NoProfile", "-Command", "Write-Output ok"],
});
const windowsPowerShellRuntime = {
  family: "powershell" as const,
  executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  source: "launcher" as const,
  version: "5.1.26100.7019",
  capabilities: ["powershell-command-language", "windows-powershell", "profile-isolation"],
};
const windowsPowerShellUtf8Command = [
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "Write-Output ok",
].join("; ");
assert.deepEqual(resolveShellCommandForRuntime("Write-Output ok", windowsPowerShellRuntime), {
  executable: windowsPowerShellRuntime.executable,
  args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellUtf8Command],
});
assert.deepEqual(
  resolveShellCommandForRuntime("Write-Output ok", windowsPowerShellRuntime, { interactive: true }),
  {
    executable: windowsPowerShellRuntime.executable,
    args: ["-NoLogo", "-NoProfile", "-Command", windowsPowerShellUtf8Command],
  },
);

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const windowsPtyCalls: string[] = [];
terminatePtyProcessTree(
  { pid: 45, kill: (signal) => windowsPtyCalls.push(`pty:${signal ?? "default"}`) },
  "SIGINT",
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsPtyCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsPtyCalls, ["tree:45", "pty:default"]);

const posixPtyCalls: string[] = [];
terminatePtyProcessTree(
  { pid: 46, kill: (signal) => posixPtyCalls.push(`pty:${signal ?? "default"}`) },
  "SIGINT",
  {
    platform: "darwin",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixPtyCalls, ["pty:SIGINT"]);

const windowsPtyResourceCalls: string[] = [];
const windowsPtyWithLeakedResources = {
  pid: 47,
  kill: () => undefined,
  _agent: {
    inSocket: {
      destroyed: false,
      destroy: () => windowsPtyResourceCalls.push("destroy-input"),
    },
    _conoutSocketWorker: {
      dispose: () => windowsPtyResourceCalls.push("dispose-conout"),
    },
  },
};
releasePtyProcessResources(windowsPtyWithLeakedResources, "win32");
assert.deepEqual(windowsPtyResourceCalls, ["dispose-conout", "destroy-input"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);
