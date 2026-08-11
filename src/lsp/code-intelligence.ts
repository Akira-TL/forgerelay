import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  DocumentSymbolRequest,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  ReferencesRequest,
  InitializedNotification,
  MarkupKind,
  PositionEncodingKind,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  WorkspaceSymbolRequest,
  type Hover,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver-protocol";
import {
  LanguageServerConfigurationError,
  type ResolvedLanguageProject,
} from "./language-server-config.js";
import { terminateProcessTree } from "../process-platform.js";
import { CodeIntelligenceError } from "./code-intelligence-error.js";
import { DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT } from "./code-intelligence-types.js";
import type {
  CodeIntelligenceDefinitionInput,
  CodeIntelligenceDefinitionResult,
  CodeIntelligenceDiagnosticsInput,
  CodeIntelligenceDiagnosticsResult,
  CodeIntelligenceDocumentSymbolsInput,
  CodeIntelligenceDocumentSymbolsResult,
  CodeIntelligenceHoverInput,
  CodeIntelligenceHoverResult,
  CodeIntelligenceReferencesInput,
  CodeIntelligenceReferencesResult,
  CodeIntelligenceWorkspaceSymbolsInput,
  CodeIntelligenceWorkspaceSymbolsResult,
} from "./code-intelligence-types.js";
import { normalizeHoverContents } from "./normalization/hover.js";
import {
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
} from "./normalization/symbols.js";
import {
  isWithin,
  locationEntries,
  normalizeLocations,
  workspaceDisplayPath,
} from "./normalization/locations.js";
import { lspPositionFromUser, rangeFromLsp } from "./position-encoding.js";
import { DiagnosticSnapshotStore } from "./runtime/diagnostic-snapshots.js";
import { DocumentSynchronizer, type OpenDocument } from "./runtime/document-synchronizer.js";
import { SemanticRequestCoordinator } from "./runtime/semantic-requests.js";

export { CodeIntelligenceError } from "./code-intelligence-error.js";
export type * from "./code-intelligence-types.js";

const STDERR_TAIL_BYTES = 64 * 1024;

export interface CodeIntelligenceRuntimePolicy {
  idleMs: number;
  cleanupIntervalMs: number;
  maxServices: number;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxConcurrentSemanticRequests: number;
  maxQueuedSemanticRequests: number;
  maxDiagnosticDocuments: number;
  maxDiagnosticsPerDocument: number;
}

export class LanguageService {
  readonly key: string;
  lastUsedAt = Date.now();
  inFlight = 0;

  private child?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private initializePromise?: Promise<InitializeResult>;
  private positionEncoding: string = PositionEncodingKind.UTF16;
  private capabilities?: InitializeResult["capabilities"];
  private readonly documents: DocumentSynchronizer;
  private readonly diagnosticSnapshots: DiagnosticSnapshotStore;
  private readonly semanticRequests: SemanticRequestCoordinator;
  private stderrTail = Buffer.alloc(0);
  private closed = false;

  constructor(
    readonly workspaceRoot: string,
    readonly project: ResolvedLanguageProject,
    private readonly policy: CodeIntelligenceRuntimePolicy,
  ) {
    this.key = languageServiceKey(project);
    this.documents = new DocumentSynchronizer(project.definition);
    this.diagnosticSnapshots = new DiagnosticSnapshotStore(
      policy.maxDiagnosticDocuments,
      policy.maxDiagnosticsPerDocument,
    );
    this.semanticRequests = new SemanticRequestCoordinator({
      maxConcurrent: policy.maxConcurrentSemanticRequests,
      maxQueued: policy.maxQueuedSemanticRequests,
      deadlineMs: policy.requestTimeoutMs,
    });
  }

  acquire(): void {
    this.inFlight += 1;
    this.lastUsedAt = Date.now();
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastUsedAt = Date.now();
  }

  async definition(
    input: CodeIntelligenceDefinitionInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceDefinitionResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.definitionProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise definition support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocumentOrdered(sourcePath);
      const position = lspPositionFromUser(document.text, input.line, input.column, this.positionEncoding);
      const response = await this.semanticRequests.run(
        `Definition request for ${input.path}`,
        signal,
        (token) => this.connection!.sendRequest(DefinitionRequest.type, {
          textDocument: { uri: document.uri },
          position,
        }, token),
      );
      const locations = await normalizeLocations(
        locationEntries(response),
        this.workspaceRoot,
        this.positionEncoding,
      );
      return {
        operation: "definition",
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
        locations,
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      if (error instanceof LanguageServerConfigurationError) {
        throw new CodeIntelligenceError(error.code, error.message);
      }
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async hover(
    input: CodeIntelligenceHoverInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceHoverResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.hoverProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise hover support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocumentOrdered(sourcePath);
      const position = lspPositionFromUser(document.text, input.line, input.column, this.positionEncoding);
      const response: Hover | null = await this.semanticRequests.run(
        `Hover request for ${input.path}`,
        signal,
        (token) => this.connection!.sendRequest(HoverRequest.type, {
          textDocument: { uri: document.uri },
          position,
        }, token),
      );
      const common = {
        operation: "hover" as const,
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
      };
      if (!response) return { ...common, contents: null };
      const normalized = normalizeHoverContents(response.contents);
      return {
        ...common,
        ...normalized,
        ...(response.range
          ? { range: rangeFromLsp(document.text, response.range, this.positionEncoding) }
          : {}),
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      if (error instanceof LanguageServerConfigurationError) {
        throw new CodeIntelligenceError(error.code, error.message);
      }
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async references(
    input: CodeIntelligenceReferencesInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceReferencesResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.referencesProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise references support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocumentOrdered(sourcePath);
      const position = lspPositionFromUser(document.text, input.line, input.column, this.positionEncoding);
      const response = await this.semanticRequests.run(
        `References request for ${input.path}`,
        signal,
        (token) => this.connection!.sendRequest(ReferencesRequest.type, {
          textDocument: { uri: document.uri },
          position,
          context: { includeDeclaration: true },
        }, token),
      );
      const entries = locationEntries(response ?? []);
      const limit = input.limit ?? DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT;
      const selected = entries.slice(0, limit);
      const locations = await normalizeLocations(selected, this.workspaceRoot, this.positionEncoding);
      return {
        operation: "references",
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
        locations,
        returned: locations.length,
        truncated: entries.length > locations.length,
        total: entries.length,
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      if (error instanceof LanguageServerConfigurationError) {
        throw new CodeIntelligenceError(error.code, error.message);
      }
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async documentSymbols(
    input: CodeIntelligenceDocumentSymbolsInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceDocumentSymbolsResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.documentSymbolProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise document-symbol support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocumentOrdered(sourcePath);
      const response = await this.semanticRequests.run(
        `Document-symbol request for ${input.path}`,
        signal,
        (token) => this.connection!.sendRequest(DocumentSymbolRequest.type, {
          textDocument: { uri: document.uri },
        }, token),
      );
      const normalized = normalizeDocumentSymbols(
        response,
        document.text,
        this.positionEncoding,
        input.limit ?? DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT,
      );
      return {
        operation: "documentSymbols",
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
        ...normalized,
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async workspaceSymbols(
    input: CodeIntelligenceWorkspaceSymbolsInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceWorkspaceSymbolsResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.workspaceSymbolProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise workspace-symbol support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      await this.syncDocumentOrdered(sourcePath);
      const response = await this.semanticRequests.run(
        `Workspace-symbol request for ${JSON.stringify(input.query)}`,
        signal,
        (token) => this.connection!.sendRequest(
          WorkspaceSymbolRequest.type,
          { query: input.query },
          token,
        ),
      );
      const normalized = await normalizeWorkspaceSymbols(
        response,
        this.workspaceRoot,
        this.positionEncoding,
        input.limit ?? DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT,
      );
      return {
        operation: "workspaceSymbols",
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
        ...normalized,
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async diagnostics(
    input: CodeIntelligenceDiagnosticsInput,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceDiagnosticsResult> {
    try {
      await this.ensureStarted();
      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocumentOrdered(sourcePath);
      const limit = input.limit ?? DEFAULT_CODE_INTELLIGENCE_RESULT_LIMIT;
      const common = {
        operation: "diagnostics" as const,
        selectedServer: this.project.definition.id,
        projectRoot: workspaceDisplayPath(this.workspaceRoot, this.project.projectRoot),
        path: workspaceDisplayPath(this.workspaceRoot, sourcePath),
      };
      const diagnosticProvider = this.capabilities?.diagnosticProvider;
      if (diagnosticProvider) {
        const previousResultId = this.diagnosticSnapshots.previousPullResultId(document.uri);
        const response = await this.semanticRequests.run(
          `Diagnostic request for ${input.path}`,
          signal,
          (token) => this.connection!.sendRequest(DocumentDiagnosticRequest.type, {
            textDocument: { uri: document.uri },
            ...(diagnosticProvider.identifier === undefined ? {} : { identifier: diagnosticProvider.identifier }),
            ...(previousResultId === undefined ? {} : { previousResultId }),
          }, token),
        );
        if (response.kind === DocumentDiagnosticReportKind.Full) {
          this.diagnosticSnapshots.capturePull(
            response.items,
            document,
            this.positionEncoding,
            response.resultId,
          );
        } else if (!this.diagnosticSnapshots.markPullUnchanged(document, response.resultId)) {
          throw new CodeIntelligenceError(
            "code.result_outside_policy",
            `Language server ${this.project.definition.id} returned unchanged diagnostics without a previous full report.`,
          );
        }
        return {
          ...common,
          provider: "pull",
          ...this.diagnosticSnapshots.readPull(document, limit),
        };
      }

      const snapshot = this.diagnosticSnapshots.readPush(document, limit);
      if (snapshot.freshness.state === "missing" && !this.diagnosticSnapshots.hasObservedPushDiagnostics()) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not provide pull diagnostics and has not published push diagnostics.`,
        );
      }
      return {
        ...common,
        provider: "push",
        ...snapshot,
      };
    } catch (error) {
      if (error instanceof CodeIntelligenceError) throw error;
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language server ${this.project.definition.id} failed: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    const child = this.child;

    if (connection) {
      await this.documents.closeAll(connection);
      try {
        await withTimeout(
          connection.sendRequest(ShutdownRequest.type),
          this.policy.shutdownTimeoutMs,
          () => new Error("Language-server shutdown timed out."),
        );
        await connection.sendNotification(ExitNotification.type);
        if (child) {
          await waitForChildExit(child, this.policy.shutdownTimeoutMs);
        }
      } catch {
        // Fall through to process-tree termination below.
      }
      connection.dispose();
    }

    this.documents.clear();
    this.diagnosticSnapshots.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    }
    this.child = undefined;
    this.connection = undefined;
    this.initializePromise = undefined;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) {
      throw new CodeIntelligenceError(
        "code.server_crashed",
        `Language service ${this.project.definition.id} is already closed.`,
      );
    }
    if (!this.initializePromise) this.initializePromise = this.start();
    try {
      const result = await this.initializePromise;
      this.capabilities = result.capabilities;
      this.positionEncoding = result.capabilities.positionEncoding ?? PositionEncodingKind.UTF16;
    } catch (error) {
      this.initializePromise = undefined;
      this.cleanupFailedStart();
      if (error instanceof CodeIntelligenceError) throw error;
      throw new CodeIntelligenceError(
        "code.language_service_start_failed",
        `Unable to initialize Language server ${this.project.definition.id}: ${errorMessage(error)}${this.stderrSuffix()}`,
      );
    }
  }

  private async start(): Promise<InitializeResult> {
    const definition = this.project.definition;
    const detached = process.platform !== "win32";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(definition.command, definition.args, {
        cwd: this.project.projectRoot,
        env: { ...process.env, ...definition.env },
        stdio: "pipe",
        windowsHide: true,
        detached,
        shell: false,
      });
    } catch (error) {
      throw new CodeIntelligenceError(
        "code.language_service_start_failed",
        `Unable to start Language server ${definition.id}: ${errorMessage(error)}.`,
      );
    }
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    await waitForChildSpawn(child, definition.id);

    const connection = createMessageConnection(child.stdout, child.stdin);
    this.connection = connection;
    this.registerClientHandlers(connection);
    connection.listen();

    let onExitDuringInitialization: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      onExitDuringInitialization = (code, signal) => reject(new CodeIntelligenceError(
        "code.language_service_start_failed",
        `Language server ${definition.id} exited during initialization (${signal ?? code ?? "unknown"}).${this.stderrSuffix()}`,
      ));
      child.once("exit", onExitDuringInitialization);
    });
    child.on("exit", () => {
      if (this.closed || this.child !== child) return;
      try {
        connection.dispose();
      } catch {
        // Pending semantic requests will surface the unexpected process exit.
      }
    });

    const rootUri = pathToFileURL(this.project.projectRoot).href;
    const initializeParams: InitializeParams = {
      processId: process.pid,
      clientInfo: { name: "forgerelay" },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.project.projectRoot) }],
      capabilities: {
        general: {
          positionEncodings: [
            PositionEncodingKind.UTF8,
            PositionEncodingKind.UTF16,
            PositionEncodingKind.UTF32,
          ],
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          symbol: {
            dynamicRegistration: false,
          },
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: false,
          },
          definition: {
            dynamicRegistration: false,
            linkSupport: true,
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText],
          },
          references: {
            dynamicRegistration: false,
          },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
          },
          diagnostic: {
            dynamicRegistration: false,
            relatedDocumentSupport: false,
          },
        },
      },
    };

    const initialize = connection.sendRequest(InitializeRequest.type, initializeParams);
    try {
      const result = await withTimeout(
        Promise.race([initialize, startupFailure]),
        this.policy.startTimeoutMs,
        () => new CodeIntelligenceError(
          "code.language_service_start_timeout",
          `Language server ${definition.id} did not initialize within ${this.policy.startTimeoutMs}ms.`,
        ),
      );
      await connection.sendNotification(InitializedNotification.type, {});
      return result;
    } finally {
      if (onExitDuringInitialization) child.off("exit", onExitDuringInitialization);
    }
  }

  private cleanupFailedStart(): void {
    this.connection?.dispose();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
    }
    this.connection = undefined;
    this.child = undefined;
    this.documents.clear();
    this.diagnosticSnapshots.clear();
  }

  private registerClientHandlers(connection: MessageConnection): void {
    connection.onRequest("workspace/configuration", (params: { items?: unknown[] } | undefined) =>
      Array.isArray(params?.items) ? params.items.map(() => null) : []
    );
    connection.onRequest("workspace/workspaceFolders", () => [{
      uri: pathToFileURL(this.project.projectRoot).href,
      name: basename(this.project.projectRoot),
    }]);
    connection.onRequest("window/showMessageRequest", () => null);
    connection.onNotification("window/logMessage", () => undefined);
    connection.onNotification("window/showMessage", () => undefined);
    connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
      this.diagnosticSnapshots.capturePush(
        params,
        this.documents.get(params.uri),
        this.positionEncoding,
      );
    });
  }

  private async syncDocumentOrdered(sourcePath: string): Promise<OpenDocument> {
    return this.documents.sync(
      sourcePath,
      this.connection!,
      this.capabilities?.textDocumentSync,
      this.positionEncoding,
    );
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrTail = Buffer.concat([this.stderrTail, chunk]);
    if (this.stderrTail.length > STDERR_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - STDERR_TAIL_BYTES);
    }
  }

  private stderrSuffix(): string {
    const text = this.stderrTail.toString("utf8").trim();
    return text ? ` Server stderr: ${text}` : "";
  }
}

export function languageServiceKey(project: ResolvedLanguageProject): string {
  return JSON.stringify([
    resolve(project.projectRoot),
    project.definition.id,
    project.definition.fingerprint,
  ]);
}

async function workspaceSourcePath(workspaceRoot: string, inputPath: string): Promise<string> {
  const root = resolve(workspaceRoot);
  const path = resolve(root, inputPath);
  if (!isWithin(root, path)) {
    throw new CodeIntelligenceError(
      "code.language_service_unavailable",
      `Code-intelligence source path must remain inside the Workspace: ${inputPath}`,
    );
  }
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new CodeIntelligenceError(
        "code.language_service_unavailable",
        `Code-intelligence source path resolves outside the Workspace: ${inputPath}`,
      );
    }
    await readFile(canonicalPath, "utf8");
    return canonicalPath;
  } catch (error) {
    if (error instanceof CodeIntelligenceError) throw error;
    throw new CodeIntelligenceError(
      "code.language_service_unavailable",
      `Unable to read code-intelligence source ${inputPath}: ${errorMessage(error)}`,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForChildSpawn(child: ChildProcessWithoutNullStreams, serverId: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectPromise(new CodeIntelligenceError(
        "code.language_service_start_failed",
        `Unable to start Language server ${serverId}: ${error.message}.`,
      ));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolvePromise) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      child.off("exit", onExit);
      if (timer) clearTimeout(timer);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
