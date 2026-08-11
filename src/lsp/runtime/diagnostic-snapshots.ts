import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import type {
  CodeIntelligenceDiagnostic,
  CodeIntelligenceDiagnosticFreshness,
} from "../code-intelligence-types.js";
import { normalizeDiagnostic } from "../normalization/diagnostics.js";

export interface DiagnosticDocumentState {
  uri: string;
  version: number;
  text: string;
}

interface DiagnosticSnapshot {
  diagnostics: CodeIntelligenceDiagnostic[];
  total: number;
  snapshotDocumentVersion: number;
  publishedVersion?: number;
}

export interface DiagnosticSnapshotReadResult {
  diagnostics: CodeIntelligenceDiagnostic[];
  returned: number;
  truncated: boolean;
  total?: number;
  freshness: CodeIntelligenceDiagnosticFreshness;
}

export class DiagnosticSnapshotStore {
  private readonly snapshots = new Map<string, DiagnosticSnapshot>();

  constructor(
    private readonly maxDocuments: number,
    private readonly maxDiagnosticsPerDocument: number,
  ) {}

  capture(
    params: PublishDiagnosticsParams,
    document: DiagnosticDocumentState | undefined,
    encoding: string,
  ): void {
    if (!document) return;
    const diagnostics = params.diagnostics
      .slice(0, this.maxDiagnosticsPerDocument)
      .map((diagnostic) => normalizeDiagnostic(diagnostic, document.text, encoding));
    const snapshot: DiagnosticSnapshot = {
      diagnostics,
      total: params.diagnostics.length,
      snapshotDocumentVersion: document.version,
      ...(params.version === undefined ? {} : { publishedVersion: params.version }),
    };
    this.snapshots.delete(params.uri);
    this.snapshots.set(params.uri, snapshot);
    while (this.snapshots.size > this.maxDocuments) {
      const oldestUri = this.snapshots.keys().next().value as string | undefined;
      if (!oldestUri) break;
      this.snapshots.delete(oldestUri);
    }
  }

  read(document: DiagnosticDocumentState, limit: number): DiagnosticSnapshotReadResult {
    const snapshot = this.snapshots.get(document.uri);
    if (!snapshot) {
      return {
        diagnostics: [],
        returned: 0,
        truncated: false,
        freshness: {
          state: "missing",
          documentVersion: document.version,
        },
      };
    }
    const diagnostics = snapshot.diagnostics.slice(0, limit);
    return {
      diagnostics,
      returned: diagnostics.length,
      truncated: snapshot.total > diagnostics.length,
      total: snapshot.total,
      freshness: {
        state: freshnessState(snapshot, document),
        documentVersion: document.version,
        snapshotDocumentVersion: snapshot.snapshotDocumentVersion,
        ...(snapshot.publishedVersion === undefined ? {} : { publishedVersion: snapshot.publishedVersion }),
      },
    };
  }

  clear(): void {
    this.snapshots.clear();
  }

  get size(): number {
    return this.snapshots.size;
  }
}

function freshnessState(
  snapshot: DiagnosticSnapshot,
  document: DiagnosticDocumentState,
): "fresh" | "stale" {
  if (snapshot.publishedVersion !== undefined) {
    return snapshot.publishedVersion === document.version ? "fresh" : "stale";
  }
  return snapshot.snapshotDocumentVersion === document.version ? "fresh" : "stale";
}
