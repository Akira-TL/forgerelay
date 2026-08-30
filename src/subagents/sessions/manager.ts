import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import {
  formatAvailableSubagentTargets,
  resolveSubagentTarget,
} from "../cli-target.js";
import {
  isSubagentProvider,
  loadSubagentProfiles,
} from "../profiles.js";
import { assertSubagentProviderAvailable } from "../providers/availability.js";
import { subagentProviderContinuationSupported } from "../providers/continuation.js";
import {
  createSubagentSessionStore,
  type SubagentRunSummary,
  type SubagentSession,
  type SubagentSessionScope,
  type SubagentSessionStore,
} from "./store.js";

export interface SubagentLaunchRequest {
  sessionId: string;
  runId: string;
  activityId?: string;
  prompt: string;
}

export interface SubagentLauncher {
  launch(request: SubagentLaunchRequest): void;
}

export interface StartSubagentSessionInput {
  workspaceId?: string;
  workspaceRoot: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
  activityId?: string;
}

export interface ResumeSubagentSessionInput {
  sessionId: string;
  prompt: string;
  activityId?: string;
}

export type SubagentSessionErrorCode =
  | "subagent.session_not_found"
  | "subagent.busy"
  | "subagent.cancel_unavailable"
  | "subagent.continuation_unsupported"
  | "subagent.continuation_unavailable";

export class SubagentSessionError extends Error {
  constructor(
    readonly code: SubagentSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubagentSessionError";
  }
}

export interface SubagentSessionStart {
  session: SubagentSession;
  run: SubagentRunSummary;
}

export class SubagentSessionManager {
  private readonly store: SubagentSessionStore;

  constructor(
    private readonly config: ServerConfig,
    private readonly launcher: SubagentLauncher,
  ) {
    this.store = createSubagentSessionStore(config);
  }

  list(scope: SubagentSessionScope = {}): SubagentSession[] {
    return this.store.list(scope);
  }

  get(idOrPrefix: string, scope?: SubagentSessionScope): SubagentSession | undefined {
    return scope ? this.store.getInScope(idOrPrefix, scope) : this.store.get(idOrPrefix);
  }

  async start(input: StartSubagentSessionInput): Promise<SubagentSessionStart> {
    const profiles = await loadSubagentProfiles(this.config, input.workspaceRoot);
    const target = resolveSubagentTarget(input.target, profiles, input.model, input.thinking);
    if (!target) {
      throw new Error(
        `Unknown subagent profile or provider: ${input.target}. Available ${formatAvailableSubagentTargets(profiles)}`,
      );
    }
    assertSubagentProviderAvailable(target.provider);

    const runId = newRunId();
    const startedAt = new Date().toISOString();
    const session = this.store.create({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      profileName: target.name,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
      activeRun: {
        id: runId,
        ...(input.activityId ? { activityId: input.activityId } : {}),
        startedAt,
      },
    });
    const run = session.activeRun;
    if (!run) throw new Error(`Subagent Session ${session.id} did not create an active Run.`);
    this.launcher.launch({
      sessionId: session.id,
      runId,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      prompt: input.prompt,
    });
    return { session, run };
  }

  resume(
    input: ResumeSubagentSessionInput,
    scope: SubagentSessionScope = {},
  ): SubagentSessionStart {
    const existing = this.store.getInScope(input.sessionId, scope);
    if (!existing) {
      throw new SubagentSessionError(
        "subagent.session_not_found",
        `Unknown Subagent Session in this Workspace: ${input.sessionId}`,
      );
    }
    if (existing.activeRun) {
      throw new SubagentSessionError(
        "subagent.busy",
        `Subagent Session ${existing.id} already has active Run ${existing.activeRun.id}.`,
      );
    }
    if (!isSubagentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    if (!subagentProviderContinuationSupported(existing.provider)) {
      throw new SubagentSessionError(
        "subagent.continuation_unsupported",
        `${existing.provider} does not support true Subagent Session continuation.`,
      );
    }
    if (!existing.providerSessionId) {
      throw new SubagentSessionError(
        "subagent.continuation_unavailable",
        `Subagent Session ${existing.id} has no provider continuation identity.`,
      );
    }
    assertSubagentProviderAvailable(existing.provider);

    const runId = newRunId();
    const startedAt = new Date().toISOString();
    const run: SubagentRunSummary = {
      id: runId,
      status: "running",
      ...(input.activityId ? { activityId: input.activityId } : {}),
      startedAt,
    };
    const session = this.store.update(existing.id, {
      status: "running",
      activeRun: run,
    });
    this.launcher.launch({
      sessionId: session.id,
      runId,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      prompt: input.prompt,
    });
    return { session, run };
  }

  delete(sessionId: string, scope: SubagentSessionScope = {}): SubagentSession {
    const session = this.store.getInScope(sessionId, scope);
    if (!session) {
      throw new SubagentSessionError(
        "subagent.session_not_found",
        `Unknown Subagent Session in this Workspace: ${sessionId}`,
      );
    }
    if (session.activeRun) {
      throw new SubagentSessionError(
        "subagent.busy",
        `Subagent Session ${session.id} already has active Run ${session.activeRun.id}.`,
      );
    }
    this.store.delete(session.id);
    return session;
  }

  close(): void {
    this.store.close();
  }
}

function newRunId(): string {
  return `run_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
