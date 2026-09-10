# ForgeRelay Wiki

ForgeRelay 是一个自托管 MCP Server，让 ChatGPT、Claude 等支持 MCP 的 Host 直接使用你已经存在的开发环境：项目文件、Shell、Git、语言服务器、本地 Coding Agent，以及另一台机器上的 ForgeRelay。

Host 负责对话和推理，ForgeRelay 负责真实本地执行。普通开发默认使用现有 checkout；需要隔离时再创建 Managed Worktree。Workspace identity 可以跨 conversation 保留，远端执行和 Composite Workspace 也不会把不同机器的文件、Git 或进程状态混在一起。

> Wiki 主要面向日常使用和排障。精确配置字段、版本化协议约束与架构决策仍以主仓库 `docs/`、`CONTEXT.md` 和 ADR 为准。

## 从这里开始

| 你要做什么 | 页面 |
| --- | --- |
| 第一次安装并连接 MCP Host | [快速开始](Getting-Started) |
| 先弄清 Host、Workspace、Capability 等术语 | [核心概念](Core-Concepts) |
| 打开、恢复、关闭、删除 Workspace | [Workspace 生命周期](Workspace-Lifecycle) |
| 为并行开发创建隔离 Git worktree | [Managed Worktree](Managed-Worktrees) |
| 从另一台机器执行，或组合多个 Workspace | [远端与复合工作区](Remote-and-Composite-Workspaces) |
| 了解 MCP tools、Skills、长进程和 Activity | [ChatGPT 与 MCP 工作流](ChatGPT-and-MCP-Workflow) |
| 配置、认证和排查其他 MCP Server | [External MCP](External-MCP) |
| 给命令、文件修改或发布流程加自动规则 | [生命周期 Hooks](Lifecycle-Hooks) |
| 用 LSP 查定义、引用和 diagnostics | [代码智能](Code-Intelligence) |
| 查常用环境变量和功能开关 | [配置指南](Configuration) |
| 理解文件边界、OAuth 和 Shell 权限 | [安全模型](Security) |
| 连接、OAuth、worktree、LSP、UI 出问题 | [故障排查](Troubleshooting) |

## 几条先记住的规则

普通任务保持 checkout-first。换一个 conversation 不需要新 Workspace；真正需要并行隔离时才创建 Managed Worktree。

Workspace close 不等于 delete。Close 只是暂时停用，identity 和 Task List 等 ForgeRelay-owned state 仍然保留。

Shell 命令使用启动 ForgeRelay 的本地用户权限，不受文件工具的 Workspace path boundary 限制。只连接你信任的 Host，并只开放确实需要访问的 roots。

跨机器工作时，Execution ForgeRelay 拥有远端的文件、Git、Process、Hooks、Skills 和 Activity 状态。Composite Workspace 负责协调，不负责合并这些状态。

## 项目资源

- [ForgeRelay 主仓库](https://github.com/Akira-TL/forgerelay)
- [Releases](https://github.com/Akira-TL/forgerelay/releases)
- [Issues](https://github.com/Akira-TL/forgerelay/issues)
- [完整 Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)
- [Security Model reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/security.md)
- [Roadmap](https://github.com/Akira-TL/forgerelay/blob/main/docs/roadmap.md)
