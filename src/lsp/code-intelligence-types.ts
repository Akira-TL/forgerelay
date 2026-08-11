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

export type CodeIntelligenceInput =
  | CodeIntelligenceDefinitionInput
  | CodeIntelligenceHoverInput
  | CodeIntelligenceReferencesInput;

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

export type CodeIntelligenceResult =
  | CodeIntelligenceDefinitionResult
  | CodeIntelligenceHoverResult
  | CodeIntelligenceReferencesResult;
