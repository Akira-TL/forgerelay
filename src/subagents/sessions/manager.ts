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
  type SubagentSession,
  type SubagentSessionScope,
  type SubagentSessionStore,
} from "./store.js";

export interface SubagentLauncher {
  launch(sessionId: string, prompt: string): void;
}

export interface StartSubagentSessionInput {
  workspaceId?: string;
  workspaceRoot: string;
  target: string;
  prompt: string;
  model?: string;
  thinking?: string;
}

export interface ResumeSubagentSessionInput {
  sessionId: string;
  prompt: string;
  model?: string;
  thinking?: string;
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

  get(idOrPrefix: string): SubagentSession | undefined {
    return this.store.get(idOrPrefix);
  }

  async start(input: StartSubagentSessionInput): Promise<SubagentSession> {
    const profiles = await loadSubagentProfiles(this.config, input.workspaceRoot);
    const target = resolveSubagentTarget(input.target, profiles, input.model, input.thinking);
    if (!target) {
      throw new Error(
        `Unknown subagent profile or provider: ${input.target}. Available ${formatAvailableSubagentTargets(profiles)}`,
      );
    }
    assertSubagentProviderAvailable(target.provider);

    const session = this.store.create({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      profileName: target.name,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
    });
    this.launcher.launch(session.id, input.prompt);
    return session;
  }

  resume(input: ResumeSubagentSessionInput): SubagentSession {
    const existing = this.store.get(input.sessionId);
    if (!existing) throw new Error(`Unknown subagent id: ${input.sessionId}`);
    if (!isSubagentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    assertSubagentProviderAvailable(existing.provider);

    const session = this.store.update(existing.id, {
      status: "starting",
      model: input.model ?? existing.model,
      thinking: input.thinking ?? existing.thinking,
      latestResponse: undefined,
      error: undefined,
      hookReports: undefined,
    });
    this.launcher.launch(session.id, input.prompt);
    return session;
  }

  close(): void {
    this.store.close();
  }
}
