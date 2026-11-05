import {
  closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type RuntimeDiagnosticEvent =
  | "runtime_started" | "runtime_signal" | "runtime_exit" | "runtime_uncaught_exception"
  | "runtime_start_failed" | "lsp_start" | "lsp_ready" | "lsp_exit" | "lsp_start_failed"
  | "lsp_shutdown" | "lsp_terminate" | "lsp_operation_failed" | "lsp_cleanup_failed";

export type LanguageServiceShutdownReason =
  | "server_shutdown" | "workspace_retired" | "configuration_unavailable"
  | "configuration_changed" | "invalidated" | "crashed" | "idle_timeout" | "capacity_limit";

export interface RuntimeDiagnosticFields {
  serviceId?: string;
  serverId?: string;
  projectRoot?: string;
  childPid?: number;
  reason?: string;
  signal?: string | null;
  exitCode?: number | null;
  operationsInFlight?: number;
  semanticRequestsActive?: number;
  semanticRequestsQueued?: number;
  operation?: string;
  version?: string;
  errorName?: string;
  errorCode?: string;
  stack?: string[];
}

/** Keep error identities and call sites, without persisting messages or server stderr. */
export function diagnosticError(error: unknown): Pick<RuntimeDiagnosticFields, "errorName" | "errorCode" | "stack"> {
  if (!(error instanceof Error)) return { errorName: "NonError" };
  return {
    errorName: error.name,
    errorCode: "code" in error && typeof error.code === "string" ? error.code : undefined,
    stack: error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 16),
  };
}

/** Synchronous writes retain fatal-event evidence even when Node exits immediately afterwards. */
export class RuntimeDiagnostics {
  readonly path: string;
  private warned = false;

  constructor(stateDir: string, private readonly maxBytes = 4 * 1024 * 1024) {
    this.path = join(stateDir, "logs", "runtime.jsonl");
  }

  record(event: RuntimeDiagnosticEvent, fields: RuntimeDiagnosticFields = {}): void {
    let fd: number | undefined;
    try {
      const bounded = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, event, ...fields },
        (_key, value: unknown) => typeof value === "string" ? value.slice(0, 1024) : value);
      const line = Buffer.from(`${bounded}\n`);
      if (line.length > this.maxBytes) throw new Error("Diagnostic entry exceeds retention limit.");
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = statSync(this.path).size; } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (size + line.length > this.maxBytes) this.rotate();
      fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("Runtime diagnostic destination must be a regular file.");
      fchmodSync(fd, 0o600);
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
    } catch {
      if (!this.warned) {
        this.warned = true;
        console.error(
          "ForgeRelay could not persist runtime diagnostics; check state-directory permissions and disk space.",
        );
      }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* Logging must never replace the original failure. */ }
      }
    }
  }

  private rotate(): void {
    for (let index = 3; index >= 0; index -= 1) {
      const path = index === 0 ? this.path : `${this.path}.${index}`;
      try {
        if (index === 3) unlinkSync(path);
        else renameSync(path, `${this.path}.${index + 1}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

/** Observes fatal errors without converting an unhandled rejection into a recoverable event. */
export function observeRuntimeExit(diagnostics: RuntimeDiagnostics): () => void {
  const onFatal = (error: Error, origin: string) => {
    diagnostics.record("runtime_uncaught_exception", { reason: origin, ...diagnosticError(error) });
  };
  const onExit = (exitCode: number) => diagnostics.record("runtime_exit", { exitCode });
  process.on("uncaughtExceptionMonitor", onFatal);
  process.on("exit", onExit);
  return () => {
    process.off("uncaughtExceptionMonitor", onFatal);
    process.off("exit", onExit);
  };
}
