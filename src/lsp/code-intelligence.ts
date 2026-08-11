import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  MarkupKind,
  PositionEncodingKind,
  ShutdownRequest,
  TextDocumentSyncKind,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type TextDocumentSyncOptions,
  type Location,
  type LocationLink,
} from "vscode-languageserver-protocol";
import type { ServerConfig } from "../config.js";
import {
  LanguageServerConfigurationError,
  resolveLanguageProject,
  type ResolvedLanguageProject,
  type ResolvedLanguageServerDefinition,
} from "./language-server-config.js";
import { terminateProcessTree } from "../process-platform.js";
import { CodeIntelligenceError } from "./code-intelligence-error.js";
import type {
  CodeIntelligenceDefinitionInput,
  CodeIntelligenceDefinitionResult,
  CodeIntelligenceHoverInput,
  CodeIntelligenceHoverResult,
  CodeIntelligenceInput,
  CodeIntelligenceLocation,
  CodeIntelligenceResult,
} from "./code-intelligence-types.js";
import { normalizeHoverContents } from "./normalization/hover.js";
import { lspPositionFromUser, rangeFromLsp, wholeDocumentRange } from "./position-encoding.js";

export { CodeIntelligenceError } from "./code-intelligence-error.js";
export type * from "./code-intelligence-types.js";

const LANGUAGE_SERVICE_IDLE_MS = 10 * 60 * 1_000;
const LANGUAGE_SERVICE_CLEANUP_INTERVAL_MS = 60 * 1_000;
const MAX_LANGUAGE_SERVICES = 16;
const LANGUAGE_SERVICE_START_TIMEOUT_MS = 15_000;
const LANGUAGE_REQUEST_TIMEOUT_MS = 10_000;
const LANGUAGE_SERVICE_SHUTDOWN_TIMEOUT_MS = 2_000;
const STDERR_TAIL_BYTES = 64 * 1024;

export interface CodeIntelligenceManagerOptions {
  idleMs?: number;
  cleanupIntervalMs?: number;
  maxServices?: number;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface CodeIntelligenceRuntimePolicy {
  idleMs: number;
  cleanupIntervalMs: number;
  maxServices: number;
  startTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  openNotified: boolean;
}

class LanguageService {
  readonly key: string;
  lastUsedAt = Date.now();
  inFlight = 0;

  private child?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private initializePromise?: Promise<InitializeResult>;
  private positionEncoding: string = PositionEncodingKind.UTF16;
  private capabilities?: InitializeResult["capabilities"];
  private readonly documents = new Map<string, OpenDocument>();
  private stderrTail = Buffer.alloc(0);
  private closed = false;

  constructor(
    readonly workspaceRoot: string,
    readonly project: ResolvedLanguageProject,
    private readonly policy: CodeIntelligenceRuntimePolicy,
  ) {
    this.key = languageServiceKey(project);
  }

  acquire(): void {
    this.inFlight += 1;
    this.lastUsedAt = Date.now();
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.lastUsedAt = Date.now();
  }

  async definition(input: CodeIntelligenceDefinitionInput): Promise<CodeIntelligenceDefinitionResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.definitionProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise definition support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocument(sourcePath);
      const position = lspPositionFromUser(document.text, input.line, input.column, this.positionEncoding);
      const response = await withTimeout(
        this.connection!.sendRequest(DefinitionRequest.type, {
          textDocument: { uri: document.uri },
          position,
        }),
        this.policy.requestTimeoutMs,
        () => new CodeIntelligenceError(
          "code.request_timeout",
          `Definition request timed out for ${input.path}.`,
        ),
      );
      const locations = await normalizeDefinitionResponse(
        response,
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

  async hover(input: CodeIntelligenceHoverInput): Promise<CodeIntelligenceHoverResult> {
    try {
      await this.ensureStarted();
      if (!this.capabilities?.hoverProvider) {
        throw new CodeIntelligenceError(
          "code.operation_unsupported",
          `Language server ${this.project.definition.id} does not advertise hover support.`,
        );
      }

      const sourcePath = await workspaceSourcePath(this.workspaceRoot, input.path);
      const document = await this.syncDocument(sourcePath);
      const position = lspPositionFromUser(document.text, input.line, input.column, this.positionEncoding);
      const response: Hover | null = await withTimeout(
        this.connection!.sendRequest(HoverRequest.type, {
          textDocument: { uri: document.uri },
          position,
        }),
        this.policy.requestTimeoutMs,
        () => new CodeIntelligenceError(
          "code.request_timeout",
          `Hover request timed out for ${input.path}.`,
        ),
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

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    const child = this.child;

    if (connection) {
      for (const document of this.documents.values()) {
        if (!document.openNotified) continue;
        try {
          await connection.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri: document.uri },
          });
        } catch {
          // The server may already be gone.
        }
      }
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
  }

  private async syncDocument(sourcePath: string): Promise<OpenDocument> {
    const uri = pathToFileURL(sourcePath).href;
    const text = await readFile(sourcePath, "utf8");
    const existing = this.documents.get(uri);
    const languageId = languageIdForPath(this.project.definition, sourcePath);
    const synchronization = textDocumentSynchronization(this.capabilities?.textDocumentSync);
    if (!existing) {
      const document: OpenDocument = { uri, languageId, version: 1, text, openNotified: false };
      this.documents.set(uri, document);
      if (synchronization.openClose) {
        await this.connection!.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          },
        });
        document.openNotified = true;
      }
      return document;
    }
    if (existing.text !== text) {
      const previousText = existing.text;
      existing.version += 1;
      existing.text = text;
      if (synchronization.change === TextDocumentSyncKind.Full) {
        await this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text }],
        });
      } else if (synchronization.change === TextDocumentSyncKind.Incremental) {
        await this.connection!.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: existing.version },
          contentChanges: [{
            range: wholeDocumentRange(previousText, this.positionEncoding),
            text,
          }],
        });
      }
    }
    return existing;
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

export class CodeIntelligenceManager {
  private readonly services = new Map<string, LanguageService>();
  private readonly serviceCreations = new Map<string, Promise<LanguageService>>();
  private serviceCreationQueue: Promise<void> = Promise.resolve();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly policy: CodeIntelligenceRuntimePolicy;

  constructor(
    private readonly config: Pick<ServerConfig, "languageServers">,
    options: CodeIntelligenceManagerOptions = {},
  ) {
    this.policy = {
      idleMs: positiveInteger(options.idleMs, LANGUAGE_SERVICE_IDLE_MS, "idleMs"),
      cleanupIntervalMs: positiveInteger(options.cleanupIntervalMs, LANGUAGE_SERVICE_CLEANUP_INTERVAL_MS, "cleanupIntervalMs"),
      maxServices: positiveInteger(options.maxServices, MAX_LANGUAGE_SERVICES, "maxServices"),
      startTimeoutMs: positiveInteger(options.startTimeoutMs, LANGUAGE_SERVICE_START_TIMEOUT_MS, "startTimeoutMs"),
      requestTimeoutMs: positiveInteger(options.requestTimeoutMs, LANGUAGE_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
      shutdownTimeoutMs: positiveInteger(options.shutdownTimeoutMs, LANGUAGE_SERVICE_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs"),
    };
    this.cleanupTimer = setInterval(() => {
      void this.closeIdle();
    }, this.policy.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async run(
    workspaceRoot: string,
    input: CodeIntelligenceInput,
  ): Promise<CodeIntelligenceResult> {
    let project: ResolvedLanguageProject;
    let canonicalWorkspaceRoot: string;
    try {
      canonicalWorkspaceRoot = await realpath(resolve(workspaceRoot));
      project = await resolveLanguageProject({
        workspaceRoot: canonicalWorkspaceRoot,
        sourcePath: input.path,
        globalConfig: this.config.languageServers,
      });
    } catch (error) {
      if (error instanceof LanguageServerConfigurationError) {
        throw new CodeIntelligenceError(error.code, error.message);
      }
      throw error;
    }

    const service = await this.acquireService(canonicalWorkspaceRoot, project);
    try {
      return input.operation === "definition"
        ? await service.definition(input)
        : await service.hover(input);
    } finally {
      service.release();
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled(this.serviceCreations.values());
    this.serviceCreations.clear();
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.allSettled(services.map((service) => service.shutdown()));
  }

  get size(): number {
    return this.services.size;
  }

  private async acquireService(
    workspaceRoot: string,
    project: ResolvedLanguageProject,
  ): Promise<LanguageService> {
    const key = languageServiceKey(project);
    const existing = this.services.get(key);
    if (existing) {
      existing.acquire();
      return existing;
    }

    const pending = this.serviceCreations.get(key);
    if (pending) {
      const service = await pending;
      service.acquire();
      return service;
    }

    const creation = this.withServiceCreationLock(async () => {
      const current = this.services.get(key);
      if (current) {
        current.acquire();
        return current;
      }
      await this.ensureCapacity();
      const service = new LanguageService(workspaceRoot, project, this.policy);
      service.acquire();
      this.services.set(key, service);
      return service;
    });
    this.serviceCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.serviceCreations.get(key) === creation) {
        this.serviceCreations.delete(key);
      }
    }
  }

  private async withServiceCreationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serviceCreationQueue;
    let release = (): void => undefined;
    this.serviceCreationQueue = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async closeIdle(now = Date.now()): Promise<void> {
    const stale = [...this.services.entries()].filter(([, service]) =>
      service.inFlight === 0 && now - service.lastUsedAt >= this.policy.idleMs
    );
    for (const [key, service] of stale) {
      this.services.delete(key);
      await service.shutdown();
    }
  }

  private async ensureCapacity(): Promise<void> {
    if (this.services.size < this.policy.maxServices) return;
    const idle = [...this.services.entries()]
      .filter(([, service]) => service.inFlight === 0)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    const candidate = idle[0];
    if (!candidate) {
      throw new CodeIntelligenceError(
        "code.language_service_capacity",
        `Language service capacity reached (${this.policy.maxServices}) with no idle service available for eviction.`,
      );
    }
    this.services.delete(candidate[0]);
    await candidate[1].shutdown();
  }
}

function languageServiceKey(project: ResolvedLanguageProject): string {
  return JSON.stringify([
    resolve(project.projectRoot),
    project.definition.id,
    project.definition.fingerprint,
  ]);
}

function languageIdForPath(definition: ResolvedLanguageServerDefinition, path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return definition.languageIdByExtension[extension] ?? definition.languages[0]!;
}

function textDocumentSynchronization(
  value: TextDocumentSyncOptions | TextDocumentSyncKind | undefined,
): { openClose: boolean; change: TextDocumentSyncKind } {
  if (typeof value === "number") {
    return {
      openClose: value !== TextDocumentSyncKind.None,
      change: value,
    };
  }
  return {
    openClose: value?.openClose === true,
    change: value?.change ?? TextDocumentSyncKind.None,
  };
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

async function normalizeDefinitionResponse(
  response: Location | Location[] | LocationLink[] | null,
  workspaceRoot: string,
  encoding: string,
): Promise<CodeIntelligenceLocation[]> {
  if (!response) return [];
  const entries = Array.isArray(response) ? response : [response];
  return Promise.all(entries.map(async (entry) => {
    const uri = isLocationLink(entry) ? entry.targetUri : entry.uri;
    const range = isLocationLink(entry) ? entry.targetRange : entry.range;
    if (!uri.startsWith("file:")) {
      throw new CodeIntelligenceError(
        "code.result_outside_policy",
        `Language server returned a non-file definition URI: ${uri}`,
      );
    }
    const targetPath = fileURLToPath(uri);
    const root = resolve(workspaceRoot);
    let resolvedTarget: string;
    let text: string;
    try {
      resolvedTarget = await realpath(targetPath);
      text = await readFile(resolvedTarget, "utf8");
    } catch (error) {
      throw new CodeIntelligenceError(
        "code.result_outside_policy",
        `Unable to normalize definition location ${targetPath}: ${errorMessage(error)}`,
      );
    }
    const external = !isWithin(root, resolvedTarget);
    return {
      path: external ? resolvedTarget : workspaceDisplayPath(root, resolvedTarget),
      external,
      range: rangeFromLsp(text, range, encoding),
    };
  }));
}

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

function workspaceDisplayPath(workspaceRoot: string, path: string): string {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  if (!rel) return ".";
  return rel.split(sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isInteger(resolvedValue) || resolvedValue < 1) {
    throw new Error(`Code-intelligence ${label} must be a positive integer.`);
  }
  return resolvedValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
