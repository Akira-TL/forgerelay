# ChatGPT 与 MCP 工作流

ForgeRelay 的 MCP 设计目标是让 Host 保持顶层 orchestrator，同时把本地执行能力做成稳定、可检查、按需展开的接口。

## Host 负责什么

ChatGPT、Claude 或其他 MCP Host 负责：

- 用户对话；
- 推理和计划；
- 选择什么时候调用 ForgeRelay；
- 组合本地能力与 Host 自己的联网、记忆或其他功能；
- 决定是否委派 Subagent。

ForgeRelay 不把这些流程重新包进一个隐藏自治 Agent。

## Core MCP surface

普通 `minimal` 模式暴露稳定的 Core tool：

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

`full` 当前是兼容配置值，与 `minimal` 使用相同的 canonical 9-tool surface。

`codex` 是实验性的 Codex-shaped compatibility adapter，不定义 ForgeRelay 的长期 canonical interface。

## 为什么没有一大堆顶层工具

ForgeRelay 把“高频执行 primitive”和“低频领域能力”分开。

例如日常文件和 Shell 操作保持为 Core tool；LSP code intelligence、Workspace Tasks、Hook diagnostics 等低频能力通过单一 `capability` gateway 暴露。

这样可以避免 `tools/list` 随功能增长不断膨胀，也避免模型每次连接都接收大量暂时无关的 schema。

## `open_workspace` 的 Capability discovery

打开 Workspace 时，ForgeRelay 会返回几类轻量信息：

### `capabilityFingerprint`

包含：

- ForgeRelay package version；
- 当前 tool mode；
- 稳定的 semantic capability names。

它适合判断“运行中的 Server 实际支持什么”，而不是替代 `tools/list`。

### `capabilityCatalog`

列出当前 Workspace 可用的注册 Capability，例如 `code.intelligence`、`workspace.tasks` 或 Hook 检查能力，以及必要的 compact metadata。

### `capabilityGuides`

列出 ForgeRelay 随版本提供的领域操作指南。Agent 应在任务真正需要该领域时才通过 `read` 加载，而不是预读全部 Guide。

## Progressive MCP context

ForgeRelay 的 bootstrap 也采用 progressive disclosure。

`context="auto"` 会为 conversation + canonical Workspace target 记录整体 `contextFingerprint`，同时分别记录 AGENTS/nested instructions、Skills、Skill diagnostics、Capability guides 和 Subagent profiles 等 bootstrap component 的 fingerprint。首次需要时仍返回完整 bootstrap；之后只返回发生变化的 component，不会因为一处 AGENTS 或 Skill 变化把其他未变内容整包重发。

component 内容被删除时，下一次 `auto` 会返回该 component 的当前空数组，让 Host 明确清除旧状态。`context="full"` 强制返回全部 component；`context="none"` 不返回 bootstrap，也不会把尚未交付的新 component fingerprint 标记为已交付。

详见 [Workspace 生命周期](Workspace-Lifecycle)。

## Host schema 过旧怎么办

有时运行中的 ForgeRelay 已经升级，但 Host 仍缓存旧的 MCP `tools/list`。

典型表现：

- `open_workspace` 的 `capabilityFingerprint` 显示新 semantic capability；
- 但 ChatGPT 当前 tool snapshot 仍缺少对应 Core tool 或旧 schema。

这时应刷新/重连 MCP integration，或开启能重新加载 `tools/list` 的 Host context。不要因为 Host 缓存旧 schema，就判断 Server 没有这个功能。

ForgeRelay 可以报告自己的版本和能力，但不能强制 Host 丢弃缓存。

## 项目指令如何加载

Workspace 打开时，ForgeRelay 先加载一个全局 system-instructions 文件，默认：

```text
~/.agents/AGENTS.md
```

随后加载 Workspace root 的：

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

更深目录的项目指令不会在打开 Workspace 时递归扫描整棵目录树，而是在 Agent 首次访问对应路径时按路径懒加载。

如果一个 side-effecting 文件工具或 Shell 操作在执行前发现新的 nested instructions，ForgeRelay 会先返回这些规则并要求 Agent retry，避免先修改、后知道约束。

## Agent Skills

ForgeRelay 可以发现标准 Agent Skill，例如来自：

```text
~/.agents/skills
<project>/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

Skill 是 Agent 工作方法，不等于 ForgeRelay Capability Guide。

当任务与 advertised Skill 匹配时，Agent 应先读取该 Skill 的 `SKILL.md`，再按其流程工作。

## Subagent

启用 Subagent 后，ForgeRelay 可以发现用户定义的本地 coding-agent profile，并通过 Capability Gateway 管理持久 Subagent Session。

一个 Session 可以接收多次顺序 delegated prompt；每次具体执行是一个 Run，同一 Session 同时最多有一个 active execution。

Host-facing lifecycle 包括：

```text
start
resume
status
list
stop
delete
```

具体 provider continuation、profile 和参数由运行版本的 `subagents` Capability Guide 定义。

Subagent 不取代 Host。Host 仍然负责顶层任务拆分和协调。

## `bash` 的长进程模型

ForgeRelay 不要求 Agent 用高频轮询等待长命令。

### 初次运行

`yieldTimeMs` 决定这一次 MCP request 最多等待多久拿反馈，默认 10 秒。

如果命令还在运行，结果返回稳定 `processId`。`yieldTimeMs=0` 是明确的 background handoff。

### 总执行截止时间

`timeoutMs` 与 `yieldTimeMs` 独立。只有显式设置 `timeoutMs` 时，ForgeRelay 才会在总运行时间达到上限后终止进程。

### 后续控制

继续使用同一个 `bash`：

```text
bash(action="process", processId=...)
```

可以：

- 等待/读取增量输出；
- 写 stdin；
- 调整 PTY；
- 显式 interrupt。

同一 process follow-up 更新同一个语义 Activity，而不是创建一串新 Activity。

### 完成通知

已经后台 handoff 的进程完成后，可以在同一 Workspace 的后续 tool result 中一次性携带 completion notice。完整输出在短时间内保留，随后压缩为有界 head/tail completion record。

## ForgeRelay Panel 与 Activity Panel

当 Host 支持 MCP Apps UI 时，ForgeRelay 可以提供 Workspace Summary 和 Activity Panel。

Workspace Summary 表示当前选择的 Workspace；Activity Panel 展示当前 Host Turn 中的 ForgeRelay operations。

Activity 是执行事实的语义表示。UI 只是呈现层，不是持久状态的唯一真源。

对于 Composite Workspace，Panel 可以聚合多个 member 的 Activity 展示，但底层 audit facts 仍归各 member Workspace 所有。

## Widget mode

常见配置：

```text
FORGERELAY_WIDGETS=full
FORGERELAY_WIDGETS=changes
FORGERELAY_WIDGETS=off
```

- `full`：正常 Workspace/file/edit/Shell UI；
- `changes`：把 UI 重点放在 aggregate change review；
- `off`：关闭 Widget metadata。

纯 MCP client 可以忽略 MCP App UI metadata，而不影响基础 Core tool 使用。

## 推荐的 Agent 工作方式

1. 先 `open_workspace`，复用返回的 Workspace identity；
2. 读取 bootstrap 中已经提供的项目规则；
3. 只有任务需要时才加载 Capability Guide / Skill；
4. 日常 inspection 使用文件工具和 `bash`，不要为低频行为扩展常驻 schema；
5. 长命令拿到 `processId` 后复用该进程，不要不断启动新命令；
6. 只有用户明确需要并行隔离时才创建 worktree；
7. 重要 Hook result、失败和执行位置要向用户明确呈现。

完整版本化说明见主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md)。
