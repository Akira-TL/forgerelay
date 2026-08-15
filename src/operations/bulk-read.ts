export interface BulkReadChild<T> {
  path: string;
  status: "done" | "error";
  result: string;
  response?: T;
}

export interface BulkReadExecution<T> {
  children: BulkReadChild<T>[];
  succeeded: number;
  failed: number;
}

export async function executeBulkRead<T>(options: {
  paths: readonly string[];
  signal?: AbortSignal;
  run: (path: string) => Promise<T>;
  isError: (response: T) => boolean;
  resultText: (response: T) => string;
}): Promise<BulkReadExecution<T>> {
  const children = await Promise.all(options.paths.map(async (path): Promise<BulkReadChild<T>> => {
    try {
      const response = await options.run(path);
      return {
        path,
        status: options.isError(response) ? "error" : "done",
        result: options.resultText(response),
        response,
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return {
        path,
        status: "error",
        result: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  const failed = children.filter((child) => child.status === "error").length;
  return {
    children,
    succeeded: children.length - failed,
    failed,
  };
}
