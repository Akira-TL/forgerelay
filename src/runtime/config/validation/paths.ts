import { resolve } from "node:path";
import { expandHomePath } from "../../../mcp/filesystem/roots.js";

export function normalizeAllowedRootPath(value: string): string {
  const root = value.trim();
  if (!root) throw new Error("Allowed root must be a non-empty path.");
  return resolve(expandHomePath(root));
}

export function normalizeAllowedRootPaths(
  values: readonly string[],
  fallback: readonly string[] = [process.cwd()],
): string[] {
  const roots = values.map((entry) => entry.trim()).filter(Boolean);
  return (roots.length > 0 ? roots : fallback).map(normalizeAllowedRootPath);
}
