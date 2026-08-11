import { CancellationTokenSource, type CancellationToken } from "vscode-jsonrpc";
import { CodeIntelligenceError } from "../code-intelligence-error.js";

export interface SemanticRequestCoordinatorOptions {
  maxConcurrent: number;
  maxQueued: number;
  deadlineMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

export class SemanticRequestCoordinator {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: SemanticRequestCoordinatorOptions) {}

  async run<T>(
    label: string,
    signal: AbortSignal | undefined,
    operation: (token: CancellationToken) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    await this.acquire(label, signal, startedAt);
    const source = new CancellationTokenSource();
    let settledForCaller = false;
    let timeout: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const cancellation = new Promise<never>((_resolve, reject) => {
      const rejectOnce = (error: CodeIntelligenceError) => {
        if (settledForCaller) return;
        settledForCaller = true;
        try {
          source.cancel();
        } catch {
          // The Language-server connection may already have closed or crashed.
        }
        reject(error);
      };
      const remaining = Math.max(1, this.options.deadlineMs - (Date.now() - startedAt));
      timeout = setTimeout(() => rejectOnce(new CodeIntelligenceError(
        "code.request_timeout",
        `${label} exceeded the ${this.options.deadlineMs}ms semantic request deadline.`,
      )), remaining);
      timeout.unref();
      if (signal) {
        onAbort = () => rejectOnce(new CodeIntelligenceError(
          "code.request_cancelled",
          `${label} was cancelled by the Host.`,
        ));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const underlying = operation(source.token);
    underlying.finally(() => {
      source.dispose();
      this.release();
    }).catch(() => undefined);

    try {
      const value = await Promise.race([underlying, cancellation]);
      settledForCaller = true;
      return value;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private async acquire(label: string, signal: AbortSignal | undefined, startedAt: number): Promise<void> {
    if (signal?.aborted) {
      throw new CodeIntelligenceError("code.request_cancelled", `${label} was cancelled by the Host.`);
    }
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.queue.length >= this.options.maxQueued) {
      throw new CodeIntelligenceError(
        "code.request_capacity",
        `Semantic request queue capacity reached (${this.options.maxQueued}) for this Language service.`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const remaining = Math.max(1, this.options.deadlineMs - (Date.now() - startedAt));
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      waiter.timer = setTimeout(() => {
        remove();
        reject(new CodeIntelligenceError(
          "code.request_timeout",
          `${label} exceeded the ${this.options.deadlineMs}ms semantic request deadline while queued.`,
        ));
      }, remaining);
      waiter.timer.unref();
      if (signal) {
        waiter.onAbort = () => {
          remove();
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(new CodeIntelligenceError("code.request_cancelled", `${label} was cancelled by the Host.`));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0 && this.active < this.options.maxConcurrent) {
      const waiter = this.queue.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(new CodeIntelligenceError("code.request_cancelled", "Semantic request was cancelled by the Host."));
        continue;
      }
      this.active += 1;
      waiter.resolve();
    }
  }
}
