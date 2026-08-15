import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { resolveCanonicalAllowedPath } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  fileRoots?: string[];
  readRoots?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.readRoots ?? [context.root],
  );
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.fileRoots ?? [context.root],
  );
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.fileRoots ?? [context.root],
  );
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function preflightEditFiles(
  paths: readonly string[],
  edits: EditToolInput["edits"],
  context: ToolContext,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const response = await preflightEditFileTool({ path, edits }, context, signal);
    if (response.isError) {
      const message = response.content
        .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n");
      throw new Error(`Bulk Edit preflight failed for ${path}: ${message}`);
    }
    const absolute = await resolveCanonicalAllowedPath(
      path,
      context.cwd,
      context.fileRoots ?? [context.root],
    );
    const canonical = await fsRealpath(absolute);
    const previous = seen.get(canonical);
    if (previous) {
      throw new Error(`Bulk Edit targets overlap: ${previous} and ${path} resolve to the same file.`);
    }
    seen.set(canonical, path);
  }
}

export async function preflightEditFileTool(
  input: EditToolInput,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResponse<EditToolDetails>> {
  signal?.throwIfAborted();
  const path = await resolveCanonicalAllowedPath(
    input.path,
    context.cwd,
    context.fileRoots ?? [context.root],
  );
  const tool = createEditTool(context.cwd, {
    operations: {
      readFile: fsReadFile,
      writeFile: async () => {},
      access: (absolutePath) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
    },
  });
  const response = await runTool(
    (params) => tool.execute("edit_file", params, signal),
    { path, edits: input.edits },
    context,
  );
  signal?.throwIfAborted();
  return response;
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path
    ? await resolveCanonicalAllowedPath(input.path, context.cwd, context.fileRoots ?? [context.root])
    : undefined;
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), { ...input, path }, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = input.path
    ? await resolveCanonicalAllowedPath(input.path, context.cwd, context.fileRoots ?? [context.root])
    : undefined;
  const tool = createFindTool(context.cwd);

  return runTool((params) => tool.execute("find_files", params), { ...input, path }, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = await resolveCanonicalAllowedPath(
    input.path ?? ".",
    context.cwd,
    context.fileRoots ?? [context.root],
  );
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), { ...input, path }, context);
}
