import type { Diagnostic } from "vscode-languageserver-protocol";
import type { CodeIntelligenceDiagnostic } from "../code-intelligence-types.js";
import { rangeFromLsp } from "../position-encoding.js";

export function normalizeDiagnostic(
  diagnostic: Diagnostic,
  documentText: string,
  encoding: string,
): CodeIntelligenceDiagnostic {
  return {
    range: rangeFromLsp(documentText, diagnostic.range, encoding),
    ...(diagnostic.severity === undefined ? {} : { severity: diagnosticSeverityName(diagnostic.severity) }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    message: typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value,
    ...(diagnostic.tags?.length
      ? { tags: diagnostic.tags.map(diagnosticTagName) }
      : {}),
  };
}

function diagnosticSeverityName(value: number): string {
  switch (value) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "information";
    case 4: return "hint";
    default: return `unknown:${value}`;
  }
}

function diagnosticTagName(value: number): string {
  switch (value) {
    case 1: return "unnecessary";
    case 2: return "deprecated";
    default: return `unknown:${value}`;
  }
}
