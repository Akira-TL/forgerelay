import { spawn } from "node:child_process";
import { assertPipedChild, errorMessage, terminateChildOnAbort } from "../shared.js";

export interface ExternalCommandRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: string;
  label: string;
}

export interface ExternalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExternalCommandRunner = (
  request: ExternalCommandRequest,
) => Promise<ExternalCommandResult>;

export const runExternalCommand: ExternalCommandRunner = async (
  request,
): Promise<ExternalCommandResult> => {
  request.signal?.throwIfAborted();
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  assertPipedChild(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const detachAbort = terminateChildOnAbort(child, request.signal);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        if (request.signal?.aborted) {
          const aborted = new Error(`${request.label} command cancelled.`);
          aborted.name = "AbortError";
          reject(aborted);
          return;
        }
        if (signal) {
          reject(new Error(`${request.label} command terminated by ${signal}${stderr ? `\n${stderr.trim()}` : ""}`));
          return;
        }
        resolve(code ?? 0);
      });
    });

    if (exitCode !== 0) {
      throw new Error(
        `${request.label} command exited with code ${exitCode}${stderr ? `\n${stderr.trim()}` : ""}`,
      );
    }
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (request.signal?.aborted && !(error instanceof Error && error.name === "AbortError")) {
      const aborted = new Error(`${request.label} command cancelled: ${errorMessage(error)}`);
      aborted.name = "AbortError";
      throw aborted;
    }
    throw error;
  } finally {
    detachAbort();
    if (!child.killed && child.exitCode === null) child.kill();
  }
};
