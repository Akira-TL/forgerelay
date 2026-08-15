# Batch execution

Use `capability` with `name="batch.execute"` when several independent ForgeRelay core operations can be completed in one Agent interaction.

## Contract

- Every batch belongs to one already-open `workspaceId`.
- Supply 1–100 tasks. Every task requires a unique stable `id`.
- Supported operations are `read`, `write`, `edit`, `rename`, `delete`, `bash.run`, and `capability.run`.
- Core tasks are single-target operations. Use native `read(paths)`, `edit(paths)`, or `delete(paths)` for one homogeneous operation over multiple targets instead of nesting bulk groups inside a batch.
- `concurrency` may be 1–10. When omitted, ForgeRelay uses `min(task count, 10)`.
- Independent tasks may run concurrently. Conflicting filesystem mutations are serialized automatically. `bash.run` is treated conservatively as exclusive work because a shell command may modify arbitrary workspace state.
- Capability definitions explicitly advertise a batch policy: `parallel`, `serial`, or `unsupported`. Parallel capabilities may run concurrently; serial capabilities run exclusively in v0.5.5; unsupported capabilities return a task-level error while preserving the failed child Activity.
- One task failure does not stop independent tasks. Results are returned in the same order as the input task list.
- Host cancellation stops launching queued tasks and is propagated to already-running tasks.
- Batch execution does not support nested batches, Workspace lifecycle calls, Activity query/control calls, or Bash process-control actions.

Each actual task retains its normal ForgeRelay Hooks, Activity audit, validation, and result semantics. The Batch parent is an aggregate Activity and does not execute Tool Hooks itself.
