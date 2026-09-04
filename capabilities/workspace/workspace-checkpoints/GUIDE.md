# Workspace Checkpoints

`workspace.checkpoint` provides low-frequency, persistent checkpoints owned by the current filesystem Workspace. Checkpoints are immutable Git-backed snapshots intended for deliberate recovery/history workflows.

## v0.9.2 surface

Supported operations are deliberately limited to:

- `create` — create a named immutable checkpoint of the current Git-visible working tree.
- `list` — return bounded checkpoint metadata, newest identity preserved in creation order.
- `inspect` — return bounded metadata for one checkpoint.
- `delete` — explicitly delete one checkpoint and its ForgeRelay-owned Git ref.

Restore is **not** part of v0.9.2. Do not emulate restore with checkout/reset or other destructive Git commands unless the user separately and explicitly asks for such Git work outside this Capability.

## Create

Use:

```json
{
  "operation": "create",
  "name": "before parser refactor"
}
```

A checkpoint snapshots the current Git-visible working-tree content using a private temporary Git index. Creation does not move branch `HEAD`, write project history, modify files, or mutate the real staging index.

The snapshot includes tracked files and non-ignored untracked files that Git would normally admit. Git-ignored files are excluded. Consequently Workspace checkpoints are **not a backup mechanism for secrets, ignored configuration, credentials, build caches, or other ignored files**.

Checkpoint metadata includes a stable checkpoint id, user-provided name, creation timestamp, immutable snapshot commit id, base `HEAD`, and bounded file/addition/removal counts. It does not return patches or full file contents by default.

## List and inspect

Use `list` for discovery:

```json
{
  "operation": "list",
  "offset": 0,
  "limit": 50
}
```

Use `inspect` only after selecting an id:

```json
{
  "operation": "inspect",
  "checkpointId": "cp_0123456789"
}
```

`list` and `inspect` expose bounded metadata only. Checkpoints do not move when `review.changes` advances its independent last-shown baseline.

## Delete

Deletion is explicit:

```json
{
  "operation": "delete",
  "checkpointId": "cp_0123456789"
}
```

ForgeRelay verifies that the Workspace-owned Git ref still points at the checkpoint's recorded immutable commit before deleting it. A mismatched or missing ref is treated as inconsistent state rather than silently deleting something else.

Ordinary Workspace close, process restart, idle Workspace cache GC, and managed-worktree backing replacement preserve checkpoints. Permanent `close_workspace { action: "delete" }` removes checkpoints owned by that Workspace identity.

## Relay and Composite Workspaces

Checkpoint ownership belongs to the Execution Workspace. Through Workspace Relay, checkpoint operations execute on the remote Execution ForgeRelay and persist there.

A Composite Workspace does not own filesystem checkpoints itself. Pass an explicit `member` so the operation targets that member's persistent Workspace identity.
