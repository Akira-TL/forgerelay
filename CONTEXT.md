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
绑定到一个 Hook event 的自动规则。首选形式是一条规则一个独立 Hook file；全局规则与项目规则可以同时生效。
_Avoid_: Permission prompt, approval rule

**Hook file**：
一个独立命名的 `<hook-name>.json` 生命周期规则文件。文件名就是日志和 Agent-visible report 中的 Hook 名。
_Avoid_: Plugin manifest, hook bundle

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

**Core tool surface**:
The small, stable set of MCP tools ForgeRelay keeps visible for ordinary workspace coding regardless of optional capabilities.
_Avoid_: Minimal tools, default tools

**Capability**:
A ForgeRelay-owned non-core ability that can be discovered after opening a workspace and invoked only when relevant.
_Avoid_: Plugin, hidden tool

**Capability catalog**:
The lightweight workspace-scoped list of available Capabilities returned by `open_workspace`, containing discovery metadata rather than full operating instructions.
_Avoid_: Tool list, capability guide

**Capability guide**:
Version-bound ForgeRelay documentation that explains how to use a Capability correctly, read on demand when the Agent needs the detailed contract.
_Avoid_: Skill, tool description

**Capability gateway**:
The single MCP entry point named `capability` used to inspect and execute registered non-core Capabilities without expanding the always-visible tool surface.
_Avoid_: Plugin runtime, arbitrary RPC

**Code intelligence**:
Workspace-aware semantic code information provided through ForgeRelay Capabilities and backed by external language servers already available in the user's environment.
_Avoid_: Code search, language-server installation

**Language service**:
A ForgeRelay-managed semantic-code service for one canonical language project root and one language-server definition. Logical workspaces that refer to the same physical language project share the same service; distinct managed worktrees or nested language projects naturally use distinct services.
_Avoid_: Workspace process, language-server installation, logical-workspace server

**Language project**:
The nearest language-specific project boundary containing a source path, such as a TypeScript project or Python project nested inside a larger ForgeRelay Workspace.
_Avoid_: Workspace, repository, allowed root

**Language-server definition**:
The ForgeRelay configuration or built-in discovery description that identifies one external language server and the languages/project markers it can serve.
_Avoid_: Language service, installed server, Capability

**External code location**:
A code-intelligence result that points outside the current ForgeRelay Workspace, such as dependency source, a standard library, or a toolchain-provided declaration. It is informative and does not expand ForgeRelay file-access authority.
_Avoid_: Allowed root, mounted dependency, readable external file

**Diagnostic snapshot**:
The latest bounded set of language-server diagnostics ForgeRelay associates with one document at a known freshness point.
_Avoid_: Build log, permanent diagnostic history, Workspace state

**Host Turn**:
One top-level Host execution cycle for a user input, beginning when the Host starts handling that input and ending when it produces its final response or the user interrupts the cycle.
_Avoid_: Agent session, provider session, conversation

**Workspace Open Card**:
An immutable MCP App result view for one successful Workspace open or switch. It records the Workspace state visible at that open and does not monitor later tool execution.
_Avoid_: Workspace dashboard, Activity Panel

**Activity**:
One semantic top-level ForgeRelay operation performed during a Host Turn. Follow-up control calls for the same operation, such as polling a running Bash process, update the existing Activity rather than creating additional Activities.
_Avoid_: RPC call, log line, Hook execution

**Activity Panel**:
The MCP App view that presents the Activities for one Host Turn. The panel is a presentation over ForgeRelay-owned Activity state rather than the source of that state.
_Avoid_: Activity, Workspace Open Card, conversation dashboard
