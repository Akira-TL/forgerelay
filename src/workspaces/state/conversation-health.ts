import type { ActivityQueryService } from "../../activity/history/query-service.js";
import type { WorkspaceCheckpoint } from "./workspace-checkpoints.js";
import { WorkspaceCheckpointStore } from "./workspace-checkpoints.js";
import { WorkspaceTaskStore } from "../tasks/workspace-tasks.js";
import { getGitEligibility, git } from "../git/git.js";

export const CONVERSATION_HEALTH_POLICY = {
  checkpointTurnThreshold: 12,
  rotationTurnThreshold: 24,
  checkpointFreshTurnWindow: 8,
} as const;

export type ConversationHealthStatus =
  | "healthy"
  | "checkpoint-recommended"
  | "rotation-recommended";

export type ConversationHealthRecommendedAction =
  | "continue"
  | "checkpoint"
  | "rotate"
  | "checkpoint-and-rotate";

export interface ConversationHealthResult {
  workspaceId: string;
  status: ConversationHealthStatus;
  reasons: string[];
  recommendedAction: ConversationHealthRecommendedAction;
  policy: typeof CONVERSATION_HEALTH_POLICY;
  metrics: {
    hostTurnCount: number;
    turnsSinceLatestCheckpoint: number;
  };
  latestCheckpoint?: WorkspaceCheckpoint;
  activeTasks: Array<{
    listId: string;
    listName: string;
    id: string;
    status: "pending" | "in_progress";
    subject: string;
  }>;
  git?: {
    head: string;
    branch?: string;
    dirty: boolean;
    changedFiles: number;
  };
}

export interface ConversationHealthDependencies {
  activityQueries: ActivityQueryService;
  workspaceTasks: WorkspaceTaskStore;
  workspaceCheckpoints: WorkspaceCheckpointStore;
}

export async function inspectConversationHealth(
  dependencies: ConversationHealthDependencies,
  input: {
    workspaceId: string;
    workspaceRoot: string;
    conversationScopeId: string;
    conversationWorkspaceId?: string;
  },
): Promise<ConversationHealthResult> {
  const conversationWorkspaceId = input.conversationWorkspaceId ?? input.workspaceId;
  const hostTurnCount = dependencies.activityQueries.countTurns(
    input.conversationScopeId,
    conversationWorkspaceId,
  );
  const gitState = await inspectGitState(input.workspaceRoot);
  const latestCheckpoint = gitState
    ? (await dependencies.workspaceCheckpoints.latest(
        input.workspaceId,
        input.workspaceRoot,
      )).checkpoint
    : undefined;
  const turnsSinceLatestCheckpoint = latestCheckpoint
    ? dependencies.activityQueries.countTurns(
        input.conversationScopeId,
        conversationWorkspaceId,
        latestCheckpoint.createdAt,
      )
    : hostTurnCount;
  const policyDecision = evaluateConversationHealth({
    hostTurnCount,
    turnsSinceLatestCheckpoint,
    checkpointAvailable: Boolean(gitState),
    checkpointPresent: Boolean(latestCheckpoint),
  });
  const taskHeaders = dependencies.workspaceTasks.inspectHeaders(input.workspaceId);

  return {
    workspaceId: input.workspaceId,
    ...policyDecision,
    policy: CONVERSATION_HEALTH_POLICY,
    metrics: {
      hostTurnCount,
      turnsSinceLatestCheckpoint,
    },
    ...(latestCheckpoint ? { latestCheckpoint } : {}),
    activeTasks: (taskHeaders?.lists ?? [])
      .filter((list) => list.state === "active")
      .flatMap((list) =>
        list.tasks.flatMap((task) =>
          task.status === "completed"
            ? []
            : [{
                listId: list.id,
                listName: list.name,
                id: task.id,
                status: task.status,
                subject: task.subject,
              }]
        )
      )
      .slice(0, 20),
    ...(gitState ? { git: gitState } : {}),
  };
}

export function evaluateConversationHealth(input: {
  hostTurnCount: number;
  turnsSinceLatestCheckpoint: number;
  checkpointAvailable: boolean;
  checkpointPresent: boolean;
}): Pick<ConversationHealthResult, "status" | "reasons" | "recommendedAction"> {
  const checkpointRecent = input.checkpointPresent
    && input.turnsSinceLatestCheckpoint
      <= CONVERSATION_HEALTH_POLICY.checkpointFreshTurnWindow;

  if (input.hostTurnCount >= CONVERSATION_HEALTH_POLICY.rotationTurnThreshold) {
    if (!input.checkpointAvailable) {
      return {
        status: "rotation-recommended",
        reasons: [
          "host_turn_count_rotation_threshold",
          "checkpoint_unavailable",
        ],
        recommendedAction: "rotate",
      };
    }
    return {
      status: "rotation-recommended",
      reasons: [
        "host_turn_count_rotation_threshold",
        checkpointRecent ? "checkpoint_recent" : "checkpoint_stale",
      ],
      recommendedAction: checkpointRecent ? "rotate" : "checkpoint-and-rotate",
    };
  }

  if (
    input.checkpointAvailable
    && input.hostTurnCount >= CONVERSATION_HEALTH_POLICY.checkpointTurnThreshold
    && !checkpointRecent
  ) {
    return {
      status: "checkpoint-recommended",
      reasons: [
        "host_turn_count_checkpoint_threshold",
        input.checkpointPresent ? "checkpoint_stale" : "checkpoint_missing",
      ],
      recommendedAction: "checkpoint",
    };
  }

  return {
    status: "healthy",
    reasons: checkpointRecent ? ["checkpoint_recent"] : [],
    recommendedAction: "continue",
  };
}

export function rebaseConversationHealthAge(
  result: ConversationHealthResult,
  input: {
    hostTurnCount: number;
    turnsSinceLatestCheckpoint: number;
  },
): ConversationHealthResult {
  return {
    ...result,
    ...evaluateConversationHealth({
      ...input,
      checkpointAvailable: result.git !== undefined,
      checkpointPresent: result.latestCheckpoint !== undefined,
    }),
    policy: CONVERSATION_HEALTH_POLICY,
    metrics: {
      hostTurnCount: input.hostTurnCount,
      turnsSinceLatestCheckpoint: input.turnsSinceLatestCheckpoint,
    },
  };
}

async function inspectGitState(
  workspaceRoot: string,
): Promise<ConversationHealthResult["git"] | undefined> {
  const eligibility = await getGitEligibility(workspaceRoot);
  if (!eligibility.ok || !eligibility.gitRoot) return undefined;

  const [headResult, branchResult, statusResult] = await Promise.all([
    git(eligibility.gitRoot, ["rev-parse", "HEAD"]),
    git(eligibility.gitRoot, ["branch", "--show-current"]),
    git(
      eligibility.gitRoot,
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { maxBuffer: 2 * 1024 * 1024 },
    ),
  ]);
  const statusLines = statusResult.stdout
    .split("\n")
    .filter((line) => line.length > 0);
  const branch = branchResult.stdout.trim();

  return {
    head: headResult.stdout.trim(),
    ...(branch ? { branch } : {}),
    dirty: statusLines.length > 0,
    changedFiles: statusLines.length,
  };
}
