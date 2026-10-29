# Workspace Conversation Health

`workspace.conversation-health` is a low-frequency, read-only advisory capability for deciding when a long-lived Host conversation should checkpoint or rotate while durable Workspace state remains canonical.

## Policy

The current deterministic policy uses only ForgeRelay-observable state:

- recommend a checkpoint at 12 Host Turns when no recent persistent checkpoint exists;
- recommend conversation rotation at 24 Host Turns;
- treat a checkpoint as recent for 8 Host Turns after its creation.

These thresholds are policy constants, not estimates of model token usage, context-window utilization, memory pressure, or reasoning state.

The result exposes the policy thresholds, Host Turn counts, bounded active Task summaries, the latest persistent checkpoint when available, and bounded Git state for Git-backed Workspaces.

## Recommended actions

- `continue` — the current conversation is still within the advisory threshold.
- `checkpoint` — create a named `workspace.checkpoint` before continuing.
- `checkpoint-and-rotate` — create a fresh persistent checkpoint, then move to a fresh Host conversation.
- `rotate` — a recent checkpoint already exists; move to a fresh Host conversation and reopen the same Workspace.

The capability never creates a checkpoint, closes a Host conversation, stores the Host transcript, or forces rotation.

## Durable handoff

A fresh Host conversation should call `open_workspace` for the same canonical Workspace and resume from durable state. Workspace Tasks, persistent checkpoints, Git state, and Project status artifacts remain the source of truth; the previous Host transcript is not required for recovery.

Task handoff metadata is summary-only and excludes Task content. Checkpoint metadata is bounded and excludes patches or file contents.

## Relay and Composite Workspaces

For a relayed Workspace, the capability executes on the remote Execution ForgeRelay so Host Turn, Task, checkpoint, and Git observations come from the Workspace owner.

A Composite Workspace has no single filesystem conversation-health state. Pass an explicit `member`; the capability evaluates that member's Execution Workspace.
