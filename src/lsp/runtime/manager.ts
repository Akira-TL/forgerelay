import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerConfig } from "../../config.js";
import {
  CodeIntelligenceError,
  LanguageService,
  languageServiceKey,
  type CodeIntelligenceRuntimePolicy,
} from "../code-intelligence.js";
import type { CodeIntelligenceInput, CodeIntelligenceResult } from "../code-intelligence-types.js";
import {
  LanguageServerConfigurationError,
  resolveLanguageProject,
  type ResolvedLanguageProject,
} from "../language-server-config.js";

const LANGUAGE_SERVICE_IDLE_MS = 10 * 60 * 1_000;
const LANGUAGE_SERVICE_CLEANUP_INTERVAL_MS = 60 * 1_000;
const MAX_LANGUAGE_SERVICES = 16;
const LANGUAGE_SERVICE_START_TIMEOUT_MS = 15_000;
const LANGUAGE_REQUEST_TIMEOUT_MS = 10_000;
const LANGUAGE_SERVICE_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_SEMANTIC_REQUESTS = 4;
const MAX_QUEUED_SEMANTIC_REQUESTS = 16;
const MAX_DIAGNOSTIC_DOCUMENTS = 128;
const MAX_DIAGNOSTICS_PER_DOCUMENT = 1000;

export interface CodeIntelligenceManagerOptions {
  idleMs?: number;
  cleanupIntervalMs?: number;
  maxServices?: number;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxConcurrentSemanticRequests?: number;
  maxQueuedSemanticRequests?: number;
  maxDiagnosticDocuments?: number;
  maxDiagnosticsPerDocument?: number;
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
      maxConcurrentSemanticRequests: positiveInteger(options.maxConcurrentSemanticRequests, MAX_CONCURRENT_SEMANTIC_REQUESTS, "maxConcurrentSemanticRequests"),
      maxQueuedSemanticRequests: positiveInteger(options.maxQueuedSemanticRequests, MAX_QUEUED_SEMANTIC_REQUESTS, "maxQueuedSemanticRequests"),
      maxDiagnosticDocuments: positiveInteger(options.maxDiagnosticDocuments, MAX_DIAGNOSTIC_DOCUMENTS, "maxDiagnosticDocuments"),
      maxDiagnosticsPerDocument: positiveInteger(options.maxDiagnosticsPerDocument, MAX_DIAGNOSTICS_PER_DOCUMENT, "maxDiagnosticsPerDocument"),
    };
    this.cleanupTimer = setInterval(() => {
      void this.closeIdle();
    }, this.policy.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async run(
    workspaceRoot: string,
    input: CodeIntelligenceInput,
    options: { signal?: AbortSignal } = {},
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
      switch (input.operation) {
        case "definition":
          return await service.definition(input, options.signal);
        case "hover":
          return await service.hover(input, options.signal);
        case "references":
          return await service.references(input, options.signal);
        case "documentSymbols":
          return await service.documentSymbols(input, options.signal);
        case "workspaceSymbols":
          return await service.workspaceSymbols(input, options.signal);
        case "diagnostics":
          return await service.diagnostics(input, options.signal);
      }
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolvedValue = value ?? fallback;
  if (!Number.isInteger(resolvedValue) || resolvedValue < 1) {
    throw new Error(`Code-intelligence ${label} must be a positive integer.`);
  }
  return resolvedValue;
}
