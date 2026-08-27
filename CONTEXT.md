# ForgeRelay

ForgeRelay is the local development execution and control context between an MCP
host and the user's real development environment.

## Language

**Host**:
The MCP client that owns the conversation, reasoning, and top-level orchestration. ForgeRelay's product UI target is the ChatGPT Web plugin / Apps SDK Host; local MCP clients are protocol-development aids and do not replace ChatGPT Web UI acceptance.
_Avoid_: Agent runtime, ForgeRelay agent, local plugin runtime

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
One top-level Host execution cycle for project work in a selected Workspace, beginning when the Host starts handling that user input and ending when it produces its final response or the user interrupts the cycle. ForgeRelay persists the current Host Turn by Host conversation scope plus `workspaceId`. The scope prefers a Host-provided conversation identifier such as `openai/session`, then falls back to the MCP transport session, then to the current MCP connection. This keeps ordinary MCP Hosts and Inspector calls attached to the same Panel without weakening Workspace isolation; returning to an older Workspace cannot bootstrap Activity state from another Workspace in the same conversation or connection.
_Avoid_: Agent session, provider session, conversation

**ForgeRelay Panel**:
The single Host-rendered ForgeRelay view associated with one Workspace and one current Host Turn. A different Workspace identity means a different Panel. The Panel keeps Workspace Summary visible above a separately collapsible Activity Panel.
_Avoid_: Workspace Lifecycle App, conversation dashboard, generic tool card

**Workspace Summary**:
The always-visible Workspace context portion of a ForgeRelay Panel. It identifies the selected Workspace and presents the project context relevant to operating in it.
_Avoid_: Workspace Lifecycle App, Activity Panel, workspace selector

**Activity**:
One semantic top-level ForgeRelay operation performed during a Host Turn. Follow-up control calls for the same operation, such as polling a running Bash process, update the existing Activity rather than creating additional Activities.
_Avoid_: RPC call, log line, Hook execution

**Activity Panel**:
The collapsible Activity portion of a ForgeRelay Panel for one Host Turn. It appears only after that Host Turn has at least one Activity; an empty Host Turn has no Activity section or activation indicator. It presents ForgeRelay-owned Activity state but is not an independent App identity or the source of that state.
_Avoid_: Activity, ForgeRelay Panel, conversation dashboard, generic tool card

**Audit Event**:
An immutable local record of one execution fact observed by ForgeRelay, such as an Activity starting, returning control, failing, or a background process later completing.
_Avoid_: Activity, Activity Record, UI event

**Activity Record**:
The queryable representation of one Activity derived from its Audit Events, including the state and detail needed for inspection without making the Activity Panel authoritative.
_Avoid_: Audit Event, Activity Panel, tool response

**工作区接力（Workspace Relay）**：
一个锻造中继（ForgeRelay）实例把某个工作区的实际执行委托给另一个已建立实例信任的锻造中继实例，同时保留原宿主连接和对外工作区句柄。工作区接力描述执行位置，不描述认证方式。
避免混用：实例信任（Forge Trust）、文件同步、故障转移

**发起实例（Gateway ForgeRelay）**：
直接连接宿主（Host）、接收模型工具调用，并向模型暴露工作区句柄的锻造中继实例。对于接力工作区，它只负责路由与宿主侧呈现，不拥有远端工作区的执行事实。
避免混用：执行实例（Execution ForgeRelay）、反向代理

**执行实例（Execution ForgeRelay）**：
实际拥有接力工作区的文件系统、版本控制状态、进程、钩子、技能、语言服务以及活动审计状态的受信锻造中继实例。
避免混用：发起实例（Gateway ForgeRelay）、文件副本

**实例信任（Forge Trust）**：
两个锻造中继实例之间预先建立的、有方向的机器认证关系。实例信任由用户通过命令行（CLI）和安全外壳（SSH）建立或撤销；模型只能选择已经存在的受信目标，不能提供网络地址或认证秘密。一次实例信任只授权一个调用方向，反向调用需要单独建立另一条信任关系。
避免混用：开放授权（OAuth）、工作区接力（Workspace Relay）、宿主会话

**安全外壳目标（SSH target）**：
用户在建立或维护实例信任时交给本机安全外壳（SSH）客户端解析的连接目标，可以是安全外壳配置中已有的主机别名，也可以是显式的用户名与主机组合。它只用于建立和维护实例信任，不作为模型选择远端实例的长期标识。
避免混用：锻造中继别名（Forge alias）、执行实例（Execution ForgeRelay）

**锻造中继别名（Forge alias）**：
发起实例本地保存的、用户可修改且在该实例内唯一的受信执行实例名称。工作区接力只通过这个名称选择目标，不暴露安全外壳目标、跳板链、网络地址或认证材料。若用户通过一个适合作为名称的安全外壳别名建立信任且未显式指定锻造中继别名，可默认复用该名称。
避免混用：安全外壳别名（SSH alias）、实例标识、工作区名称
