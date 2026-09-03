# 核心概念

ForgeRelay 的设计重点不是增加更多 Agent 工具，而是把 **Host、Workspace、执行位置和本地权限边界** 表达清楚。理解下面几个概念，后面的工作流会简单很多。

## Host

Host 是拥有对话、推理和顶层编排权的 MCP 客户端，例如 ChatGPT。

ForgeRelay 不接管 Host 的对话，也不把整个工作流藏进另一个不可观察的 Agent loop。Host 决定要做什么，ForgeRelay 提供明确的本地能力和执行状态。

## ForgeRelay Server

ForgeRelay Server 是运行在用户机器上的 MCP 服务。它负责把 Workspace、文件、Shell、Git、Hook、Capability、Activity 和远端执行等本地能力暴露给 Host。

Shell 命令使用启动 ForgeRelay 的本地用户权限执行，因此 Server 所在账户本身就是重要安全边界。

## Workspace

Workspace 是一个**持久工作身份**。它可以代表：

- 一个现有 checkout；
- 一个 ForgeRelay 管理的 Git worktree；
- 一个 Composite Workspace。

Host conversation 绑定并复用 Workspace，但 conversation 本身不是 Workspace。

同一个 canonical checkout 正常只对应一个 checkout Workspace。不同会话再次打开同一目录时，可以继续得到相同的 `workspaceId`。如果真的需要并行隔离，应创建不同的 Managed Worktree。

## Closed Workspace

关闭 Workspace 不等于删除。

Closed Workspace 暂时不能执行普通文件或进程操作，但它仍保留自己的身份和 ForgeRelay 持久协调状态。之后再次 `open_workspace` 可以重新激活同一个 Workspace。

真正永久移除 ForgeRelay-owned Workspace 状态的是显式 delete 生命周期。对于普通 checkout，删除 Workspace 身份也不会删除用户项目目录。

## Managed Worktree

Managed Worktree 是 ForgeRelay 为隔离或并行开发创建并管理的 branch-backed Git worktree。

它不是沙箱，也不是 Workspace 身份本身。物理 worktree 只是这个持久 Workspace 的执行 backing；关闭时可以被安全 finalize 和清理，而 Workspace 身份仍然保留并可在以后重新创建 backing。

详见 [Managed Worktree](Managed-Worktrees)。

## Composite Workspace

Composite Workspace 是一个没有虚构文件系统 root 的顶层工作身份，用来同时协调多个独立 Workspace。

每个成员（member）都有名称和用途说明，例如：

- `code`：本机源码 checkout；
- `compute`：远端 GPU 工作区；
- `dataset`：另一台数据机器。

成员仍然各自拥有文件、Git、进程、Hook、Skill、语言服务和 Activity 事实。Composite 只统一 Host-facing 上下文，不把这些执行事实混在一起。

ForgeRelay 不会根据工具类型或 member purpose 自动路由；每次执行必须明确指定 member。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Workspace Relay

Workspace Relay 表示一个 Gateway ForgeRelay 把某个 Workspace 的实际执行委托给另一个已认证的 Execution ForgeRelay。

Relay 描述“在哪里执行”，不描述“如何认证和到达”。远端认证、SSH route 和 Forge alias 是建立这个路由前需要处理的独立概念。

## Core tool surface

ForgeRelay 日常保留一小组稳定的 Core MCP tool，例如：

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

低频功能不会全部变成顶层工具，而是通过 Capability catalog 和单一 `capability` gateway 渐进式暴露。

## Capability

Capability 是 ForgeRelay 拥有、但不需要长期占据顶层 MCP tool surface 的能力，例如代码智能、Hook 检查、Task List 或其他可选功能。

`open_workspace` 会返回轻量的 Capability 发现信息；Agent 只在当前任务需要时读取对应 Capability guide，而不是每次连接都加载全部规则。

## Capability Guide 与 Agent Skill

二者不是一回事：

- **Capability Guide**：ForgeRelay 随版本提供，用于解释 ForgeRelay 自己某项 Capability 的正确操作契约；
- **Agent Skill**：来自用户、项目或 Agent 环境的可复用工作方法，描述某类任务应该如何完成。

Capability Guide 属于产品能力文档；Skill 属于 Agent 工作流扩展。

## Host Turn、Activity 与 Activity Panel

一个 Host Turn 是 Host 处理一次用户输入并产生最终响应的顶层执行周期。

Activity 是这个 Turn 中一次语义上的 ForgeRelay 操作。对同一个长 Bash 进程继续等待、写输入或中断，仍然更新同一个 Activity，而不是制造一串互不相关的操作。

Activity Panel 是 Host 中用于展示这些 Activity 状态的 UI。它是执行事实的呈现层，不是事实本身的持久真源。

## Task List 与 Task

Task List 是一个 Workspace 拥有的轻量持久清单。它用于保存 Agent 后续仍需要记住的工作要求和进度，不是执行队列，也不自动绑定 Subagent、进程、worktree 或调度器。

Task 状态保存在 ForgeRelay 自己的 Workspace state 中，不写入项目 Git working tree，因此关闭 Workspace 或 finalize Managed Worktree 后仍然可以保留。

详见 [Workspace 生命周期](Workspace-Lifecycle)。

## Subagent Session 与 Run

Subagent 是通过本地 provider/runtime 执行的有边界工作者。

一个 Subagent Session 表示可继续使用的持久执行身份；一个 Run 则是 Session 中某一次具体 prompt 的执行。Run 可以成功、失败、取消或中断，而不必删除整个 Session。

Host 仍然是顶层 orchestrator，ForgeRelay 只提供生命周期和执行归属。

## 推荐继续阅读

- [Workspace 生命周期](Workspace-Lifecycle)
- [ChatGPT 与 MCP 工作流](ChatGPT-and-MCP-Workflow)
- [安全模型](Security)

规范术语的完整定义见主仓库 [`CONTEXT.md`](https://github.com/Akira-TL/forgerelay/blob/main/CONTEXT.md)。
