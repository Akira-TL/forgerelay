import { PositionEncodingKind, type Position, type Range } from "vscode-languageserver-protocol";
import { CodeIntelligenceError } from "./code-intelligence-error.js";
import type { CodeIntelligencePosition, CodeIntelligenceRange } from "./code-intelligence-types.js";

export function lspPositionFromUser(
  text: string,
  line: number,
  column: number,
  encoding: string,
): Position {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new CodeIntelligenceError(
      "code.invalid_position",
      `Code-intelligence positions are 1-based positive integers; received line=${line}, column=${column}.`,
    );
  }
  const lines = text.split(/\r?\n/);
  const sourceLine = lines[line - 1];
  if (sourceLine === undefined) {
    throw new CodeIntelligenceError(
      "code.invalid_position",
      `Line ${line} is outside the document (${lines.length} lines).`,
    );
  }
  const codePoints = Array.from(sourceLine);
  const codePointIndex = column - 1;
  if (codePointIndex > codePoints.length) {
    throw new CodeIntelligenceError(
      "code.invalid_position",
      `Column ${column} is outside line ${line} (${codePoints.length + 1} valid insertion positions).`,
    );
  }
  const prefix = codePoints.slice(0, codePointIndex).join("");
  return {
    line: line - 1,
    character: encodedLength(prefix, encoding),
  };
}

export function wholeDocumentRange(text: string, encoding: string): Range {
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return {
    start: { line: 0, character: 0 },
    end: {
      line: lastLine,
      character: encodedLength(lines[lastLine] ?? "", encoding),
    },
  };
}

export function rangeFromLsp(text: string, range: Range, encoding: string): CodeIntelligenceRange {
  return {
    start: positionFromLsp(text, range.start, encoding),
    end: positionFromLsp(text, range.end, encoding),
  };
}

function positionFromLsp(text: string, position: Position, encoding: string): CodeIntelligencePosition {
  const lines = text.split(/\r?\n/);
  const sourceLine = lines[position.line];
  if (sourceLine === undefined) {
    throw new CodeIntelligenceError(
      "code.invalid_position",
      `Language server returned line ${position.line} outside a ${lines.length}-line document.`,
    );
  }
  return {
    line: position.line + 1,
    column: decodedCodePointOffset(sourceLine, position.character, encoding) + 1,
  };
}

function encodedLength(text: string, encoding: string): number {
  if (encoding === PositionEncodingKind.UTF8) return Buffer.byteLength(text, "utf8");
  if (encoding === PositionEncodingKind.UTF32) return Array.from(text).length;
  return text.length;
}

function decodedCodePointOffset(text: string, encodedOffset: number, encoding: string): number {
  if (!Number.isInteger(encodedOffset) || encodedOffset < 0) {
    throw new CodeIntelligenceError("code.invalid_position", `Language server returned invalid character offset ${encodedOffset}.`);
  }
  if (encoding === PositionEncodingKind.UTF32) {
    if (encodedOffset > Array.from(text).length) {
      throw new CodeIntelligenceError("code.invalid_position", `Language server returned character offset ${encodedOffset} outside its line.`);
    }
    return encodedOffset;
  }
  if (encoding === PositionEncodingKind.UTF16) {
    if (encodedOffset > text.length) {
      throw new CodeIntelligenceError("code.invalid_position", `Language server returned character offset ${encodedOffset} outside its line.`);
    }
    return Array.from(text.slice(0, encodedOffset)).length;
  }

  let bytes = 0;
  let codePoints = 0;
  for (const character of text) {
    if (bytes === encodedOffset) return codePoints;
    bytes += Buffer.byteLength(character, "utf8");
    codePoints += 1;
    if (bytes > encodedOffset) {
      throw new CodeIntelligenceError("code.invalid_position", `Language server returned UTF-8 offset ${encodedOffset} inside a code point.`);
    }
  }
  if (bytes === encodedOffset) return codePoints;
  throw new CodeIntelligenceError("code.invalid_position", `Language server returned character offset ${encodedOffset} outside its line.`);
}
