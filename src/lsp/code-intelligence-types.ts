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

export type CodeIntelligenceInput = CodeIntelligenceDefinitionInput | CodeIntelligenceHoverInput;

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

export type CodeIntelligenceResult = CodeIntelligenceDefinitionResult | CodeIntelligenceHoverResult;
