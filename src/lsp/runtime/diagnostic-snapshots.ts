import type { Diagnostic, PublishDiagnosticsParams } from "vscode-languageserver-protocol";
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
  resultId?: string;
}

export interface DiagnosticSnapshotReadResult {
  diagnostics: CodeIntelligenceDiagnostic[];
  returned: number;
  truncated: boolean;
  total?: number;
  freshness: CodeIntelligenceDiagnosticFreshness;
}

export class DiagnosticSnapshotStore {
  private readonly pushSnapshots = new Map<string, DiagnosticSnapshot>();
  private readonly pullSnapshots = new Map<string, DiagnosticSnapshot>();
  private pushObserved = false;

  constructor(
    private readonly maxDocuments: number,
    private readonly maxDiagnosticsPerDocument: number,
  ) {}

  capturePush(
    params: PublishDiagnosticsParams,
    document: DiagnosticDocumentState | undefined,
    encoding: string,
  ): void {
    this.pushObserved = true;
    if (!document) return;
    const snapshot = this.normalizeSnapshot(
      params.diagnostics,
      document,
      encoding,
      params.version === undefined ? {} : { publishedVersion: params.version },
    );
    this.setBounded(this.pushSnapshots, params.uri, snapshot);
  }

  capturePull(
    diagnostics: Diagnostic[],
    document: DiagnosticDocumentState,
    encoding: string,
    resultId?: string,
  ): void {
    const snapshot = this.normalizeSnapshot(
      diagnostics,
      document,
      encoding,
      resultId === undefined ? {} : { resultId },
    );
    this.setBounded(this.pullSnapshots, document.uri, snapshot);
  }

  markPullUnchanged(document: DiagnosticDocumentState, resultId: string): boolean {
    const previous = this.pullSnapshots.get(document.uri);
    if (!previous) return false;
    const snapshot: DiagnosticSnapshot = {
      ...previous,
      snapshotDocumentVersion: document.version,
      resultId,
    };
    this.setBounded(this.pullSnapshots, document.uri, snapshot);
    return true;
  }

  previousPullResultId(uri: string): string | undefined {
    return this.pullSnapshots.get(uri)?.resultId;
  }

  readPush(document: DiagnosticDocumentState, limit: number): DiagnosticSnapshotReadResult {
    return this.read(this.pushSnapshots, document, limit, true);
  }

  readPull(document: DiagnosticDocumentState, limit: number): DiagnosticSnapshotReadResult {
    return this.read(this.pullSnapshots, document, limit, false);
  }

  hasObservedPushDiagnostics(): boolean {
    return this.pushObserved;
  }

  clear(): void {
    this.pushSnapshots.clear();
    this.pullSnapshots.clear();
    this.pushObserved = false;
  }

  get size(): number {
    return this.pushSnapshots.size + this.pullSnapshots.size;
  }

  private normalizeSnapshot(
    diagnostics: Diagnostic[],
    document: DiagnosticDocumentState,
    encoding: string,
    metadata: Pick<DiagnosticSnapshot, "publishedVersion" | "resultId">,
  ): DiagnosticSnapshot {
    return {
      diagnostics: diagnostics
        .slice(0, this.maxDiagnosticsPerDocument)
        .map((diagnostic) => normalizeDiagnostic(diagnostic, document.text, encoding)),
      total: diagnostics.length,
      snapshotDocumentVersion: document.version,
      ...metadata,
    };
  }

  private setBounded(
    snapshots: Map<string, DiagnosticSnapshot>,
    uri: string,
    snapshot: DiagnosticSnapshot,
  ): void {
    snapshots.delete(uri);
    snapshots.set(uri, snapshot);
    while (snapshots.size > this.maxDocuments) {
      const oldestUri = snapshots.keys().next().value as string | undefined;
      if (!oldestUri) break;
      snapshots.delete(oldestUri);
    }
  }

  private read(
    snapshots: Map<string, DiagnosticSnapshot>,
    document: DiagnosticDocumentState,
    limit: number,
    usePublishedVersion: boolean,
  ): DiagnosticSnapshotReadResult {
    const snapshot = snapshots.get(document.uri);
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
    const freshness = usePublishedVersion && snapshot.publishedVersion !== undefined
      ? (snapshot.publishedVersion === document.version ? "fresh" : "stale")
      : (snapshot.snapshotDocumentVersion === document.version ? "fresh" : "stale");
    return {
      diagnostics,
      returned: diagnostics.length,
      truncated: snapshot.total > diagnostics.length,
      total: snapshot.total,
      freshness: {
        state: freshness,
        documentVersion: document.version,
        snapshotDocumentVersion: snapshot.snapshotDocumentVersion,
        ...(snapshot.publishedVersion === undefined ? {} : { publishedVersion: snapshot.publishedVersion }),
      },
    };
  }
}
