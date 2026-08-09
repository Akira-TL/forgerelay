import { lstat, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { expandHomePath, resolveCanonicalAllowedPath } from "./roots.js";

export interface FileMutationContext {
  cwd: string;
  allowedRoots: string[];
}

export interface RenamePathInput {
  path: string;
  newPath: string;
}

export interface RenamePathResult {
  path: string;
  newPath: string;
}

export interface DeletePathInput {
  path: string;
  recursive?: boolean;
}

export interface DeletePathResult {
  path: string;
  recursive: boolean;
}

export async function renamePath(
  input: RenamePathInput,
  context: FileMutationContext,
): Promise<RenamePathResult> {
  const source = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.allowedRoots,
  );
  await assertNotAllowedRootItself(source, context.allowedRoots, input.path);
  const destination = await resolveCanonicalAllowedPath(
    input.newPath,
    context.cwd,
    context.allowedRoots,
  );
  await assertDestinationMissing(destination, input.newPath);
  await lstat(source);
  await rename(source, destination);
  return { path: input.path, newPath: input.newPath };
}

export async function deletePath(
  input: DeletePathInput,
  context: FileMutationContext,
): Promise<DeletePathResult> {
  const path = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.allowedRoots,
  );
  await assertNotAllowedRootItself(path, context.allowedRoots, input.path);
  const entry = await lstat(path);
  const recursive = input.recursive ?? false;

  if (entry.isDirectory()) {
    if (recursive) {
      await rm(path, { recursive: true, force: false });
    } else {
      await rmdir(path);
    }
  } else {
    await unlink(path);
  }

  return { path: input.path, recursive };
}

async function assertDestinationMissing(path: string, inputPath: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Rename destination already exists: ${inputPath}`);
}

async function assertNotAllowedRootItself(
  path: string,
  allowedRoots: string[],
  inputPath: string,
): Promise<void> {
  const canonicalPath = await realpath(path);
  for (const root of allowedRoots) {
    const canonicalRoot = await realpath(resolve(expandHomePath(root)));
    if (canonicalPath === canonicalRoot) {
      throw new Error(`Cannot rename or delete an allowed root itself: ${inputPath}`);
    }
  }
}
