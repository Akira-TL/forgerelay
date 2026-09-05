import { spawnSync } from "node:child_process";
import {
  resolveCompatibilityCommandShellRuntime,
  type CommandShellRuntime,
} from "../../runtime/shell/command-shell-runtime.js";

export interface ShellCommand {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KillablePtyProcess {
  pid: number;
  kill(signal?: string): void;
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

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  return resolveShellCommandForRuntime(
    command,
    resolveCompatibilityCommandShellRuntime(platform, environment),
  );
}

export function resolveShellCommandForRuntime(
  command: string,
  runtime: CommandShellRuntime,
  options: { interactive?: boolean } = {},
): ShellCommand {
  // Agent and Hook commands must not source the user's interactive/login shell
  // configuration. ForgeRelay already inherits PATH and other environment from
  // the process that launched the server; re-running zsh/bash as a login shell
  // can inject prompts, banners, aliases, plugins, or other user-only behavior.
  switch (runtime.family) {
    case "cmd":
      return {
        executable: runtime.executable,
        // Match Node's native `spawn(command, { shell: cmd.exe })` quoting.
        // cmd.exe /S applies special quote stripping, so the whole command must
        // be wrapped even when the executable inside it is already quoted.
        args: ["/d", "/s", "/c", `"${command}"`],
        windowsVerbatimArguments: true,
      };
    case "bash":
      return { executable: runtime.executable, args: ["--noprofile", "--norc", "-c", command] };
    case "zsh":
      return { executable: runtime.executable, args: ["-f", "-c", command] };
    case "sh":
      return { executable: runtime.executable, args: ["-c", command] };
    case "pwsh":
      return {
        executable: runtime.executable,
        args: [
          "-NoLogo",
          "-NoProfile",
          ...(options.interactive ? [] : ["-NonInteractive"]),
          "-Command",
          command,
        ],
      };
    case "fish":
    case "powershell":
      throw new Error(
        `Command shell runtime ${runtime.family} is identified but native execution support is not enabled in this release stage. ForgeRelay will not silently execute the command through another shell.`,
      );
  }
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

export function terminatePtyProcessTree(
  pty: KillablePtyProcess,
  signal: NodeJS.Signals,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32") {
    runtime.killWindowsTree(pty.pid);
    try {
      pty.kill();
    } catch {
      // The PTY may already have completed after tree termination.
    }
    return;
  }

  pty.kill(signal);
}
