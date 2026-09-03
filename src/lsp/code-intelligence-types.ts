export interface CodeIntelligenceDefinitionInput {
  operation: "definition";
  path: string;
  line: number;
  column: number;
}

export interface CodeIntelligenceHoverInput {
  operation: "hover";
  path: string;
  line: number;
  column: number;
}

export const DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT = 100;
export const MAX_CODE_INTELLIGENCE_RESULT_LIMIT = 1000;

export interface CodeIntelligenceReferencesInput {
  operation: "references";
  path: string;
  line: number;
  column: number;
  limit?: number;
}

export interface CodeIntelligenceDocumentSymbolsInput {
  operation: "documentSymbols";
  path: string;
  limit?: number;
}

export interface CodeIntelligenceWorkspaceSymbolsInput {
  operation: "workspaceSymbols";
  path: string;
  query: string;
  limit?: number;
}

export interface CodeIntelligenceDiagnosticsInput {
  operation: "diagnostics";
  path: string;
  limit?: number;
}

export type ManagedLanguageServerId = "typescript" | "pyright";

export interface CodeIntelligenceManagedStatusInput {
  operation: "managed.status";
}

export interface CodeIntelligenceManagedInstallInput {
  operation: "managed.install";
  servers: ManagedLanguageServerId[];
}

export type CodeIntelligenceInput =
  | CodeIntelligenceDefinitionInput
  | CodeIntelligenceHoverInput
  | CodeIntelligenceReferencesInput
  | CodeIntelligenceDocumentSymbolsInput
  | CodeIntelligenceWorkspaceSymbolsInput
  | CodeIntelligenceDiagnosticsInput;

export type CodeIntelligenceCapabilityInput =
  | CodeIntelligenceInput
  | CodeIntelligenceManagedStatusInput
  | CodeIntelligenceManagedInstallInput;

export interface CodeIntelligencePosition {
  line: number;
  column: number;
}

export interface CodeIntelligenceRange {
  start: CodeIntelligencePosition;
  end: CodeIntelligencePosition;
}

export interface CodeIntelligenceLocation {
  path: string;
  external: boolean;
  range: CodeIntelligenceRange;
}

export interface CodeIntelligenceDefinitionResult {
  operation: "definition";
  selectedServer: string;
  projectRoot: string;
  locations: CodeIntelligenceLocation[];
}

export interface CodeIntelligenceHoverResult {
  operation: "hover";
  selectedServer: string;
  projectRoot: string;
  contents: string | null;
  language?: string;
  range?: CodeIntelligenceRange;
}

export interface CodeIntelligenceReferencesResult {
  operation: "references";
  selectedServer: string;
  projectRoot: string;
  locations: CodeIntelligenceLocation[];
  returned: number;
  truncated: boolean;
  total?: number;
}

export interface CodeIntelligenceDocumentSymbol {
  name: string;
  kind: string;
  detail?: string;
  containerName?: string;
  range: CodeIntelligenceRange;
  selectionRange?: CodeIntelligenceRange;
  children?: CodeIntelligenceDocumentSymbol[];
}

export interface CodeIntelligenceDocumentSymbolsResult {
  operation: "documentSymbols";
  selectedServer: string;
  projectRoot: string;
  hierarchical: boolean;
  symbols: CodeIntelligenceDocumentSymbol[];
  returned: number;
  truncated: boolean;
  total?: number;
}

export interface CodeIntelligenceWorkspaceSymbol {
  name: string;
  kind: string;
  containerName?: string;
  location: CodeIntelligenceLocation;
}

export interface CodeIntelligenceWorkspaceSymbolsResult {
  operation: "workspaceSymbols";
  selectedServer: string;
  projectRoot: string;
  symbols: CodeIntelligenceWorkspaceSymbol[];
  returned: number;
  truncated: boolean;
  total?: number;
}

export interface CodeIntelligenceDiagnostic {
  range: CodeIntelligenceRange;
  severity?: string;
  code?: string | number;
  source?: string;
  message: string;
  tags?: string[];
}

export interface CodeIntelligenceDiagnosticFreshness {
  state: "fresh" | "stale" | "missing" | "unknown";
  documentVersion: number;
  snapshotDocumentVersion?: number;
  publishedVersion?: number;
}

export interface CodeIntelligenceDiagnosticsResult {
  operation: "diagnostics";
  selectedServer: string;
  projectRoot: string;
  path: string;
  provider: "push" | "pull";
  diagnostics: CodeIntelligenceDiagnostic[];
  returned: number;
  truncated: boolean;
  total?: number;
  freshness: CodeIntelligenceDiagnosticFreshness;
}

export type CodeIntelligenceResult =
  | CodeIntelligenceDefinitionResult
  | CodeIntelligenceHoverResult
  | CodeIntelligenceReferencesResult
  | CodeIntelligenceDocumentSymbolsResult
  | CodeIntelligenceWorkspaceSymbolsResult
  | CodeIntelligenceDiagnosticsResult;
