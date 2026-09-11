# ChatGPT 与 MCP 工作流

ForgeRelay 把 Host 留在顶层。ChatGPT、Claude 或其他 MCP Host 负责对话、推理、计划和任务拆分；ForgeRelay 提供本地执行能力，不再套一层隐藏的自治 Agent loop。

## Core MCP surface

`minimal` 模式使用九个 canonical tools：

```text
open_workspace
close_workspace
read
write
edit
rename
delete
bash
capability
```

`full` 目前是兼容配置值，使用同一套 canonical surface。`codex` 是实验性的 Codex-shaped compatibility adapter，不定义 ForgeRelay 的长期接口。

文件和 Shell 这类高频 primitive 直接作为 Core tool。Code Intelligence、Workspace Tasks、Hook diagnostics、Checkpoint、Recovery、Subagent Session 等低频能力统一走 `capability`。

这样做的直接好处是 `tools/list` 不会随着功能增加不断膨胀，Host 也不用在每次连接时接收一堆暂时无关的 schema。

## `open_workspace` 返回什么

除了 Workspace identity，`open_workspace` 还会返回几类轻量 discovery 信息。

`capabilityFingerprint` 用来描述当前 ForgeRelay package version、tool mode 和 semantic capability names。它适合判断“运行中的 Server 实际支持什么”，但它只是 semantic feature fingerprint，不是 `capability` Gateway 的可调用 registry，也不替代 Host 自己的 `tools/list`。

`capabilityCatalog` 才是 `capability(action="describe"|"run")` 的可调用 registry，列出当前 Workspace 可用的注册 Capability，例如 `code.intelligence` 或 `workspace.tasks`。只有这里出现的 name 才能传给 `capability`。

Capability guides 则是按需加载的操作说明。Guide name 也是文档 descriptor，不是可调用 Capability。Agent 真正要使用某个领域能力时再读，不应该启动时全部预读。

## Progressive MCP context

`open_workspace(context="auto")` 会按 conversation + canonical Workspace target 记录 bootstrap delivery state，并分别追踪 AGENTS / nested instructions、Skills、Skill diagnostics、Capability guides 和 Subagent profiles 等 component。

第一次需要时返回完整 bootstrap。以后只有发生变化的 component 会再次返回；某个 component 被删除时，也会返回当前空值，让 Host 清掉旧内容。

`context="full"` 强制刷新全部 bootstrap；`context="none"` 不返回 bootstrap，也不会把尚未交付的新 fingerprint 标记为已发送。

详见 [Workspace 生命周期](Workspace-Lifecycle)。

## Host schema 还是旧的

ForgeRelay 升级后，Host 可能仍缓存旧的 MCP schema。常见情况是 `open_workspace` 已经报告新的 capability fingerprint，但 ChatGPT 当前 tool snapshot 仍缺工具或参数。

这时刷新或重连 MCP integration，让 Host 重新加载 `tools/list`。ForgeRelay 可以报告自己的实际版本和能力，但不能强制 Host 丢弃缓存。

## 项目指令

Workspace 打开时，ForgeRelay 先加载全局 system instructions，默认位置：

```text
~/.agents/AGENTS.md
```

然后读取 Workspace root 的：

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

更深目录不会在首次打开时递归扫描。Agent 第一次访问对应路径时，ForgeRelay 才沿路径发现 nested instructions。

如果副作用操作在执行前发现新的 nested instructions，ForgeRelay 会先返回规则并要求 retry，避免“先改文件，再发现这里其实有约束”。

## Agent Skills

Skill 按优先级从以下来源发现：

```text
<project>/.agents/skills
~/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

同名 Skill 只保留优先级最高的来源，因此 Project Skill 会覆盖同名的全局 Skill。

ForgeRelay 只负责发现，并把 `name + description` 暴露给 Agent。任务匹配由 Agent 自己判断；真正需要时再读取：

```text
read("skills://<name>")
```

Skill 是工作方法，不是 ForgeRelay Capability Guide。

## Subagent

启用 Subagent 后，ForgeRelay 可以发现用户定义的本地 coding-agent profile，并通过 Capability Gateway 管理持久 Subagent Session。

一个 Session 可以顺序接收多次 delegated prompt；每次具体执行叫 Run，同一 Session 同时最多一个 active execution。

Host-facing lifecycle：

```text
start
resume
status
list
stop
delete
```

provider continuation、profile 参数和运行细节以当前版本的 Subagent Capability Guide 为准。Host 仍然负责顶层任务拆分和协调。

## `bash` 和长进程

`yieldTimeMs` 只决定当前 MCP request 最多等多久拿反馈，默认 10 秒。命令超过这个窗口仍在运行时，ForgeRelay 返回稳定 `processId`；`yieldTimeMs=0` 表示立即 background handoff。

`timeoutMs` 是独立的总执行截止时间。只有显式设置它，ForgeRelay 才会在总运行时间到期后终止进程。

后续继续使用同一个 `bash`：

```text
bash(action="process", processId=...)
```

可以等待、读取增量输出、写 stdin、调整 PTY 或 interrupt。对同一进程的 follow-up 更新同一个语义 Activity，不会创建一串新的命令记录。

后台进程结束后，completion notice 可以在同一 Workspace 后续结果中交付一次。完整输出短时间保留，之后压缩成有界的 head/tail record。

## Activity Panel

Host 支持 MCP Apps UI 时，ForgeRelay 可以显示 Workspace Summary 和 Activity Panel。

Activity Panel 展示当前 Host Turn 的 ForgeRelay operations。Composite Workspace 可以聚合多个 member 的 Activity，但底层 audit facts 仍归各 member Workspace 所有。

UI 是呈现层，不是执行事实的唯一真源。

## Widget mode

```text
FORGERELAY_WIDGETS=full
FORGERELAY_WIDGETS=changes
FORGERELAY_WIDGETS=off
```

`full` 显示常规 Workspace / file / edit / Shell UI；`changes` 更偏向 aggregate change review；`off` 不返回 Widget metadata。

纯 MCP client 可以忽略这些 UI metadata，不影响 Core tools。

## 一套简单的使用顺序

先打开 Workspace 并复用 `workspaceId`。已经在 bootstrap 里的项目规则直接遵守，Capability Guide 和 Skill 只在任务需要时加载。长命令拿到 `processId` 后继续操作同一个进程，不要反复启动新命令。

Managed Worktree 只在用户明确需要隔离或并行时创建。重要 Hook result、失败原因和真实执行位置应该向用户说明，不要藏在后台流程里。

完整版本化说明见主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md)。
