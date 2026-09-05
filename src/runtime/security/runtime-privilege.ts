import { spawnSync } from "node:child_process";

export type RuntimePrivilegeLevel = "standard" | "elevated" | "unknown";

export interface RuntimePrivilegeState {
  level: RuntimePrivilegeLevel;
  platform: NodeJS.Platform;
  source: "posix-euid" | "windows-token" | "unsupported";
  detail?: string;
}

interface RuntimePrivilegeDependencies {
  platform?: NodeJS.Platform;
  geteuid?: () => number;
  runWindowsWhoami?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

const WINDOWS_ELEVATED_INTEGRITY_SIDS = [
  "S-1-16-12288", // High Mandatory Level
  "S-1-16-16384", // System Mandatory Level
  "S-1-16-20480", // Protected Process Mandatory Level
] as const;
const WINDOWS_LOCAL_SYSTEM_SID = "S-1-5-18";

export function detectRuntimePrivilege(
  dependencies: RuntimePrivilegeDependencies = {},
): RuntimePrivilegeState {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    return detectWindowsRuntimePrivilege(
      dependencies.runWindowsWhoami ?? runWindowsWhoami,
    );
  }

  if (platform === "linux" || platform === "darwin") {
    const geteuid = dependencies.geteuid ?? process.geteuid?.bind(process);
    if (!geteuid) {
      return {
        level: "unknown",
        platform,
        source: "unsupported",
        detail: "effective user id is unavailable",
      };
    }
    return {
      level: geteuid() === 0 ? "elevated" : "standard",
      platform,
      source: "posix-euid",
    };
  }

  return {
    level: "unknown",
    platform,
    source: "unsupported",
    detail: `privilege detection is not implemented for ${platform}`,
  };
}

export function assertRuntimePrivilegeAllowed(
  state: RuntimePrivilegeState,
  allowElevated: boolean,
): void {
  if (state.level === "standard" || allowElevated) return;

  const detected = state.level === "elevated"
    ? "ForgeRelay detected elevated operating-system privileges."
    : `ForgeRelay could not safely determine whether this process is elevated${state.detail ? ` (${state.detail})` : ""}.`;
  throw new Error(
    [
      detected,
      "ForgeRelay refuses to start its Agent/Hook runtime with system-level or unknown privilege by default because commands may make system-wide or irreversible changes.",
      "",
      "Run ForgeRelay as a normal user, or if elevated execution is intentional, acknowledge the risk for this invocation:",
      "  forgerelay serve --allow-elevated",
      "",
      "The --allow-elevated acknowledgement is invocation-scoped and is not a persistent configuration setting.",
    ].join("\n"),
  );
}

export function formatRuntimePrivilege(state: RuntimePrivilegeState): string {
  const detail = state.detail ? ` (${state.detail})` : "";
  return `${state.level}${detail}`;
}

export function elevatedRuntimeWarning(state: RuntimePrivilegeState): string {
  const status = state.level === "elevated"
    ? "elevated operating-system privileges"
    : state.level === "unknown"
      ? "an unverified operating-system privilege level"
      : "standard operating-system privileges";
  return [
    `WARNING: --allow-elevated was supplied and ForgeRelay is starting with ${status}.`,
    "Agent and Hook commands run with the ForgeRelay process authority and may make system-wide or irreversible changes.",
    "Continue only when this level of operating-system access is intentional.",
  ].join("\n");
}

function detectWindowsRuntimePrivilege(
  runWhoami: NonNullable<RuntimePrivilegeDependencies["runWindowsWhoami"]>,
): RuntimePrivilegeState {
  const user = runWhoami(["/user", "/fo", "csv", "/nh"]);
  const groups = runWhoami(["/groups", "/fo", "csv", "/nh"]);
  if (user.status !== 0 || groups.status !== 0) {
    const reason = [user.stderr, groups.stderr]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("; ");
    return {
      level: "unknown",
      platform: "win32",
      source: "windows-token",
      detail: reason || "whoami.exe could not inspect the current process token",
    };
  }

  if (containsSid(user.stdout, WINDOWS_LOCAL_SYSTEM_SID)) {
    return {
      level: "elevated",
      platform: "win32",
      source: "windows-token",
      detail: "LocalSystem token",
    };
  }

  const elevatedIntegritySid = WINDOWS_ELEVATED_INTEGRITY_SIDS.find((sid) =>
    containsSid(groups.stdout, sid)
  );
  if (elevatedIntegritySid) {
    return {
      level: "elevated",
      platform: "win32",
      source: "windows-token",
      detail: `integrity ${elevatedIntegritySid}`,
    };
  }

  return {
    level: "standard",
    platform: "win32",
    source: "windows-token",
  };
}

function containsSid(output: string, sid: string): boolean {
  const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9-])${escaped}(?:$|[^0-9-])`, "i").test(output);
}

function runWindowsWhoami(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("whoami.exe", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
