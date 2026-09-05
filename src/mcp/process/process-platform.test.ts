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
assert.throws(
  () => resolveShellCommandForRuntime("Write-Output ok", {
    family: "powershell",
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    source: "launcher",
    capabilities: ["powershell-command-language", "windows-powershell"],
  }),
  /will not silently execute the command through another shell/,
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
const windowsPtyWithLeakedInput = {
  pid: 47,
  kill: () => undefined,
  _agent: {
    inSocket: {
      destroyed: false,
      destroy: () => windowsPtyResourceCalls.push("destroy-input"),
    },
  },
};
releasePtyProcessResources(windowsPtyWithLeakedInput, "win32");
assert.deepEqual(windowsPtyResourceCalls, ["destroy-input"]);

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
