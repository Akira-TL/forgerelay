import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

export async function resolveCanonicalAllowedPath(
  inputPath: string,
  cwd: string,
  allowedRoots: string[],
): Promise<string> {
  const absolutePath = resolveAllowedPath(inputPath, cwd, allowedRoots);
  const canonicalPath = await canonicalizePath(absolutePath);
  const canonicalRoots = await Promise.all(
    allowedRoots.map((root) => canonicalizePath(resolve(expandHomePath(root)))),
  );

  if (canonicalRoots.some((root) => isPathInsideRoot(canonicalPath, root))) {
    return absolutePath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${inputPath}`);
}

async function canonicalizePath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = dirname(candidate);
      if (parent === candidate) return resolve(path);
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}
