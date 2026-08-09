# ForgeRelay

ForgeRelay is the local development execution and control context between an MCP
host and the user's real development environment.

## Language

**Host**:
The MCP client that owns the conversation, reasoning, and top-level orchestration.
_Avoid_: Agent runtime, ForgeRelay agent

**Workspace**:
An opened local checkout or managed worktree together with the execution context
ForgeRelay associates with that directory.
_Avoid_: Allowed root, repository

**Managed worktree**:
A branch-backed Git worktree created and lifecycle-managed by ForgeRelay for
isolated or parallel work.
_Avoid_: Sandbox, temporary checkout

**Hook event**:
A named ForgeRelay lifecycle point at which user-configured hook handlers may run.
_Avoid_: Plugin event, Git hook

**Hook handler**:
A user-configured local command bound to one hook event and executed with the
workspace as its working context.
_Avoid_: Plugin, extension

**Subagent**:
A bounded provider-backed local coding worker delegated a task and coordinated by
the host through ForgeRelay-owned lifecycle state.
_Avoid_: Host-native subagent, autonomous workflow

**Review checkpoint**:
Stored Git-backed state representing a coherent review baseline for workspace
changes.
_Avoid_: Memory, conversation checkpoint
