# Workspace Checkpoints

`workspace.checkpoint` provides low-frequency, persistent checkpoints owned by the current filesystem Workspace. Checkpoints are immutable Git-backed snapshots intended for deliberate recovery/history workflows.

## v0.9.3 surface

Supported operations are:

- `create` — create a named immutable checkpoint of the current Git-visible working tree.
- `list` — return bounded checkpoint metadata, preserving checkpoint creation order.
- `inspect` — return bounded metadata for one checkpoint.
- `restore.preflight` — identify the selected checkpoint content snapshot and the current Git-visible working snapshot without mutating files.
- `restore` — restore checkpoint content only when the caller supplies the still-current snapshot identity returned by preflight.
- `delete` — explicitly delete one checkpoint and its ForgeRelay-owned Git ref.

Restore is deliberately a two-step optimistic-concurrency operation. Do not replace it with checkout/reset, hidden merge/rebase behavior, or branch-history rewrites.

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

## Restore preflight and restore

First preflight the selected checkpoint:

```json
{
  "operation": "restore.preflight",
  "checkpointId": "cp_0123456789"
}
```

The result includes `checkpointSnapshot`, the immutable Git tree identity selected for restore, plus `currentSnapshot`, the deterministic Git tree identity of the current Git-visible working content. It also includes a bounded `restoreSummary`. Preflight does not mutate the Workspace.

Then pass that exact `currentSnapshot` back as `expectedCurrentSnapshot`:

```json
{
  "operation": "restore",
  "checkpointId": "cp_0123456789",
  "expectedCurrentSnapshot": "0123456789abcdef0123456789abcdef01234567"
}
```

Immediately before applying content changes ForgeRelay recomputes the current Git-visible working snapshot. If it no longer matches `expectedCurrentSnapshot`, restore fails before mutation and the intervening edits remain untouched. Run preflight again before deciding whether to retry.

A successful restore writes only ordinary working-tree content needed to reproduce the checkpoint's Git-visible tree. It does **not** move branch `HEAD`, rewrite commit history, merge/rebase, auto-commit, or use `git reset --hard` semantics. Ignored files remain outside the checkpoint/restore content model and are not intentionally changed.

The 0.9 restore contract is **content-state only**. ForgeRelay does not reconstruct or promise the historical staged-versus-unstaged partition. Restore does not rewrite the real Git index; existing staging state may therefore differ from the restored working-tree content and should be inspected normally with Git afterward. Results expose `stagingStateRestored: false` to make this explicit.

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
