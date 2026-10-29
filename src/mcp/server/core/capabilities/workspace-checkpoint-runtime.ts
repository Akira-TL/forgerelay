import type { WorkspaceCheckpointStore } from "../../../../workspaces/state/workspace-checkpoints.js";
import type { WorkspaceCheckpointCapabilityDependency } from "./workspace-checkpoint.js";

export function createWorkspaceCheckpointCapabilityRuntime(
  store: WorkspaceCheckpointStore,
): WorkspaceCheckpointCapabilityDependency {
  return {
    available: true,
    run: async (input, context) => {
      const root = context.workspaceRoot;
      if (!root) throw new Error("Workspace checkpoint requires a filesystem-backed Workspace.");
      switch (input.operation) {
        case "create":
          return {
            value: {
              workspaceId: context.workspaceId,
              checkpoint: await store.create(context.workspaceId, root, input.name),
              ignoredFilesIncluded: false,
            },
          };
        case "list":
          return { value: await store.list(context.workspaceId, root, input) };
        case "inspect":
          return { value: await store.inspect(context.workspaceId, root, input.checkpointId) };
        case "restore.preflight":
          return {
            value: await store.preflightRestore(context.workspaceId, root, input.checkpointId),
          };
        case "restore":
          return {
            value: await store.restore(
              context.workspaceId,
              root,
              input.checkpointId,
              input.expectedCurrentSnapshot,
            ),
          };
        case "delete":
          return { value: await store.delete(context.workspaceId, root, input.checkpointId) };
      }
    },
  };
}
