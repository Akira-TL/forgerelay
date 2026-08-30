import type { ServerConfig } from "../../config.js";
import { HookRunner } from "../../hooks.js";
import {
  isSubagentProvider,
  loadSubagentProfiles,
  type SubagentProfile,
  type SubagentProvider,
} from "../profiles.js";
import type {
  SubagentRunInput,
  SubagentRunResult,
} from "../providers/contract.js";
import { runSubagentProvider } from "../providers/registry.js";
import { SubagentDeliveryMailbox, type SubagentRunOutcome } from "./delivery-mailbox.js";
import {
  createSubagentSessionStore,
  type SubagentSession,
} from "./store.js";

export type SubagentProviderRunner = (
  provider: SubagentProvider,
  input: SubagentRunInput,
) => Promise<SubagentRunResult>;

export interface ExecuteSubagentRunInput {
  sessionId: string;
  runId: string;
  activityId?: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface SubagentRunCompletion {
  sessionId: string;
  runId: string;
  workspaceId?: string;
  activityId?: string;
  provider: string;
  outcome: Extract<SubagentRunOutcome, "succeeded" | "failed" | "cancelled">;
  error?: string;
}

export async function executeSubagentRun(
  config: ServerConfig,
  input: ExecuteSubagentRunInput,
  providerRunner: SubagentProviderRunner = runSubagentProvider,
): Promise<SubagentRunCompletion> {
  const store = createSubagentSessionStore(config);
  const mailbox = new SubagentDeliveryMailbox(config.stateDir);
  try {
    const record = store.get(input.sessionId);
    if (!record) throw new Error(`Unknown subagent id: ${input.sessionId}`);
    if (record.activeRun?.id !== input.runId) {
      throw new Error(`Subagent Run ${input.runId} is not active for Session ${record.id}.`);
    }
    const hooks = new HookRunner(config.hooks, config.logging);
    const hookInvocation = {
      workspaceId: record.workspaceId,
      workspaceRoot: record.workspaceRoot,
      payload: {
        agentId: record.id,
        sessionId: record.id,
        runId: input.runId,
        profile: record.profileName,
        provider: record.provider,
        model: record.model,
        thinking: record.thinking,
      },
    };

    let outcome: "succeeded" | "failed" | "cancelled" = "succeeded";
    let result: SubagentRunResult | undefined;
    let errorMessage: string | undefined;
    try {
      await hooks.run("SubagentStart", hookInvocation);
      input.signal?.throwIfAborted();
      result = await runSessionProvider(config, record, input.prompt, providerRunner, input.signal);
      input.signal?.throwIfAborted();
    } catch (error) {
      if (isCancelled(error, input.signal)) {
        outcome = "cancelled";
        errorMessage = "Subagent Run cancelled.";
      } else {
        outcome = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      await hooks.run("SubagentStop", {
        ...hookInvocation,
        payload: {
          ...hookInvocation.payload,
          status: outcome,
        },
      });
    } catch (error) {
      if (outcome === "succeeded") {
        outcome = "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    const finishedAt = new Date().toISOString();
    store.update(record.id, {
      ...(result?.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
      status: "idle",
      activeRun: undefined,
      latestRun: {
        id: input.runId,
        status: outcome,
        finishedAt,
      },
    });
    if (record.workspaceId) {
      mailbox.write({
        sessionId: record.id,
        runId: input.runId,
        workspaceId: record.workspaceId,
        ...(input.activityId ? { activityId: input.activityId } : {}),
        provider: record.provider,
        outcome,
        ...(outcome === "succeeded" && result ? { finalResponse: result.finalResponse } : {}),
        ...(outcome !== "succeeded" && errorMessage ? { error: errorMessage } : {}),
      });
    }
    return completion(record, input, outcome, errorMessage);
  } finally {
    store.close();
  }
}

export async function executeSubagentSession(
  config: ServerConfig,
  sessionId: string,
  prompt: string,
): Promise<SubagentRunCompletion> {
  const store = createSubagentSessionStore(config);
  try {
    const record = store.get(sessionId);
    if (!record) throw new Error(`Unknown subagent id: ${sessionId}`);
    if (!record.activeRun) throw new Error(`Subagent Session ${sessionId} has no active Run.`);
    return executeSubagentRun(config, {
      sessionId,
      runId: record.activeRun.id,
      ...(record.activeRun.activityId ? { activityId: record.activeRun.activityId } : {}),
      prompt,
    });
  } finally {
    store.close();
  }
}

async function runSessionProvider(
  config: ServerConfig,
  session: SubagentSession,
  prompt: string,
  providerRunner: SubagentProviderRunner,
  signal?: AbortSignal,
): Promise<SubagentRunResult> {
  if (!isSubagentProvider(session.provider)) {
    throw new Error(`Unknown subagent provider for Session ${session.id}: ${session.provider}`);
  }
  if (session.providerSessionId) {
    return providerRunner(session.provider, {
      prompt,
      workspace: session.workspaceRoot,
      providerSessionId: session.providerSessionId,
      writeMode: "allowed",
      model: session.model,
      thinking: session.thinking,
      signal,
    });
  }
  if (session.profileName === session.provider) {
    return providerRunner(session.provider, {
      prompt,
      workspace: session.workspaceRoot,
      writeMode: "allowed",
      model: session.model,
      thinking: session.thinking,
      signal,
    });
  }
  const profiles = await loadSubagentProfiles(config, session.workspaceRoot);
  const profile = profiles.find((candidate) => candidate.name === session.profileName);
  if (!profile) throw new Error(`Subagent profile not found: ${session.profileName}`);
  return runSubagentProfile(profile, session, prompt, providerRunner, signal);
}

async function runSubagentProfile(
  profile: SubagentProfile,
  session: SubagentSession,
  prompt: string,
  providerRunner: SubagentProviderRunner,
  signal?: AbortSignal,
): Promise<SubagentRunResult> {
  const body = profile.body.trim();
  const firstPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return providerRunner(session.provider as SubagentProvider, {
    prompt: firstPrompt,
    workspace: session.workspaceRoot,
    writeMode: "allowed",
    model: session.model,
    thinking: session.thinking,
    signal,
  });
}

function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function completion(
  session: SubagentSession,
  input: ExecuteSubagentRunInput,
  outcome: "succeeded" | "failed" | "cancelled",
  error?: string,
): SubagentRunCompletion {
  return {
    sessionId: session.id,
    runId: input.runId,
    workspaceId: session.workspaceId,
    activityId: input.activityId,
    provider: session.provider,
    outcome,
    ...(error ? { error } : {}),
  };
}
