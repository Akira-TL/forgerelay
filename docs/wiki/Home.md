# ForgeRelay Wiki

ForgeRelay 是一个自托管的模型上下文协议（Model Context Protocol, MCP）服务器，让 ChatGPT、Claude 等支持 MCP 的宿主直接使用你机器上已经存在的项目、Git、编译器、包管理器和开发工具。

它不是模型，也不是另一套代码 Agent 界面。ForgeRelay 位于 Host 与真实开发环境之间，负责 Workspace、文件操作、Shell 进程、Git worktree、生命周期 Hook、能力发现、远端执行和本地 Subagent 等需要在本机执行的部分。

> Wiki 面向日常使用与排障。精确配置字段、协议约束、架构决策和版本化技术事实仍以主仓库中的 `docs/`、`CONTEXT.md` 与 ADR 为准。

## 从这里开始

| 你现在想做什么 | 建议阅读 |
| --- | --- |
| 第一次安装并连接 ChatGPT / MCP Host | [快速开始](Getting-Started) |
| 搞清楚 Workspace、Host、Capability 等概念 | [核心概念](Core-Concepts) |
| 恢复、关闭、删除或整理 Workspace | [Workspace 生命周期](Workspace-Lifecycle) |
| 为并行开发创建隔离 Git worktree | [Managed Worktree](Managed-Worktrees) |
| 从另一台机器执行，或组合多个执行环境 | [远端与复合工作区](Remote-and-Composite-Workspaces) |
| 理解 ChatGPT 为什么只看到一小组工具 | [ChatGPT 与 MCP 工作流](ChatGPT-and-MCP-Workflow) |
| 在命令、文件修改或发布前后自动执行规则 | [生命周期 Hooks](Lifecycle-Hooks) |
| 让 Agent 使用 LSP 做定义、引用和诊断 | [代码智能](Code-Intelligence) |
| 查常用环境变量和功能开关 | [配置指南](Configuration) |
| 了解文件边界、OAuth 和 Shell 权限 | [安全模型](Security) |
| 遇到连接、OAuth、worktree、UI 等问题 | [故障排查](Troubleshooting) |

## ForgeRelay 的工作边界

ForgeRelay 的默认策略是 **checkout-first**：普通开发直接使用你已经打开的项目目录。只有当用户明确要求隔离或并行开发时，才创建 Managed Worktree。

一个 Workspace 是持久工作身份，不是一次对话产生的临时句柄。同一个 checkout 可以被不同 Host conversation 继续复用；关闭 Workspace 也不会自动忘记它。需要真正隔离时，应创建独立 worktree，而不是为同一个目录制造多个逻辑身份。

当任务跨越多台机器时，可以先通过命令行认证远端 ForgeRelay，再通过 Workspace Relay 把实际执行委托给远端实例。需要在一个 Host 上同时协调多个独立执行环境时，可以使用 Composite Workspace，并显式选择每次操作的 member。

## 安全提示

ForgeRelay 的文件工具受 Workspace 和 allowed roots 约束，但 Shell 命令使用启动 ForgeRelay 的本地用户权限执行，**不是操作系统级沙箱**。只连接你信任的 Host，保持 Owner password 私密，并只开放真正需要的项目根目录。

继续阅读：[安全模型](Security)。

## 项目资源

- [ForgeRelay 主仓库](https://github.com/Akira-TL/forgerelay)
- [Releases](https://github.com/Akira-TL/forgerelay/releases)
- [Issues](https://github.com/Akira-TL/forgerelay/issues)
- [完整 Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)
- [Roadmap](https://github.com/Akira-TL/forgerelay/blob/main/docs/roadmap.md)
- [Security Model reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/security.md)
