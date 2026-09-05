import { existsSync, readlinkSync } from "node:fs";
import { isAbsolute, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";

export type CommandShellFamily =
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "pwsh"
  | "powershell"
  | "cmd";

export type CommandShellSelectionSource =
  | "explicit"
  | "launcher"
  | "recorded"
  | "compatibility-default";

export interface CommandShellSelection {
  executable: string;
  family?: CommandShellFamily;
  version?: string;
  capabilities?: string[];
}

export interface CommandShellRuntime {
  family: CommandShellFamily;
  executable: string;
  source: CommandShellSelectionSource;
  version?: string;
  capabilities: string[];
}

export interface CommandShellResolutionInput {
  explicit?: CommandShellSelection;
  launcher?: CommandShellSelection;
  recordedFallback?: CommandShellSelection;
}

interface LauncherDetectionDependencies {
  platform?: NodeJS.Platform;
  ppid?: number;
  environment?: NodeJS.ProcessEnv;
  parentExecutable?: (platform: NodeJS.Platform, ppid: number) => string | undefined;
}

const POSIX_SH_NAMES = new Set(["ash", "dash", "ksh", "sh"]);

export function resolveCommandShellRuntime(
  input: CommandShellResolutionInput,
): CommandShellRuntime {
  const selected = input.explicit
    ? { source: "explicit" as const, value: input.explicit }
    : input.launcher
      ? { source: "launcher" as const, value: input.launcher }
      : input.recordedFallback
        ? { source: "recorded" as const, value: input.recordedFallback }
        : undefined;

  if (!selected) {
    throw new Error(
      "Unable to determine ForgeRelay command shell. Configure a shell explicitly or run `forgerelay init` to record a fallback for non-interactive launches.",
    );
  }

  return runtimeFromSelection(selected.value, selected.source);
}

/**
 * Preserve the pre-P3 execution contract while the owner-facing init/config
 * surface is introduced incrementally. This is deliberately separate from the
 * strict precedence resolver above: new configuration should call
 * resolveCommandShellRuntime instead of inventing another fallback.
 */
export function resolveCompatibilityCommandShellRuntime(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandShellRuntime {
  if (platform === "win32") {
    return runtimeFromSelection(
      {
        family: "cmd",
        executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      },
      "compatibility-default",
    );
  }

  const configured = environment.FORGERELAY_COMMAND_SHELL?.trim();
  if (configured) {
    return runtimeFromSelection({ executable: configured }, "explicit");
  }

  if (platform === "linux" || platform === "darwin") {
    return runtimeFromSelection(
      { family: "bash", executable: "/bin/bash" },
      "compatibility-default",
    );
  }

  return runtimeFromSelection(
    { family: "sh", executable: "/bin/sh" },
    "compatibility-default",
  );
}

export function detectLauncherCommandShell(
  dependencies: LauncherDetectionDependencies = {},
): CommandShellSelection | undefined {
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;

  // npm lifecycle scripts insert their own /bin/sh or cmd.exe. Treating that
  // wrapper as the user's launcher would recreate the npm-script-shell bug P3
  // is specifically intended to avoid. The recorded fallback is safer here.
  if (environment.npm_lifecycle_event) return undefined;

  const ppid = dependencies.ppid ?? process.ppid;
  if (!Number.isInteger(ppid) || ppid < 1) return undefined;
  const parentExecutable = (dependencies.parentExecutable ?? defaultParentExecutable)(platform, ppid);
  if (!parentExecutable) return undefined;

  const family = inferCommandShellFamily(parentExecutable);
  if (!family) return undefined;
  return {
    family,
    executable: resolveExecutablePath(parentExecutable, platform, environment),
  };
}

export function inferCommandShellFamily(executable: string): CommandShellFamily | undefined {
  const name = executableBasename(executable).toLowerCase().replace(/\.exe$/i, "");
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "fish") return "fish";
  if (POSIX_SH_NAMES.has(name)) return "sh";
  if (name === "pwsh") return "pwsh";
  if (name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return undefined;
}

export function formatCommandShellRuntime(runtime: CommandShellRuntime): string {
  const version = runtime.version ? ` ${runtime.version}` : "";
  return `${runtime.family}${version} (${runtime.executable}; ${runtime.source})`;
}

export function snapshotCommandShellRuntime(runtime: CommandShellRuntime): CommandShellRuntime {
  return { ...runtime, capabilities: [...runtime.capabilities] };
}

export function commandShellAgentInstruction(runtime: CommandShellRuntime): string {
  if (runtime.family === "bash") return "";
  const version = runtime.version ? ` ${runtime.version}` : "";
  return [
    `Command shell runtime: ${runtime.family}${version}.`,
    `Executable: ${runtime.executable}.`,
    `Selection source: ${runtime.source}.`,
    "Write shell commands for this runtime rather than assuming Bash syntax.",
  ].join(" ");
}

function runtimeFromSelection(
  selection: CommandShellSelection,
  source: CommandShellSelectionSource,
): CommandShellRuntime {
  const executable = selection.executable.trim();
  if (!executable) throw new Error(`Command shell ${source} selection is missing an executable.`);
  const family = selection.family ?? inferCommandShellFamily(executable);
  if (!family) {
    throw new Error(
      `Unable to identify the command-shell family for ${executable}. Configure the shell family explicitly instead of allowing ForgeRelay to guess the command language.`,
    );
  }

  return {
    family,
    executable,
    source,
    ...(selection.version?.trim() ? { version: selection.version.trim() } : {}),
    capabilities: Array.from(new Set(selection.capabilities ?? defaultCapabilities(family))),
  };
}

function defaultCapabilities(family: CommandShellFamily): string[] {
  switch (family) {
    case "bash":
      return ["bash", "profile-isolation", "posix-command-language"];
    case "zsh":
      return ["zsh", "profile-isolation", "posix-command-language"];
    case "sh":
      return ["posix-sh", "posix-command-language"];
    case "fish":
      return ["fish-command-language"];
    case "pwsh":
      return ["powershell-command-language", "powershell-core"];
    case "powershell":
      return ["powershell-command-language", "windows-powershell"];
    case "cmd":
      return ["cmd-command-language"];
  }
}

function executableBasename(executable: string): string {
  const normalized = executable.trim().replace(/^"|"$/g, "");
  return win32.basename(normalized.replaceAll("/", "\\"));
}

function resolveExecutablePath(
  executable: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  const trimmed = executable.trim().replace(/^"|"$/g, "");
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed)) return trimmed;
  if (trimmed.includes("/") || trimmed.includes("\\")) return resolve(trimmed);

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (!pathValue) return trimmed;
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = /\.[A-Za-z0-9]+$/.test(trimmed);

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidates = platform === "win32" && !hasExtension
      ? extensions.map((extension) => win32.join(directory, `${trimmed}${extension}`))
      : [platform === "win32" ? win32.join(directory, trimmed) : resolve(directory, trimmed)];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return trimmed;
}

function defaultParentExecutable(platform: NodeJS.Platform, ppid: number): string | undefined {
  if (platform === "linux") {
    try {
      return readlinkSync(`/proc/${ppid}/exe`);
    } catch {
      return psParentExecutable(ppid);
    }
  }
  if (platform === "darwin") return psParentExecutable(ppid);
  if (platform === "win32") return windowsParentExecutable(ppid);
  return undefined;
}

function psParentExecutable(ppid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(ppid), "-o", "comm="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout?.trim() || undefined;
}

function windowsParentExecutable(ppid: number): string | undefined {
  const result = spawnSync(
    "tasklist.exe",
    ["/fi", `PID eq ${ppid}`, "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  const output = result.stdout?.trim();
  if (!output || output.startsWith("INFO:")) return undefined;
  const quoted = /^"([^"]+)"/.exec(output);
  return quoted?.[1] ?? (output.split(",", 1)[0]?.replace(/^"|"$/g, "").trim() || undefined);
}
