import { CodeIntelligenceError } from "../../../../lsp/code-intelligence-error.js";
import type { CodeIntelligenceDiagnosticsResult } from "../../../../lsp/code-intelligence-types.js";
import type { CodeIntelligenceManager } from "../../../../lsp/runtime/manager.js";
import { textBlock, type ToolContent } from "../../core/tool-support.js";

const AUTO_DIAGNOSTIC_LIMIT = 20;

interface MutationToolResult {
  content: ToolContent[];
  structuredContent: { result: string; [key: string]: unknown };
  [key: string]: unknown;
}

export async function appendAutomaticMutationDiagnostics<T extends MutationToolResult>(
  result: T,
  codeIntelligence: CodeIntelligenceManager,
  workspaceRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<T> {
  const summary = await automaticMutationDiagnostics(codeIntelligence, workspaceRoot, paths, signal);
  if (!summary) return result;
  return {
    ...result,
    content: [...result.content, textBlock(summary)],
    structuredContent: {
      ...result.structuredContent,
      result: `${result.structuredContent.result}\n\n${summary}`,
    },
  };
}

export async function automaticMutationDiagnostics(
  codeIntelligence: CodeIntelligenceManager,
  workspaceRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const sections: string[] = [];
  for (const path of Array.from(new Set(paths))) {
    try {
      const result = await codeIntelligence.run(
        workspaceRoot,
        { operation: "diagnostics", path, limit: AUTO_DIAGNOSTIC_LIMIT },
        { signal },
      );
      if (result.operation !== "diagnostics" || result.diagnostics.length === 0) continue;
      sections.push(formatDiagnostics(result));
    } catch (error) {
      if (error instanceof CodeIntelligenceError) {
        if (error.code === "code.language_service_unavailable" || error.code === "code.operation_unsupported") continue;
        sections.push(`Automatic diagnostics warning for ${path}: ${error.message}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      sections.push(`Automatic diagnostics warning for ${path}: ${message}`);
    }
  }
  if (sections.length === 0) return undefined;
  return [
    "Automatic Language Server validation after this file change:",
    ...sections,
  ].join("\n");
}

function formatDiagnostics(result: CodeIntelligenceDiagnosticsResult): string {
  const lines = result.diagnostics.map((diagnostic) => {
    const location = `${result.path}:${diagnostic.range.start.line}:${diagnostic.range.start.column}`;
    const severity = diagnostic.severity ? `[${diagnostic.severity}] ` : "";
    const code = diagnostic.code === undefined ? "" : ` (${diagnostic.code})`;
    return `- ${location} ${severity}${diagnostic.message}${code}`;
  });
  if (result.truncated) lines.push(`- … more diagnostics were truncated (showing ${result.returned}${result.total === undefined ? "" : ` of ${result.total}`}).`);
  return [`${result.selectedServer} · ${result.path}`, ...lines].join("\n");
}
