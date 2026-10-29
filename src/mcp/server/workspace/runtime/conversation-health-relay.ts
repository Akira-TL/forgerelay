import type { ActivityQueryService } from "../../../../activity/history/query-service.js";
import type { RemoteWorkspaceRelay } from "../../../../workspaces/relay/workspace-relay.js";
import {
  rebaseConversationHealthAge,
  type ConversationHealthResult,
} from "../../../../workspaces/state/conversation-health.js";
import { textBlock } from "../../core/tool-support.js";

export function rebaseRemoteCompositeConversationHealth(
  response: Awaited<ReturnType<RemoteWorkspaceRelay["capability"]>>,
  compositeWorkspaceId: string,
  conversationScopeId: string,
  activityQueries: ActivityQueryService,
): Awaited<ReturnType<RemoteWorkspaceRelay["capability"]>> {
  if (response.isError === true) return response;
  const structured = response.structuredContent;
  if (!structured || typeof structured !== "object") return response;
  const result = (structured as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return response;

  const health = result as ConversationHealthResult;
  const latestCheckpoint = health.latestCheckpoint;
  const hostTurnCount = activityQueries.countTurns(
    conversationScopeId,
    compositeWorkspaceId,
  );
  const turnsSinceLatestCheckpoint = latestCheckpoint
    ? activityQueries.countTurns(
        conversationScopeId,
        compositeWorkspaceId,
        latestCheckpoint.createdAt,
      )
    : hostTurnCount;
  const rebased = rebaseConversationHealthAge(health, {
    hostTurnCount,
    turnsSinceLatestCheckpoint,
  });

  return {
    ...response,
    content: [textBlock(
      `Capability workspace.conversation-health completed.\n${JSON.stringify(rebased, null, 2)}`,
    )],
    structuredContent: {
      ...(structured as Record<string, unknown>),
      result: rebased,
    },
  };
}
