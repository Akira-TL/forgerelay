# 核心概念

ForgeRelay 的概念并不多，但几个边界最好先分清：谁负责推理、Workspace 是什么、命令到底在哪台机器执行，以及哪些状态会长期保留。

## Host

Host 是 MCP 客户端，例如 ChatGPT。它负责对话、推理和顶层编排。

ForgeRelay 不接管这部分。Host 决定做什么，ForgeRelay 提供本地能力并返回真实执行状态。

## ForgeRelay Server

ForgeRelay Server 运行在用户机器上，把 Workspace、文件、Shell、Git、Hooks、Capabilities、Activity 和远端执行能力暴露给 Host。

Shell 命令使用启动 ForgeRelay 的本地账户权限，所以这个账户本身就是安全边界的一部分。

## Workspace

Workspace 是持久工作身份，可以对应：

- 现有 checkout；
- ForgeRelay 管理的 Git worktree；
- Composite Workspace。

Conversation 会使用 Workspace，但 conversation 不是 Workspace。同一个 canonical checkout 正常只对应一个 checkout Workspace；不同会话再次打开同一目录时，可以继续得到同一个 `workspaceId`。

真正需要并行隔离时，创建 Managed Worktree，而不是为同一个目录制造多个逻辑 Workspace。

## Closed Workspace

Close 和 delete 是两件事。

Closed Workspace 暂时不能执行普通文件或进程操作，但 `workspaceId` 和 ForgeRelay-owned durable state 仍然保留。之后再次 `open_workspace` 可以重新激活它。

只有显式 delete 才会永久删除 ForgeRelay 保存的 Workspace identity。对于普通 checkout，delete 不会删除用户项目目录。

## Managed Worktree

Managed Worktree 是 ForgeRelay 为隔离或并行开发创建的 branch-backed Git worktree。

它不是沙箱，也不是 Workspace identity 本身。物理 worktree 只是 Workspace 的 execution backing；安全 close 后可以被清理，而 Workspace identity 继续保留。

详见 [Managed Worktree](Managed-Worktrees)。

## Composite Workspace

Composite Workspace 用来在一个 Host context 中协调多个独立 Workspace。它没有虚构的统一文件系统 root。

例如可以有 `code` 和 `compute` 两个 member：前者是本机源码 checkout，后者是远端 GPU Workspace。成员仍然各自拥有文件、Git、进程、Hooks、Skills、Language Service 和 Activity 状态。

每次执行都要显式指定 member。ForgeRelay 不会根据 tool type 或 purpose 自动猜路由。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Workspace Relay

Workspace Relay 表示 Gateway ForgeRelay 把某个 Workspace 的实际执行交给另一个已认证的 Execution ForgeRelay。

Relay 解决“在哪里执行”。认证方式、SSH route 和 Forge alias 是建立远端连接时的另一层配置。

## Core tool surface

ForgeRelay 长期保留九个 Core MCP tools：

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

不常用的功能通过 Capability Gateway 暴露，而不是不断增加顶层工具。

## Capability

Capability 是 ForgeRelay 自己提供、但不需要长期占据顶层 tool schema 的能力，例如 Code Intelligence、Hook 检查、Workspace Tasks、Checkpoint 或 Subagent Session。

`open_workspace` 返回轻量 discovery 信息。Agent 只有在任务需要时才读取对应 guide。

## Capability Guide 与 Agent Skill

Capability Guide 和 Agent Skill 的来源不同。

Capability Guide 随 ForgeRelay 版本发布，用来说明某项 ForgeRelay Capability 的操作契约。Agent Skill 则来自用户、项目或 Agent 环境，描述某类任务应该怎样完成。

简单说：Guide 解释产品能力，Skill 解释工作方法。

## Host Turn、Activity 与 Activity Panel

Host Turn 是 Host 处理一次用户输入的顶层执行周期。

Activity 表示这个 Turn 中的一次语义操作。对同一个长 Bash 进程继续等待、写输入或中断，会更新同一个 Activity，而不是制造一串彼此无关的记录。

Activity Panel 只是这些状态的 UI 展示，持久事实仍由 ForgeRelay 的 Activity / Audit 数据维护。

## Task List 与 Task

Workspace Task List 是 ForgeRelay 私有 state 里的轻量持久清单，用来保存后面还要继续做的事情和当前进度。

它不是执行队列，也不会自动绑定 Subagent、进程、worktree 或调度器。Task 不写进项目 working tree，所以 Workspace close 或 Managed Worktree finalize 后仍然可以保留。

详见 [Workspace 生命周期](Workspace-Lifecycle)。

## Subagent Session 与 Run

Subagent Session 是可继续使用的本地 Agent 执行身份；Run 是这个 Session 中一次具体 prompt 的执行。

某个 Run 可以完成、失败、取消或中断，不代表整个 Session 必须被删除。Host 仍然负责顶层编排，ForgeRelay 负责生命周期和执行归属。

## 继续阅读

- [Workspace 生命周期](Workspace-Lifecycle)
- [ChatGPT 与 MCP 工作流](ChatGPT-and-MCP-Workflow)
- [安全模型](Security)

更严格的术语定义见主仓库 [`CONTEXT.md`](https://github.com/Akira-TL/forgerelay/blob/main/CONTEXT.md)。
