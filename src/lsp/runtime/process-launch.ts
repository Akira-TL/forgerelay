import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodeIntelligenceError } from "../code-intelligence-error.js";

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForChildSpawn(child: ChildProcessWithoutNullStreams, serverId: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectPromise(new CodeIntelligenceError(
        "code.language_service_start_failed",
        `Unable to start Language server ${serverId}: ${error.message}.`,
      ));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolvePromise) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      child.off("exit", onExit);
      if (timer) clearTimeout(timer);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
  });
}


export function languageServerCommandRequiresShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}
