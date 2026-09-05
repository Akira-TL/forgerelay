import type { Option } from "@clack/prompts";
import {
  defaultCommandShellSelection,
  normalizeCommandShellSelection,
  type CommandShellFamily,
  type CommandShellPreference,
  type CommandShellSelection,
} from "../../runtime/shell/command-shell-runtime.js";

export type CommandShellSetupChoice =
  | "follow-launcher"
  | "keep-pinned"
  | CommandShellFamily
  | "custom";

export function commandShellSetupOptions(
  platform: NodeJS.Platform,
  current: CommandShellPreference | undefined,
  launcher: CommandShellSelection | undefined,
): Option<CommandShellSetupChoice>[] {
  const options: Option<CommandShellSetupChoice>[] = [];
  if (current?.mode === "pinned") {
    options.push({
      value: "keep-pinned",
      label: `Keep pinned ${current.family}`,
      hint: current.executable,
    });
  }
  options.push({
    value: "follow-launcher",
    label: "Follow the shell used to launch ForgeRelay",
    hint: launcher
      ? `Detected ${launcher.family ?? "shell"}: ${launcher.executable}`
      : "Use the recorded fallback when no launcher shell can be identified.",
  });

  const families: CommandShellFamily[] = platform === "win32"
    ? ["pwsh", "powershell", "cmd", "bash"]
    : ["bash", "zsh", "fish", "sh"];
  for (const family of families) {
    options.push({
      value: family,
      label: shellFamilyLabel(family),
      hint: family === "bash" && platform !== "win32"
        ? "Recommended compatibility path"
        : undefined,
    });
  }
  options.push({
    value: "custom",
    label: "Custom executable path",
    hint: "Pin a portable/green install or a shell-development test binary.",
  });
  return options;
}

export function defaultCommandShellSetupChoice(
  current: CommandShellPreference | undefined,
): CommandShellSetupChoice {
  return current?.mode === "pinned" ? "keep-pinned" : "follow-launcher";
}

export function followLauncherPreference(
  current: CommandShellPreference | undefined,
  launcher: CommandShellSelection | undefined,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandShellPreference {
  const fallback = launcher
    ?? (current?.mode === "follow-launcher" ? current : undefined)
    ?? defaultCommandShellSelection(platform === "win32" ? "cmd" : "bash", platform, environment);
  const normalized = normalizeCommandShellSelection(fallback, platform, environment, true);
  const family = normalized.family ?? fallback.family;
  if (!family) throw new Error(`Unable to identify command-shell family for ${normalized.executable}.`);
  return {
    mode: "follow-launcher",
    family,
    executable: normalized.executable,
  };
}

export function pinnedFamilyPreference(
  family: CommandShellFamily,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandShellPreference {
  const normalized = normalizeCommandShellSelection(
    defaultCommandShellSelection(family, platform, environment),
    platform,
    environment,
    true,
  );
  return {
    mode: "pinned",
    family,
    executable: normalized.executable,
  };
}

export function customPinnedPreference(
  family: CommandShellFamily,
  executable: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandShellPreference {
  const normalized = normalizeCommandShellSelection(
    { family, executable },
    platform,
    environment,
    true,
  );
  return {
    mode: "pinned",
    family,
    executable: normalized.executable,
  };
}

export function preservePinnedPreference(
  current: CommandShellPreference | undefined,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandShellPreference {
  if (!current || current.mode !== "pinned") {
    throw new Error("No pinned command-shell selection is available to preserve.");
  }
  return customPinnedPreference(current.family, current.executable, platform, environment);
}

export function commandShellCompatibilityWarning(
  family: CommandShellFamily,
): string | undefined {
  if (family === "zsh") {
    return "zsh is supported as an explicit command runtime, but Bash remains ForgeRelay's primary POSIX compatibility target. Agent commands and Hooks must use zsh syntax.";
  }
  if (family === "fish") {
    return "fish may be selected explicitly, but ForgeRelay compatibility is less mature than Bash and native fish execution is not enabled until its runtime adapter is available. Agent commands and Hooks must use fish syntax when enabled.";
  }
  return undefined;
}

export function shellFamiliesForCustomSelection(): Array<{ value: CommandShellFamily; label: string }> {
  return (["bash", "zsh", "fish", "sh", "pwsh", "powershell", "cmd"] as const)
    .map((family) => ({ value: family, label: shellFamilyLabel(family) }));
}

function shellFamilyLabel(family: CommandShellFamily): string {
  switch (family) {
    case "bash": return "Bash";
    case "zsh": return "zsh";
    case "fish": return "fish";
    case "sh": return "POSIX sh";
    case "pwsh": return "PowerShell 7 (pwsh)";
    case "powershell": return "Windows PowerShell 5.1";
    case "cmd": return "cmd.exe";
  }
}
