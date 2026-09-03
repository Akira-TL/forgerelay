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
  private readonly pushWaiters = new Map<string, Set<(observed: boolean) => void>>();
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
    if (!document) {
      this.notifyPushWaiters(params.uri, true);
      return;
    }
    const snapshot = this.normalizeSnapshot(
      params.diagnostics,
      document,
      encoding,
      params.version === undefined ? {} : { publishedVersion: params.version },
    );
    this.setBounded(this.pushSnapshots, params.uri, snapshot);
    this.notifyPushWaiters(params.uri, true);
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

  async waitForFreshPush(
    document: DiagnosticDocumentState,
    limit: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DiagnosticSnapshotReadResult> {
    let snapshot = this.readPush(document, limit);
    const deadline = Date.now() + timeoutMs;
    while (snapshot.freshness.state === "missing" || snapshot.freshness.state === "stale") {
      if (signal?.aborted) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !await this.waitForPush(document.uri, remaining, signal)) break;
      snapshot = this.readPush(document, limit);
    }
    return snapshot;
  }

  hasObservedPushDiagnostics(): boolean {
    return this.pushObserved;
  }

  private waitForPush(uri: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const waiters = this.pushWaiters.get(uri) ?? new Set<(observed: boolean) => void>();
      const finish = (observed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(finish);
        if (waiters.size === 0) this.pushWaiters.delete(uri);
        resolve(observed);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.add(finish);
      this.pushWaiters.set(uri, waiters);
    });
  }

  clear(): void {
    this.pushSnapshots.clear();
    this.pullSnapshots.clear();
    for (const uri of [...this.pushWaiters.keys()]) this.notifyPushWaiters(uri, false);
    this.pushObserved = false;
  }

  get size(): number {
    return this.pushSnapshots.size + this.pullSnapshots.size;
  }

  get retainedDiagnostics(): number {
    let total = 0;
    for (const snapshot of this.pushSnapshots.values()) total += snapshot.diagnostics.length;
    for (const snapshot of this.pullSnapshots.values()) total += snapshot.diagnostics.length;
    return total;
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

  private notifyPushWaiters(uri: string, observed: boolean): void {
    const waiters = this.pushWaiters.get(uri);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter(observed);
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
