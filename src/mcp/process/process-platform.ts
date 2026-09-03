import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const POSIX_SHELLS = new Set(["ash", "dash", "ksh", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
      windowsVerbatimArguments: true,
    };
  }

  // Agent and Hook commands must not source the user's interactive/login shell
  // configuration. ForgeRelay already inherits PATH and other environment from
  // the process that launched the server; re-running zsh/bash as a login shell
  // can inject prompts, banners, aliases, plugins, or other user-only behavior.
  const configuredShell = environment.FORGERELAY_COMMAND_SHELL?.trim();
  const executable = configuredShell || (platform === "linux" || platform === "darwin"
    ? "/bin/bash"
    : "/bin/sh");
  const shellName = basename(executable);
  if (shellName === "bash") {
    return { executable, args: ["--noprofile", "--norc", "-c", command] };
  }
  if (shellName === "zsh") {
    return { executable, args: ["-f", "-c", command] };
  }
  if (POSIX_SHELLS.has(shellName)) {
    return { executable, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}
