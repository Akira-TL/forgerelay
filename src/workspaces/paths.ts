import { realpathSync, type Stats } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

type PathStats = Stats;
type DirectoryOps = {
  stat: (path: string) => Promise<PathStats>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
};

export function canonicalPersistedWorkspacePath(path: string): string {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(realpathSync(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        return resolve(path);
      }
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function canonicalPath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function ensureCheckoutWorkspaceRoot(
  path: string,
  ops: DirectoryOps = { stat, mkdir },
): Promise<PathStats> {
  try {
    return await ops.stat(path);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  await ops.mkdir(path, { recursive: true });
  return await ops.stat(path);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
