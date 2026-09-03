import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function findExecutable(
  command,
  env = process.env,
  platform = process.platform,
) {
  const pathValue = env.PATH ?? env.Path ?? "";
  const pathEntries = pathValue.split(delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const accessMode = platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(directory, platform === "win32" ? `${command}${extension}` : command);
      try {
        accessSync(candidate, accessMode);
        return candidate;
      } catch {
        // Continue searching PATH without invoking or installing anything.
      }
    }
  }
  return undefined;
}

export function probeExecutable(
  executable,
  env = process.env,
  platform = process.platform,
) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 5_000,
    ...(platform === "win32" ? { shell: true } : {}),
  });
  if (result.status === 0) return { available: true };
  const reason = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status ?? "unknown"}`;
  return {
    available: false,
    reason: reason.replace(/\s+/g, " ").slice(0, 240),
  };
}
