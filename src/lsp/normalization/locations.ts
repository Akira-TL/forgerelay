import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Location, LocationLink, Range } from "vscode-languageserver-protocol";
import { CodeIntelligenceError } from "../code-intelligence-error.js";
import type { CodeIntelligenceLocation } from "../code-intelligence-types.js";
import { rangeFromLsp } from "../position-encoding.js";

export interface LocationEntry {
  uri: string;
  range: Range;
}

export function locationEntries(
  response: Location | Location[] | LocationLink[] | null,
): LocationEntry[] {
  if (!response) return [];
  const entries = Array.isArray(response) ? response : [response];
  return entries.map((entry) => isLocationLink(entry)
    ? { uri: entry.targetUri, range: entry.targetRange }
    : { uri: entry.uri, range: entry.range });
}

export async function normalizeLocations(
  entries: readonly LocationEntry[],
  workspaceRoot: string,
  encoding: string,
): Promise<CodeIntelligenceLocation[]> {
  return Promise.all(entries.map(async ({ uri, range }) => {
    if (!uri.startsWith("file:")) {
      throw new CodeIntelligenceError(
        "code.result_outside_policy",
        `Language server returned a non-file code location: ${uri}`,
      );
    }
    const targetPath = fileURLToPath(uri);
    const root = resolve(workspaceRoot);
    let resolvedTarget: string;
    let text: string;
    try {
      resolvedTarget = await realpath(targetPath);
      text = await readFile(resolvedTarget, "utf8");
    } catch (error) {
      throw new CodeIntelligenceError(
        "code.result_outside_policy",
        `Unable to normalize code location ${targetPath}: ${errorMessage(error)}`,
      );
    }
    const external = !isWithin(root, resolvedTarget);
    return {
      path: external ? resolvedTarget : workspaceDisplayPath(root, resolvedTarget),
      external,
      range: rangeFromLsp(text, range, encoding),
    };
  }));
}

export function workspaceDisplayPath(workspaceRoot: string, path: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  if (!rel) return ".";
  return rel.split(sep).join("/");
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
