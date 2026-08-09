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

**Hook event**：
ForgeRelay 生命周期中的命名触发点。规则在对应事件发生前后自动求值。
_Avoid_: Plugin event, Git hook

**Hook rule**：
绑定到一个 Hook event 的自动规则，由可选 matcher 和有序 handlers 组成；全局规则与项目规则可以同时生效。
_Avoid_: Permission prompt, approval rule

**Hook handler**：
规则命中后由 ForgeRelay 自动执行的本地命令。handler 可以决定执行结果是否需要向 Agent 报告。
_Avoid_: Plugin, extension

**Hook report**：
一次 Hook handler 执行后返回给 Host/Agent 的结果，用于让 Agent 感知触发、通过或阻断状态。
_Avoid_: Approval, user confirmation

**Subagent**:
A bounded provider-backed local coding worker delegated a task and coordinated by
the host through ForgeRelay-owned lifecycle state.
_Avoid_: Host-native subagent, autonomous workflow

**Review checkpoint**:
Stored Git-backed state representing a coherent review baseline for workspace
changes.
_Avoid_: Memory, conversation checkpoint
