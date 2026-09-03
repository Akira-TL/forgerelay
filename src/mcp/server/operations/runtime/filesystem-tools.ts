import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { applyPatch } from "../../../filesystem/apply-patch.js";
import { ActivityLifecycle } from "../../../../activity/runtime/lifecycle.js";
import { loadCapabilityGuides } from "../../core/capabilities.js";
import type { ServerConfig } from "../../../../runtime/config/config.js";
import { HookRunner } from "../../../../hooks.js";
import { buildToolDescriptions, toolNames } from "../../../server-instructions.js";
import { executeBulkRead } from "../../../operations/bulk-read.js";
import { NativeBulkMutationExecutor } from "../../../operations/native-bulk-mutations.js";
import { CoreOperationExecutor, type CoreOperationContext } from "../../../operations/core-operation-executor.js";
import { CompositeWorkspaceRegistry } from "../../../../workspaces/composite/composite-workspaces.js";
import { RemoteWorkspaceRelay } from "../../../../remote-workspace-relay.js";
import { formatPathForPrompt } from "../../../../workspaces/resources/skills.js";
import { WorkspaceRegistry } from "../../../../workspaces.js";
import type { ProcessExecutionTarget } from "../../../process/tools.js";
import {
  activityRelationFor,
  activityRequestFor,
  runActivityTool,
  runActivityToolWithHooks,
} from "../../core/activity-support.js";
import { workspaceHookInvocation } from "../../core/capability-support.js";
import { resultOutputSchema, workspaceAgentsFileOutputSchema } from "../../core/schemas.js";
import {
  contentText,
  logToolCall,
  textBlock,
  toolResultAgentsFiles,
  toolResultContent,
  toolResultIsError,
  toolResultText,
  workspaceLogContext,
  type ToolContent,
} from "../../core/tool-support.js";

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export interface RegisterFilesystemToolsOptions {
  server: McpServer;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  compositeWorkspaces: CompositeWorkspaceRegistry;
  compositeTaskGuides: ReturnType<typeof loadCapabilityGuides>;
  remoteWorkspaces: RemoteWorkspaceRelay;
  coreOperations: CoreOperationExecutor<any>;
  nativeBulkMutations: NativeBulkMutationExecutor;
  activityLifecycle: ActivityLifecycle;
  hooks: HookRunner;
  toolDescriptions: ReturnType<typeof buildToolDescriptions>;
  resolveExecutionTarget: (workspaceId: string, member?: string) => ProcessExecutionTarget;
  prepareExecutionContext: (
    target: ProcessExecutionTarget,
    requestMeta: unknown,
    signal: AbortSignal | undefined,
    sessionId: string | undefined,
  ) => Promise<CoreOperationContext>;
  presentSemanticWorkResult: <T>(result: T, target: ProcessExecutionTarget) => T;
  hostScopeIdFor: (requestMeta: unknown, sessionId?: string) => string;
}

export function registerFilesystemTools(options: RegisterFilesystemToolsOptions): void {
  const {
    server, config, workspaces, compositeWorkspaces, compositeTaskGuides, remoteWorkspaces,
    coreOperations, nativeBulkMutations, activityLifecycle, hooks, toolDescriptions,
    resolveExecutionTarget, prepareExecutionContext, presentSemanticWorkResult, hostScopeIdFor,
  } = options;
  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description: toolDescriptions.read,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z
          .string()
          .optional()
          .describe("Required for Composite member-scoped file reads. Omit only when reading an advertised Composite-owned capability guide."),
        path: z
          .string()
          .optional()
          .describe(
            config.skillsEnabled
              ? "One file path to read, relative to the workspace root or absolute inside the OS temp directory. Load an available skill with skills://<name>; after loading it, read files in that skill with skills://<name>/<relative-path>. Advertised capability-guide paths from open_workspace are also readable. Use exactly one of path or paths."
              : "One file path to read, relative to the workspace root or absolute inside the OS temp directory. May also be an advertised capability-guide path from open_workspace. Use exactly one of path or paths.",
          ),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple file paths to read in one call. Uses the same offset/limit for every file. Use exactly one of path or paths."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema({
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error"]),
          result: z.string(),
        })).optional(),
        files: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
      }),
      _meta: {},
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, member, path, paths, offset, limit }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("read requires exactly one of path or paths.");
      }
      if (compositeWorkspaces.has(workspaceId) && member === undefined && path !== undefined) {
        const guide = compositeTaskGuides.find(
          (candidate) => formatPathForPrompt(candidate.filePath) === path || candidate.filePath === path,
        );
        if (guide) {
          if (!compositeWorkspaces.isActive(workspaceId)) {
            throw new Error(`Composite Workspace ${workspaceId} is closed. Reopen it with open_workspace before use.`);
          }
          const startedAt = performance.now();
          const raw = readFileSync(guide.filePath, "utf8");
          const start = (offset ?? 1) - 1;
          const end = limit === undefined ? undefined : start + limit;
          const result = raw.split("\n").slice(start, end).join("\n");
          logToolCall(config, {
            tool: toolNames.read,
            path: formatPathForPrompt(guide.filePath),
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            content: [textBlock(result)],
            structuredContent: { result },
          };
        }
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.read(
          executionWorkspaceId,
          { path, paths, offset, limit },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.read(
          { workspaceId: executionWorkspaceId, path, offset, limit },
          executionContext,
        ), target);
      }

      const workspace = workspaces.getWorkspace(executionWorkspaceId);
      let response: {
        content: ToolContent[];
        structuredContent: {
          result: string;
          results: Array<{ path: string; status: "done" | "error"; result: string }>;
          files: number;
          failed: number;
          agentsFiles?: Array<{ path: string; content: string }>;
        };
      } | undefined;
      await runActivityTool(
        activityLifecycle,
        workspace,
        hostScopeIdFor(extra._meta, extra.sessionId),
        toolNames.read,
        activityRequestFor({ workspaceId: executionWorkspaceId, paths, offset, limit }, executionContext),
        async (parentContext) => {
          const execution = await executeBulkRead({
            paths: paths!,
            signal: extra.signal,
            run: (childPath) => coreOperations.read(
              { workspaceId: executionWorkspaceId, path: childPath, offset, limit },
              {
                ...executionContext,
                parentActivityId: parentContext.activityId,
                turnId: parentContext.turnId,
              },
            ),
            isError: toolResultIsError,
            resultText: toolResultText,
          });
          const content = execution.children.flatMap((child): ToolContent[] => [
            textBlock(`--- ${child.path} · ${child.status} ---`),
            ...(child.response
              ? toolResultContent(child.response)
              : [textBlock(child.result)]),
          ]);
          const seenAgentPaths = new Set<string>();
          const agentsFiles = execution.children.flatMap((child) =>
            child.response ? toolResultAgentsFiles(child.response) : []
          ).filter((file) => {
            if (seenAgentPaths.has(file.path)) return false;
            seenAgentPaths.add(file.path);
            return true;
          });
          response = {
            content,
            structuredContent: {
              result: contentText(content),
              results: execution.children.map(({ path: childPath, status, result }) => ({
                path: childPath,
                status,
                result,
              })),
              files: execution.children.length,
              failed: execution.failed,
              ...(agentsFiles.length > 0 ? { agentsFiles } : {}),
            },
          };
          return {
            childCount: execution.children.length,
            succeeded: execution.succeeded,
            failed: execution.failed,
          };
        },
        (summary) => summary.failed > 0
          ? { type: "failed", error: `${summary.failed} of ${summary.childCount} child Reads failed.` }
          : { type: "succeeded" },
        activityRelationFor(executionContext),
      );
      if (!response) throw new Error("Bulk Read completed without a response.");
      return presentSemanticWorkResult(response, target);
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description: toolDescriptions.write,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root or absolute inside the OS temp directory."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(),
      _meta: {},
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, ...input }, extra) => {
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.write(
          executionWorkspaceId,
          input,
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      return presentSemanticWorkResult(await coreOperations.write(
        { workspaceId: executionWorkspaceId, ...input },
        executionContext,
      ), target);
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description: toolDescriptions.edit,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z
          .string()
          .optional()
          .describe("One file path to edit. Use exactly one of path or paths."),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple file paths to edit with the same edits. Use exactly one of path or paths."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["applied", "partial"]),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error", "unexecuted"]),
          result: z.string().optional(),
        })).optional(),
        files: z.number().int().nonnegative().optional(),
        completed: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        unexecuted: z.number().int().nonnegative().optional(),
      }),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, paths, edits }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("edit requires exactly one of path or paths.");
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.edit(
          executionWorkspaceId,
          { path, paths, edits },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.edit(
          { workspaceId: executionWorkspaceId, path, edits },
          executionContext,
        ), target);
      }

      return presentSemanticWorkResult(await nativeBulkMutations.edit(
        { workspaceId: executionWorkspaceId, paths: paths!, edits },
        executionContext,
      ), target);
    },
  );
  }

  registerAppTool(
    server,
    toolNames.rename,
    {
      title: "Rename path",
      description: toolDescriptions.rename,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z.string().describe("Source file or directory path relative to the workspace root, or absolute inside the OS temp directory."),
        newPath: z.string().describe("Destination path relative to the workspace root, or absolute inside the OS temp directory. The destination must not already exist."),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("renamed"),
        path: z.string(),
        newPath: z.string(),
      }),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, newPath }, extra) => {
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.rename(
          executionWorkspaceId,
          { path, newPath },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      return presentSemanticWorkResult(await coreOperations.rename(
        { workspaceId: executionWorkspaceId, path, newPath },
        executionContext,
      ), target);
    },
  );

  registerAppTool(
    server,
    toolNames.delete,
    {
      title: "Delete path",
      description: toolDescriptions.delete,
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier returned by open_workspace."),
        member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this operation."),
        path: z.string().optional().describe("One file or directory path to delete. Use exactly one of path or paths."),
        paths: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe("Multiple paths to delete in one call. Use exactly one of path or paths."),
        recursive: z.boolean().optional().describe("Delete non-empty directory trees. Defaults to false and applies to every bulk target."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["deleted", "partial"]),
        path: z.string().optional(),
        recursive: z.boolean().optional(),
        results: z.array(z.object({
          path: z.string(),
          status: z.enum(["done", "error", "unexecuted"]),
          result: z.string().optional(),
        })).optional(),
        paths: z.number().int().nonnegative().optional(),
        completed: z.number().int().nonnegative().optional(),
        failed: z.number().int().nonnegative().optional(),
        unexecuted: z.number().int().nonnegative().optional(),
      }),
      _meta: {},
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, member, path, paths, recursive }, extra) => {
      if ((path === undefined) === (paths === undefined)) {
        throw new Error("delete requires exactly one of path or paths.");
      }
      const target = resolveExecutionTarget(workspaceId, member);
      const executionWorkspaceId = target.executionWorkspaceId;
      const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
      if (remoteWorkspaces.has(executionWorkspaceId)) {
        return presentSemanticWorkResult(await remoteWorkspaces.delete(
          executionWorkspaceId,
          { path, paths, recursive },
          hostScopeIdFor(extra._meta, extra.sessionId),
        ), target);
      }
      if (path !== undefined) {
        return presentSemanticWorkResult(await coreOperations.delete(
          { workspaceId: executionWorkspaceId, path, recursive },
          executionContext,
        ), target);
      }

      return presentSemanticWorkResult(await nativeBulkMutations.delete(
        { workspaceId: executionWorkspaceId, paths: paths!, recursive },
        executionContext,
      ), target);
    },
  );

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description: toolDescriptions.applyPatch,
        inputSchema: {
          workspaceId: z
            .string()
            .describe("Workspace identifier returned by open_workspace."),
          member: z.string().optional().describe("Required for a Composite Workspace; explicit member name that owns this patch."),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
          _meta: {},
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, member, patch }, extra) => {
        const target = resolveExecutionTarget(workspaceId, member);
        const executionWorkspaceId = target.executionWorkspaceId;
        const executionContext = await prepareExecutionContext(target, extra._meta, extra.signal, extra.sessionId);
        if (remoteWorkspaces.has(executionWorkspaceId)) {
          return presentSemanticWorkResult(await remoteWorkspaces.applyPatch(
            executionWorkspaceId,
            { patch },
            hostScopeIdFor(extra._meta, extra.sessionId),
          ), target);
        }
        const workspace = workspaces.getWorkspace(executionWorkspaceId);
        return runActivityToolWithHooks(
          activityLifecycle,
          hooks,
          workspace,
          hostScopeIdFor(extra._meta, extra.sessionId),
          activityRequestFor({ workspaceId: executionWorkspaceId, patch }, executionContext),
          {
            signal: extra.signal,
          tool: "apply_patch",
          invocation: workspaceHookInvocation(workspace),
          payload: { patchBytes: Buffer.byteLength(patch) },
          changedPaths: (response) => Array.from(new Set(
            response.structuredContent.files.flatMap((file) => [file.previousPath, file.path])
              .filter((path): path is string => Boolean(path)),
          )),
          operation: async () => {
            const startedAt = performance.now();
            const applied = await applyPatch(workspace.root, patch, [tmpdir()]);
            const paths = applied.files.map((file) => file.path).join(", ");
            const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
            const content = [textBlock(result)];
            const displayPath = applied.files.length === 1
              ? applied.files[0]?.path
              : `${applied.files.length} files`;

            logToolCall(config, {
              tool: "apply_patch",
              ...workspaceLogContext(workspace, extra.sessionId),
              path: displayPath,
              success: true,
              durationMs: Math.round(performance.now() - startedAt),
            });

            return {
              content,
              _meta: {
                tool: "apply_patch",
                card: {
                  workspaceId: executionWorkspaceId,
                  path: displayPath,
                  summary: {
                    files: applied.files.length,
                    additions: applied.additions,
                    removals: applied.removals,
                  },
                  files: applied.files,
                  payload: { patch: applied.patch },
                },
              },
              structuredContent: {
                result,
                additions: applied.additions,
                removals: applied.removals,
                files: applied.files,
              },
            };
          },
        },
        activityRelationFor(executionContext),
        ).then((result) => presentSemanticWorkResult(result, target));
      },
    );
  }

}
