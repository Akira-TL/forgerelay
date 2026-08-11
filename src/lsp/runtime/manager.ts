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
const LANGUAGE_SERVICE_CRASH_COOLDOWN_MS = 5_000;

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
  crashCooldownMs?: number;
}

interface CrashState {
  failures: number;
  cooldownUntil: number;
}

export class CodeIntelligenceManager {
  private readonly services = new Map<string, LanguageService>();
  private readonly serviceCreations = new Map<string, Promise<LanguageService>>();
  private readonly invalidatedServiceKeys = new Set<string>();
  private readonly crashStates = new Map<string, CrashState>();
  private serviceCreationQueue: Promise<void> = Promise.resolve();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly policy: CodeIntelligenceRuntimePolicy;
  private readonly crashCooldownMs: number;

  constructor(
    private readonly config: Pick<ServerConfig, "languageServers">,
    options: CodeIntelligenceManagerOptions = {},
  ) {
    this.crashCooldownMs = positiveInteger(
      options.crashCooldownMs,
      LANGUAGE_SERVICE_CRASH_COOLDOWN_MS,
      "crashCooldownMs",
    );
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

    await this.invalidateChangedServices(project);
    const identity = languageServiceKey(project);
    this.assertNotCoolingDown(identity, project);

    let lastCrash: CodeIntelligenceError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const service = await this.acquireService(canonicalWorkspaceRoot, project);
      let crashed = false;
      try {
        const result = await this.executeOperation(service, input, options.signal);
        this.crashStates.delete(identity);
        return result;
      } catch (error) {
        if (!(error instanceof CodeIntelligenceError) || error.code !== "code.server_crashed") {
          throw error;
        }
        crashed = true;
        lastCrash = error;
      } finally {
        await this.releaseService(service);
      }

      if (crashed) {
        await this.discardService(service);
        const failures = (this.crashStates.get(identity)?.failures ?? 0) + 1;
        if (attempt === 0) {
          this.crashStates.set(identity, { failures, cooldownUntil: 0 });
          continue;
        }
        const cooldownUntil = Date.now() + this.crashCooldownMs;
        this.crashStates.set(identity, { failures, cooldownUntil });
        throw new CodeIntelligenceError(
          "code.language_service_cooldown",
          `Language server ${project.definition.id} crashed repeatedly; retry after ${this.crashCooldownMs}ms. Last error: ${lastCrash.message}`,
        );
      }
    }

    throw lastCrash ?? new CodeIntelligenceError(
      "code.server_crashed",
      `Language server ${project.definition.id} failed without a recoverable result.`,
    );
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled(this.serviceCreations.values());
    this.serviceCreations.clear();
    const services = [...this.services.values()];
    this.services.clear();
    this.invalidatedServiceKeys.clear();
    this.crashStates.clear();
    await Promise.allSettled(services.map((service) => service.shutdown()));
  }

  get size(): number {
    return this.services.size;
  }

  private async executeOperation(
    service: LanguageService,
    input: CodeIntelligenceInput,
    signal: AbortSignal | undefined,
  ): Promise<CodeIntelligenceResult> {
    switch (input.operation) {
      case "definition":
        return service.definition(input, signal);
      case "hover":
        return service.hover(input, signal);
      case "references":
        return service.references(input, signal);
      case "documentSymbols":
        return service.documentSymbols(input, signal);
      case "workspaceSymbols":
        return service.workspaceSymbols(input, signal);
      case "diagnostics":
        return service.diagnostics(input, signal);
    }
  }

  private assertNotCoolingDown(identity: string, project: ResolvedLanguageProject): void {
    const state = this.crashStates.get(identity);
    if (!state?.cooldownUntil) return;
    const remaining = state.cooldownUntil - Date.now();
    if (remaining <= 0) {
      this.crashStates.delete(identity);
      return;
    }
    throw new CodeIntelligenceError(
      "code.language_service_cooldown",
      `Language server ${project.definition.id} is cooling down after repeated crashes; retry in ${remaining}ms.`,
    );
  }

  private async invalidateChangedServices(project: ResolvedLanguageProject): Promise<void> {
    const root = resolve(project.projectRoot);
    const invalidated: Array<[string, LanguageService]> = [];
    for (const [key, service] of this.services) {
      if (
        resolve(service.project.projectRoot) === root &&
        service.project.definition.id === project.definition.id &&
        service.project.definition.fingerprint !== project.definition.fingerprint
      ) {
        this.invalidatedServiceKeys.add(key);
        this.crashStates.delete(key);
        if (service.inFlight === 0) invalidated.push([key, service]);
      }
    }
    for (const [key, service] of invalidated) {
      if (this.services.get(key) === service) this.services.delete(key);
      this.invalidatedServiceKeys.delete(key);
      await service.shutdown();
    }
  }

  private async releaseService(service: LanguageService): Promise<void> {
    service.release();
    if (!this.invalidatedServiceKeys.has(service.key) || service.inFlight !== 0) return;
    if (this.services.get(service.key) === service) this.services.delete(service.key);
    this.invalidatedServiceKeys.delete(service.key);
    await service.shutdown();
  }

  private async discardService(service: LanguageService): Promise<void> {
    if (this.services.get(service.key) === service) this.services.delete(service.key);
    this.invalidatedServiceKeys.delete(service.key);
    await service.shutdown();
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
