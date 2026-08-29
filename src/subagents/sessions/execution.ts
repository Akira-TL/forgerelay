import type { ServerConfig } from "../../config.js";
import { HookRunner } from "../../hooks.js";
import {
  isSubagentProvider,
  loadSubagentProfiles,
  type SubagentProfile,
} from "../profiles.js";
import type { SubagentRunResult } from "../providers/contract.js";
import { runSubagentProvider } from "../providers/registry.js";
import {
  createSubagentSessionStore,
  type SubagentSession,
} from "./store.js";

export async function executeSubagentSession(
  config: ServerConfig,
  sessionId: string,
  prompt: string,
): Promise<SubagentSession> {
  const store = createSubagentSessionStore(config);
  try {
    const record = store.get(sessionId);
    if (!record) throw new Error(`Unknown subagent id: ${sessionId}`);
    const hooks = new HookRunner(config.hooks, config.logging);
    const hookInvocation = {
      workspaceId: record.workspaceId,
      workspaceRoot: record.workspaceRoot,
      payload: {
        agentId: record.id,
        profile: record.profileName,
        provider: record.provider,
        model: record.model,
        thinking: record.thinking,
      },
    };

    store.update(record.id, { status: "running", error: undefined, hookReports: undefined });
    const hookReports = await hooks.run("SubagentStart", hookInvocation);
    store.update(record.id, { hookReports });
    try {
      const profiles = await loadSubagentProfiles(config, record.workspaceRoot);
      const profile = profiles.find((candidate) => candidate.name === record.profileName);
      const result = profile
        ? await runSubagentProfile(profile, record, prompt)
        : await runRawSubagentProvider(record, prompt);
      hookReports.push(...await hooks.run("SubagentStop", {
        ...hookInvocation,
        payload: {
          ...hookInvocation.payload,
          status: "idle",
          providerSessionId: result.providerSessionId,
        },
      }));
      return store.update(record.id, {
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: result.finalResponse,
        error: undefined,
        hookReports,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hookReports.push(...await hooks.run("SubagentStop", {
        ...hookInvocation,
        payload: {
          ...hookInvocation.payload,
          status: "error",
        },
      }));
      return store.update(record.id, {
        status: "error",
        error: message,
        hookReports,
      });
    }
  } finally {
    store.close();
  }
}

async function runSubagentProfile(
  profile: SubagentProfile,
  session: SubagentSession,
  prompt: string,
): Promise<SubagentRunResult> {
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return runSubagentProvider(profile.provider, {
    prompt: fullPrompt,
    workspace: session.workspaceRoot,
    providerSessionId: session.providerSessionId,
    writeMode: "allowed",
    model: session.model ?? profile.model,
    thinking: session.thinking ?? profile.thinking,
  });
}

async function runRawSubagentProvider(
  session: SubagentSession,
  prompt: string,
): Promise<SubagentRunResult> {
  if (session.profileName !== session.provider || !isSubagentProvider(session.provider)) {
    throw new Error(`Subagent profile not found: ${session.profileName}`);
  }

  return runSubagentProvider(session.provider, {
    prompt,
    workspace: session.workspaceRoot,
    providerSessionId: session.providerSessionId,
    writeMode: "allowed",
    model: session.model,
    thinking: session.thinking,
  });
}
