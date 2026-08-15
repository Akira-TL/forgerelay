export interface BulkMutationItem<T> {
  path: string;
  status: "done" | "error" | "unexecuted";
  result?: string;
  response?: T;
}

export interface BulkMutationExecution<T> {
  items: BulkMutationItem<T>[];
  completed: number;
  failed: number;
  unexecuted: number;
}

export async function executeSequentialBulkMutation<T>(options: {
  paths: readonly string[];
  signal?: AbortSignal;
  run: (path: string) => Promise<T>;
  isError: (response: T) => boolean;
  resultText: (response: T) => string;
}): Promise<BulkMutationExecution<T>> {
  const items: BulkMutationItem<T>[] = [];

  for (let index = 0; index < options.paths.length; index += 1) {
    options.signal?.throwIfAborted();
    const path = options.paths[index]!;
    try {
      const response = await options.run(path);
      const error = options.isError(response);
      items.push({
        path,
        status: error ? "error" : "done",
        result: options.resultText(response),
        response,
      });
      if (error) {
        appendUnexecuted(items, options.paths, index + 1);
        break;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      items.push({
        path,
        status: "error",
        result: error instanceof Error ? error.message : String(error),
      });
      appendUnexecuted(items, options.paths, index + 1);
      break;
    }
  }

  const completed = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;
  const unexecuted = items.filter((item) => item.status === "unexecuted").length;
  return { items, completed, failed, unexecuted };
}

function appendUnexecuted<T>(
  items: BulkMutationItem<T>[],
  paths: readonly string[],
  start: number,
): void {
  for (let index = start; index < paths.length; index += 1) {
    items.push({ path: paths[index]!, status: "unexecuted" });
  }
}
