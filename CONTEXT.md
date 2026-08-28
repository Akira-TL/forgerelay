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

**复合工作区（Composite Workspace）**：
一种与普通 Workspace 使用相同打开入口、但内部类型不同的 ForgeRelay 工作区。它可以独立存在，并由零个或多个彼此独立、具名且具有明确用途定义的成员 Workspace 组成。复合工作区不直接代表某个挂载工作目录，也不合并成员工作区的文件系统、版本控制状态、进程、钩子、技能、语言服务或活动事实。同一 Host/conversation 工作区绑定中，复合工作区与其成员 Workspace 不能同时作为顶层打开工作区存在；接手复合工作区时，成员只作为该复合工作区内部可选择的执行目标存在。
避免混用：普通 Workspace、文件同步、共享目录、远端工作区

**复合工作区成员（Composite Workspace Member）**：
复合工作区中的一个具名成员，引用一个实际 ForgeRelay Workspace，并带有在复合工作区定义时显式声明的用途说明，帮助 Host/Agent 区分不同执行环境，例如 `code`、`compute`、`dataset`。用途定义只提供 Agent-facing 语义，不产生隐式自动路由、权限或故障转移；实际文件、进程与活动事实仍属于成员引用的 Workspace 及其 Execution ForgeRelay。
避免混用：Workspace、Forge alias、设备、角色权限

**工作区接力（Workspace Relay）**：
一个锻造中继（ForgeRelay）实例把某个工作区的实际执行委托给另一个已经完成远端认证的锻造中继实例，同时保留原宿主连接和对外工作区句柄。工作区接力描述执行位置，不描述如何抵达或认证远端实例。
避免混用：远端认证（Remote Authentication）、文件同步、故障转移

**发起实例（Gateway ForgeRelay）**：
直接连接宿主（Host）、接收模型工具调用，并向模型暴露工作区句柄的锻造中继实例。对于接力工作区，它只负责路由与宿主侧呈现，不拥有远端工作区的执行事实。
避免混用：执行实例（Execution ForgeRelay）、反向代理

**执行实例（Execution ForgeRelay）**：
实际拥有接力工作区的文件系统、版本控制状态、进程、钩子、技能、语言服务以及活动审计状态的远端锻造中继实例。
避免混用：发起实例（Gateway ForgeRelay）、文件副本

**远端认证（Remote Authentication）**：
用户通过命令行（CLI）连接远端锻造中继服务的命令行认证路由，并以现有所有者令牌（owner token）换取后续模型上下文协议（MCP）访问所需访问令牌和刷新令牌的过程。`forgerelay auth` 可以通过 `--token` 显式接收所有者令牌；省略时在交互终端隐藏输入。若同时提供安全外壳链（SSH route）与 `--ssh-auth`，则最终目标机上的固定锻造中继（ForgeRelay）子命令只负责读取该机所有者令牌并通过安全外壳（SSH）的标准输出返回发起进程；发起进程随后仍通过已经建立的服务连接调用与直连完全相同的命令行认证路由。该所有者令牌只允许短暂存在于发起进程内存中，不写入参数、日志、活动审计或远端实例持久化记录。`--ssh-auth` 与 `--token` 互斥，且没有 `-J` 时不得使用。远端认证成功即建立或更新本机的远端实例记录，不再存在独立的“添加远端”步骤。
避免混用：宿主开放授权（OAuth）、工作区接力（Workspace Relay）、网络自动探测

**远端服务目标（Remote Service Target）**：
命令行（CLI）认证中唯一必需的网络目标，可写成主机与端口或完整服务地址。没有安全外壳链（SSH route）时从本机解释并直接访问；存在安全外壳链时从最终安全外壳目标机器解释，并由安全外壳端口转发（SSH Port Forwarding）映射到本机随机高位端口。
避免混用：锻造中继别名（Forge alias）、安全外壳链（SSH route）、工作区路径

**安全外壳链（SSH route）**：
`forgerelay auth` 的可选 `-J` 参数表示完整安全外壳连接链。最后一个节点是最终安全外壳目标，之前的节点按照安全外壳跳板（ProxyJump）顺序使用；只有一个节点时直接连接该节点。锻造中继只把这条链转换为系统安全外壳（SSH）的现有连接与端口转发能力，不实现自己的跳板协议。
避免混用：远端服务目标（Remote Service Target）、工作区接力（Workspace Relay）、多级锻造中继

**锻造中继别名（Forge alias）**：
发起实例本地保存的、用户可修改且在该实例内唯一的远端执行实例名称。工作区接力只通过这个名称选择目标，不暴露远端服务地址、安全外壳目标、网络拓扑或认证材料。
避免混用：安全外壳别名（SSH alias）、实例标识、工作区名称

**命令行认证路由（CLI Authentication Route）**：
锻造中继为命令行（CLI）远端认证提供的无网页认证入口。它与聊天宿主（ChatGPT）使用的开放授权（OAuth）网页流程分离，但签发的访问令牌进入同一令牌校验体系，并用于访问同一个模型上下文协议（MCP）入口。
避免混用：开放授权页面、模型上下文协议入口、接力专用端点
