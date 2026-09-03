import { spawn } from "node:child_process";
import { terminateProcessTree } from "../process/process-platform.js";

const MAX_CAPTURE_BYTES = 64 * 1024;

interface ExecuteHookCommandInput {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  detached: boolean;
  signal?: AbortSignal;
}

interface ExecuteHookCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function executeHookCommand(input: ExecuteHookCommandInput): Promise<ExecuteHookCommandResult> {
  input.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: input.detached,
      windowsHide: true,
      windowsVerbatimArguments: input.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      terminateProcessTree(child, "SIGTERM", input.detached);
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", input.detached);
      }, 500);
      forceKillTimer.unref();
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendCaptured(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM", input.detached);
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", input.detached);
      }, 500);
      forceKillTimer.unref();
    }, input.timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(input.signal?.reason instanceof Error
          ? input.signal.reason
          : Object.assign(new Error("Hook execution cancelled by Host."), { name: "AbortError" }));
        return;
      }
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function appendCaptured(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next).subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
}

export function hookFailureOutput(stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
  return output.length > 1_000 ? `${output.slice(0, 997)}...` : output;
}
