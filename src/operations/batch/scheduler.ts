import { relative, sep } from "node:path";

export type BatchResourceMode = "read" | "write";

export interface BatchResourceClaim {
  key: string;
  mode: BatchResourceMode;
}

export interface BatchScheduledTask<T> {
  id: string;
  claims: readonly BatchResourceClaim[];
  exclusive?: boolean;
  run(signal: AbortSignal): Promise<T>;
}

export type BatchScheduledResult<T> =
  | { id: string; status: "done"; value: T }
  | { id: string; status: "error"; error: string };

export interface BatchSchedulerRunOptions {
  concurrency?: number;
  signal?: AbortSignal;
}

interface ActiveTask<T> {
  task: BatchScheduledTask<T>;
  promise: Promise<SettledTask<T>>;
}

type SettledTask<T> =
  | { index: number; status: "done"; value: T }
  | { index: number; status: "error"; error: unknown };

export class BatchScheduler {
  async run<T>(
    tasks: readonly BatchScheduledTask<T>[],
    options: BatchSchedulerRunOptions = {},
  ): Promise<BatchScheduledResult<T>[]> {
    validateTasks(tasks);
    const concurrency = resolveConcurrency(tasks.length, options.concurrency);
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    const pending = new Set(tasks.map((_task, index) => index));
    const active = new Map<number, ActiveTask<T>>();
    const results: Array<BatchScheduledResult<T> | undefined> = new Array(tasks.length);

    while (pending.size > 0 || active.size > 0) {
      signal.throwIfAborted();
      this.startRunnable(tasks, pending, active, concurrency, signal);

      if (active.size === 0) {
        throw new Error("Batch scheduler could not make progress.");
      }

      const settled = await Promise.race([...active.values()].map((entry) => entry.promise));
      active.delete(settled.index);

      if (signal.aborted) {
        await Promise.allSettled([...active.values()].map((entry) => entry.promise));
        throw abortReason(signal);
      }

      const task = tasks[settled.index]!;
      results[settled.index] = settled.status === "done"
        ? { id: task.id, status: "done", value: settled.value }
        : { id: task.id, status: "error", error: errorMessage(settled.error) };
    }

    return results.map((result, index) => {
      if (!result) throw new Error(`Batch task ${tasks[index]?.id ?? index} did not produce a result.`);
      return result;
    });
  }

  private startRunnable<T>(
    tasks: readonly BatchScheduledTask<T>[],
    pending: Set<number>,
    active: Map<number, ActiveTask<T>>,
    concurrency: number,
    signal: AbortSignal,
  ): void {
    while (active.size < concurrency) {
      signal.throwIfAborted();
      const index = [...pending].find((candidate) => canStart(tasks[candidate]!, active));
      if (index === undefined) return;

      const task = tasks[index]!;
      pending.delete(index);
      const promise = Promise.resolve()
        .then(() => task.run(signal))
        .then((value): SettledTask<T> => ({ index, status: "done", value }))
        .catch((error): SettledTask<T> => ({ index, status: "error", error }));
      active.set(index, { task, promise });
    }
  }
}

function validateTasks(tasks: readonly BatchScheduledTask<unknown>[]): void {
  if (tasks.length < 1 || tasks.length > 100) {
    throw new Error(`Batch task count must be between 1 and 100; received ${tasks.length}.`);
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) throw new Error("Batch task id must not be empty.");
    if (ids.has(task.id)) throw new Error(`Batch task ids must be unique; duplicate id: ${task.id}.`);
    ids.add(task.id);
  }
}

function resolveConcurrency(taskCount: number, requested: number | undefined): number {
  const concurrency = requested ?? Math.min(taskCount, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error(`Batch concurrency must be an integer between 1 and 10; received ${concurrency}.`);
  }
  return concurrency;
}

function canStart<T>(
  task: BatchScheduledTask<T>,
  active: Map<number, ActiveTask<T>>,
): boolean {
  if (task.exclusive) return active.size === 0;
  for (const entry of active.values()) {
    if (entry.task.exclusive) return false;
    if (claimsConflict(task.claims, entry.task.claims)) return false;
  }
  return true;
}

function claimsConflict(
  left: readonly BatchResourceClaim[],
  right: readonly BatchResourceClaim[],
): boolean {
  for (const first of left) {
    for (const second of right) {
      if (first.mode === "read" && second.mode === "read") continue;
      if (pathsOverlap(first.key, second.key)) return true;
    }
  }
  return false;
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return isInside(left, right) || isInside(right, left);
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason === undefined ? "Batch execution was cancelled." : String(signal.reason));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
