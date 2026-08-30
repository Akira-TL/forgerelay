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
  model?: string;
  thinking?: string;
  activityId?: string;
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

  resume(input: ResumeSubagentSessionInput): SubagentSessionStart {
    const existing = this.store.get(input.sessionId);
    if (!existing) throw new Error(`Unknown subagent id: ${input.sessionId}`);
    if (!isSubagentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
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
      model: input.model ?? existing.model,
      thinking: input.thinking ?? existing.thinking,
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

  close(): void {
    this.store.close();
  }
}

function newRunId(): string {
  return `run_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
