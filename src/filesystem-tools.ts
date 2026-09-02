import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createPatch } from "diff";
import { resolveCanonicalAllowedPath } from "./roots.js";

const DEFAULT_MAX_LINES = 2_000;
const DEFAULT_MAX_BYTES = 50 * 1_024;

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResponse<TDetails = unknown> {
  [key: string]: unknown;
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
}

interface ToolContext {
  cwd: string;
  root: string;
  fileRoots?: string[];
  readRoots?: string[];
}

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface EditReplacement {
  oldText: string;
  newText: string;
}

export interface EditToolInput {
  path: string;
  edits: EditReplacement[];
}

export interface EditToolDetails {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

interface PreparedEdit {
  start: number;
  end: number;
  newText: string;
}

const mutationQueues = new Map<string, Promise<void>>();

function textContent(text: string): ToolResponse["content"] {
  return [{ type: "text", text }];
}

function failed(error: unknown): ToolResponse<never> {
  return {
    content: textContent(error instanceof Error ? error.message : String(error)),
    isError: true,
  };
}

export async function readFileTool(
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  try {
    const path = await resolveCanonicalAllowedPath(
      input.path,
      context.cwd,
      context.readRoots ?? [context.root],
    );
    await access(path, constants.R_OK);
    const buffer = await readFile(path);
    const mimeType = supportedImageMimeType(buffer);
    if (mimeType) {
      return {
        content: [
          { type: "text", text: `Read image file [${mimeType}]` },
          { type: "image", data: buffer.toString("base64"), mimeType },
        ],
      };
    }

    return { content: textContent(readText(buffer.toString("utf8"), input)) };
  } catch (error) {
    return failed(error);
  }
}

export async function writeFileTool(
  input: WriteToolInput,
  context: ToolContext,
): Promise<ToolResponse> {
  try {
    const path = await resolveCanonicalAllowedPath(
      input.path,
      context.cwd,
      context.fileRoots ?? [context.root],
    );
    await withMutationQueue(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content, "utf8");
    });
    return { content: textContent(`Successfully wrote ${input.content.length} bytes to ${input.path}`) };
  } catch (error) {
    return failed(error);
  }
}

export async function editFileTool(
  input: EditToolInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResponse<EditToolDetails>> {
  try {
    const path = await resolveCanonicalAllowedPath(
      input.path,
      context.cwd,
      context.fileRoots ?? [context.root],
    );
    const details = await withMutationQueue(path, async () => {
      signal?.throwIfAborted();
      await access(path, constants.R_OK | constants.W_OK);
      signal?.throwIfAborted();
      const raw = await readFile(path, "utf8");
      signal?.throwIfAborted();
      const applied = applyExactEdits(raw, input.edits, input.path);
      await writeFile(path, applied.output, "utf8");
      signal?.throwIfAborted();
      return applied.details;
    });
    return {
      content: textContent(`Successfully replaced ${input.edits.length} block(s) in ${input.path}.`),
      details,
    };
  } catch (error) {
    return failed(error) as ToolResponse<EditToolDetails>;
  }
}

export async function preflightEditFiles(
  paths: readonly string[],
  edits: EditReplacement[],
  context: ToolContext,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Map<string, string>();
  for (const path of paths) {
    signal?.throwIfAborted();
    const absolute = await resolveCanonicalAllowedPath(
      path,
      context.cwd,
      context.fileRoots ?? [context.root],
    );
    const canonical = await realpath(absolute);
    const previous = seen.get(canonical);
    if (previous) {
      throw new Error(`Bulk Edit targets overlap: ${previous} and ${path} resolve to the same file.`);
    }
    seen.set(canonical, path);

    await access(absolute, constants.R_OK | constants.W_OK);
    const content = await readFile(absolute, "utf8");
    applyExactEdits(content, edits, path);
  }
}

function readText(content: string, input: ReadToolInput): string {
  const lines = content.split("\n");
  const startIndex = Math.max(0, (input.offset ?? 1) - 1);
  if (startIndex >= lines.length) {
    throw new Error(`Offset ${input.offset} is beyond end of file (${lines.length} lines total)`);
  }

  const explicitEnd = input.limit === undefined
    ? lines.length
    : Math.min(lines.length, startIndex + input.limit);
  const selected = lines.slice(startIndex, explicitEnd);
  const limited = truncateLinesAndBytes(selected, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
  const startLine = startIndex + 1;
  const endLine = startLine + limited.lines.length - 1;
  let output = limited.lines.join("\n");

  if (limited.truncated) {
    const nextOffset = endLine + 1;
    output += `\n\n[Showing lines ${startLine}-${endLine} of ${lines.length}. Use offset=${nextOffset} to continue.]`;
  } else if (explicitEnd < lines.length) {
    const remaining = lines.length - explicitEnd;
    output += `\n\n[${remaining} more lines in file. Use offset=${explicitEnd + 1} to continue.]`;
  }
  return output;
}

function truncateLinesAndBytes(
  lines: string[],
  maxLines: number,
  maxBytes: number,
): { lines: string[]; truncated: boolean } {
  const output: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (output.length >= maxLines) return { lines: output, truncated: true };
    const prefix = output.length === 0 ? "" : "\n";
    const lineBytes = Buffer.byteLength(prefix + line, "utf8");
    if (bytes + lineBytes > maxBytes) {
      if (output.length === 0) {
        return {
          lines: [`[Line exceeds ${maxBytes} byte read limit. Use bash for byte-oriented inspection.]`],
          truncated: true,
        };
      }
      return { lines: output, truncated: true };
    }
    output.push(line);
    bytes += lineBytes;
  }
  return { lines: output, truncated: false };
}

function applyExactEdits(
  rawContent: string,
  edits: EditReplacement[],
  displayPath: string,
): { output: string; details: EditToolDetails } {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }

  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const original = normalizeLineEndings(text);
  const prepared: PreparedEdit[] = edits.map((edit, index) => {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" || edit.oldText.length === 0) {
      throw new Error(`Edit ${index + 1} must contain non-empty oldText and string newText.`);
    }
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    const start = original.indexOf(oldText);
    if (start < 0) {
      throw new Error(`Could not edit ${displayPath}: oldText for replacement ${index + 1} did not match.`);
    }
    if (original.indexOf(oldText, start + oldText.length) >= 0) {
      throw new Error(`Could not edit ${displayPath}: oldText for replacement ${index + 1} must be unique but matched multiple locations.`);
    }
    return { start, end: start + oldText.length, newText };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index]!.start < prepared[index - 1]!.end) {
      throw new Error(`Could not edit ${displayPath}: replacements overlap in the original file.`);
    }
  }

  let cursor = 0;
  let updated = "";
  for (const edit of prepared) {
    updated += original.slice(cursor, edit.start);
    updated += edit.newText;
    cursor = edit.end;
  }
  updated += original.slice(cursor);

  const firstChangedLine = prepared.length === 0
    ? undefined
    : original.slice(0, prepared[0]!.start).split("\n").length;
  const patch = createPatch(displayPath, original, updated, "", "", { context: 3 });
  const diff = patch;
  const output = bom + restoreLineEndings(updated, lineEnding);
  return { output, details: { diff, patch, firstChangedLine } };
}

function stripBom(content: string): { bom: string; text: string } {
  return content.charCodeAt(0) === 0xfeff
    ? { bom: "\ufeff", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" | "\r" {
  if (content.includes("\r\n")) return "\r\n";
  if (content.includes("\r")) return "\r";
  return "\n";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n" | "\r"): string {
  return lineEnding === "\n" ? content : content.replaceAll("\n", lineEnding);
}

function supportedImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

async function withMutationQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const canonical = await canonicalMutationPath(path);
  const previous = mutationQueues.get(canonical) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(canonical, previous.then(() => current));
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(canonical) === current) mutationQueues.delete(canonical);
  }
}

async function canonicalMutationPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return `${await realpath(dirname(path))}/${path.slice(dirname(path).length + 1)}`;
    } catch {
      return path;
    }
  }
}
