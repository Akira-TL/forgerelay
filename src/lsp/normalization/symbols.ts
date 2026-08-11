import {
  SymbolKind,
  type DocumentSymbol,
  type SymbolInformation,
} from "vscode-languageserver-protocol";
import type { CodeIntelligenceDocumentSymbol } from "../code-intelligence-types.js";
import { rangeFromLsp } from "../position-encoding.js";

export interface NormalizedDocumentSymbols {
  hierarchical: boolean;
  symbols: CodeIntelligenceDocumentSymbol[];
  returned: number;
  truncated: boolean;
  total: number;
}

export function normalizeDocumentSymbols(
  response: DocumentSymbol[] | SymbolInformation[] | null,
  text: string,
  encoding: string,
  limit: number,
): NormalizedDocumentSymbols {
  if (!response || response.length === 0) {
    return { hierarchical: true, symbols: [], returned: 0, truncated: false, total: 0 };
  }

  if (isFlatSymbolInformation(response[0]!)) {
    const flat = response as SymbolInformation[];
    const selected = flat.slice(0, limit).map((symbol) => ({
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
      range: rangeFromLsp(text, symbol.location.range, encoding),
    }));
    return {
      hierarchical: false,
      symbols: selected,
      returned: selected.length,
      truncated: flat.length > selected.length,
      total: flat.length,
    };
  }

  const hierarchical = response as DocumentSymbol[];
  const total = countDocumentSymbols(hierarchical);
  const budget = { remaining: limit, returned: 0 };
  const symbols = takeDocumentSymbols(hierarchical, text, encoding, budget);
  return {
    hierarchical: true,
    symbols,
    returned: budget.returned,
    truncated: total > budget.returned,
    total,
  };
}

function takeDocumentSymbols(
  symbols: DocumentSymbol[],
  text: string,
  encoding: string,
  budget: { remaining: number; returned: number },
): CodeIntelligenceDocumentSymbol[] {
  const normalized: CodeIntelligenceDocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    budget.returned += 1;
    const children = symbol.children?.length
      ? takeDocumentSymbols(symbol.children, text, encoding, budget)
      : [];
    normalized.push({
      name: symbol.name,
      kind: symbolKindName(symbol.kind),
      ...(symbol.detail ? { detail: symbol.detail } : {}),
      range: rangeFromLsp(text, symbol.range, encoding),
      selectionRange: rangeFromLsp(text, symbol.selectionRange, encoding),
      ...(children.length ? { children } : {}),
    });
  }
  return normalized;
}

function countDocumentSymbols(symbols: DocumentSymbol[]): number {
  return symbols.reduce(
    (total, symbol) => total + 1 + (symbol.children ? countDocumentSymbols(symbol.children) : 0),
    0,
  );
}

function isFlatSymbolInformation(symbol: DocumentSymbol | SymbolInformation): symbol is SymbolInformation {
  return "location" in symbol;
}

export function symbolKindName(kind: number): string {
  const entry = Object.entries(SymbolKind).find(([, value]) => value === kind);
  return entry ? entry[0].toLowerCase() : `unknown:${kind}`;
}
