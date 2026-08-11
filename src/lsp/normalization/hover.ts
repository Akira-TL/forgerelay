import type { Hover, MarkedString, MarkupContent } from "vscode-languageserver-protocol";

export interface NormalizedHoverContents {
  contents: string;
  language?: string;
}

export function normalizeHoverContents(contents: Hover["contents"]): NormalizedHoverContents {
  if (Array.isArray(contents)) {
    if (contents.length === 1) return normalizeMarkedString(contents[0]!);
    return {
      contents: contents.map(renderMarkedString).join("\n\n"),
    };
  }

  if (isMarkupContent(contents)) {
    return { contents: contents.value };
  }

  return normalizeMarkedString(contents);
}

function isMarkupContent(value: MarkupContent | MarkedString): value is MarkupContent {
  return typeof value === "object" && value !== null && "kind" in value;
}

function normalizeMarkedString(value: MarkedString): NormalizedHoverContents {
  if (typeof value === "string") return { contents: value };
  return {
    contents: value.value,
    language: value.language,
  };
}

function renderMarkedString(value: MarkedString): string {
  if (typeof value === "string") return value;
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}
