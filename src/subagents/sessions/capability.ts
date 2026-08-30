import type { ActivityLifecycle } from "../../activity/lifecycle.js";
import {
  CapabilityError,
  type CapabilityContext,
  type CapabilityExecution,
  type CapabilityRunOptions,
  type SubagentSessionCapabilityInput,
} from "../../capability-registry.js";
import type { ServerConfig } from "../../config.js";
import { isSubagentProvider, type SubagentProvider } from "../profiles.js";
import type { SubagentRunInput, SubagentRunResult } from "../providers/contract.js";
import { subagentProviderContinuationSupported } from "../providers/continuation.js";
import { SubagentDeliveryMailbox, type SubagentDelivery } from "./delivery-mailbox.js";
import {
  executeSubagentRun,
  type SubagentProviderRunner,
  type SubagentRunCompletion,
} from "./execution.js";
import {
  SubagentSessionError,
  SubagentSessionManager,
  type SubagentLaunchRequest,
} from "./manager.js";
import type { SubagentRunSummary, SubagentSession } from "./store.js";

export interface SubagentSessionCapabilityOptions {
  providerRunner?: (provider: SubagentProvider, input: SubagentRunInput) => Promise<SubagentRunResult>;
}

export class SubagentSessionCapability {
  private readonly mailbox: SubagentDeliveryMailbox;
  private readonly providerRunner: SubagentProviderRunner;

  constructor(
    private readonly config: ServerConfig,
    private readonly activityLifecycle: ActivityLifecycle,
    options: SubagentSessionCapabilityOptions = {},
  ) {
    this.mailbox = new SubagentDeliveryMailbox(config.stateDir);
    this.providerRunner = options.providerRunner ?? defaultProviderRunner;
  }

  async run(
    input: SubagentSessionCapabilityInput,
    context: CapabilityContext,
    options: CapabilityRunOptions,
  ): Promise<CapabilityExecution> {
    const manager = new SubagentSessionManager(this.config, {
      launch: (request) => this.launch(request),
    });
    try {
      switch (input.operation) {
        case "start": {
          const started = await manager.start({
            workspaceId: context.workspaceId,
            workspaceRoot: context.workspaceRoot,
            target: input.target,
            prompt: input.prompt,
            model: input.model,
            thinking: input.thinking,
            activityId: options.activityId,
          });
          return {
            value: {
              operation: "start",
              session: publicSession(started.session),
              run: publicRun(started.run),
            },
          };
        }
        case "resume": {
          const resumed = manager.resume({
            sessionId: input.sessionId,
            prompt: input.prompt,
            activityId: options.activityId,
          }, { workspaceId: context.workspaceId });
          return {
            value: {
              operation: "resume",
              session: publicSession(resumed.session),
              run: publicRun(resumed.run),
            },
          };
        }
        case "status": {
          const session = manager.get(input.sessionId, { workspaceId: context.workspaceId });
          if (!session) {
            throw new SubagentSessionError(
              "subagent.session_not_found",
              `Unknown Subagent Session in this Workspace: ${input.sessionId}`,
            );
          }
          return {
            value: {
              operation: "status",
              session: publicSession(session),
              ...(session.activeRun ? { activeRun: publicRun(session.activeRun) } : {}),
              ...(session.latestRun ? { latestRun: publicRun(session.latestRun) } : {}),
            },
          };
        }
        case "list":
          return {
            value: {
              operation: "list",
              sessions: manager.list({ workspaceId: context.workspaceId }).map(publicSessionSummary),
            },
          };
      }
    } catch (error) {
      if (error instanceof SubagentSessionError) {
        throw new CapabilityError(error.code, error.message);
      }
      throw error;
    } finally {
      manager.close();
    }
  }

  decorateResult<T>(workspaceId: string, result: T): T {
    if (typeof result !== "object" || result === null) return result;
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return result;
    const excludeRunId = currentRunId(result);
    const deliveries = this.mailbox.claimWorkspace(workspaceId, excludeRunId);
    if (deliveries.length === 0) return result;
    return {
      ...result,
      content: [
        ...content,
        ...deliveries.map((delivery) => ({ type: "text" as const, text: deliveryText(delivery) })),
      ],
    } as T;
  }

  private launch(request: SubagentLaunchRequest): void {
    void executeSubagentRun(this.config, request, this.providerRunner)
      .then((completion) => this.recordCompletion(completion))
      .catch(() => {
        // The worker writes durable Session/mailbox state for provider failures.
        // An unexpected orchestration failure must not become an unhandled rejection.
      });
  }

  private recordCompletion(completion: SubagentRunCompletion): void {
    if (!completion.activityId) return;
    this.activityLifecycle.recordLinked({
      sourceActivityId: completion.activityId,
      tool: "subagent_result",
      request: {
        sessionId: completion.sessionId,
        runId: completion.runId,
      },
      result: {
        sessionId: completion.sessionId,
        runId: completion.runId,
        provider: completion.provider,
        status: completion.outcome,
      },
      outcome: completion.outcome === "failed"
        ? { type: "failed", error: "Subagent Run failed." }
        : { type: "succeeded" },
    });
  }
}

function publicSession(session: SubagentSession): Record<string, unknown> {
  const continuationSupported = sessionContinuationSupported(session);
  return {
    id: session.id,
    status: session.status,
    profileName: session.profileName,
    provider: session.provider,
    continuationSupported,
    resumable: continuationSupported && session.status === "idle" && Boolean(session.providerSessionId),
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinking ? { thinking: session.thinking } : {}),
    ...(session.activeRun ? { activeRun: publicRun(session.activeRun) } : {}),
    ...(session.latestRun ? { latestRun: publicRun(session.latestRun) } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function publicSessionSummary(session: SubagentSession): Record<string, unknown> {
  const continuationSupported = sessionContinuationSupported(session);
  return {
    id: session.id,
    status: session.status,
    profileName: session.profileName,
    provider: session.provider,
    continuationSupported,
    resumable: continuationSupported && session.status === "idle" && Boolean(session.providerSessionId),
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinking ? { thinking: session.thinking } : {}),
    ...(session.activeRun ? { activeRunId: session.activeRun.id } : {}),
    ...(session.latestRun ? {
        latestRun: {
          id: session.latestRun.id,
          status: session.latestRun.status,
        },
      } : {}),
    updatedAt: session.updatedAt,
  };
}

function sessionContinuationSupported(session: SubagentSession): boolean {
  return isSubagentProvider(session.provider)
    ? subagentProviderContinuationSupported(session.provider)
    : false;
}

function publicRun(run: SubagentRunSummary): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

function currentRunId(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== "object" || structured === null) return undefined;
  const capabilityResult = (structured as { result?: unknown }).result;
  if (typeof capabilityResult !== "object" || capabilityResult === null) return undefined;
  const run = (capabilityResult as { run?: unknown }).run;
  if (typeof run !== "object" || run === null) return undefined;
  const id = (run as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function deliveryText(delivery: SubagentDelivery): string {
  const header = `Subagent ${delivery.sessionId} Run ${delivery.runId} ${delivery.outcome}.`;
  const body = delivery.outcome === "succeeded"
    ? delivery.finalResponse
    : delivery.error;
  const suffix = delivery.truncated ? "\n[Subagent result truncated for delivery.]" : "";
  return body ? `${header}\n${body}${suffix}` : `${header}${suffix}`;
}

async function defaultProviderRunner(
  provider: SubagentProvider,
  input: SubagentRunInput,
): Promise<SubagentRunResult> {
  const { runSubagentProvider } = await import("../providers/registry.js");
  return runSubagentProvider(provider, input);
}
