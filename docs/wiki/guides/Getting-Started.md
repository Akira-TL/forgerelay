# 快速开始

这页只做一件事：把 ForgeRelay 安装好，并让一个支持 MCP 的 Host 连到你的本机开发环境。

## 1. 准备环境

ForgeRelay 需要 Node.js `>=22.19 <27`、npm、Git 和一个受支持的 Command Shell Runtime。

Linux / macOS 主要以 Bash 作为 POSIX compatibility target，也可以显式选择 zsh 或 POSIX sh。Windows 原生支持 PowerShell 7 (`pwsh`)、Windows PowerShell 5.1 (`powershell.exe`) 和 `cmd.exe`。Git Bash、WSL、MSYS2、Cygwin Bash 仍可以作为 Bash 兼容路径。

公共 Core tool 名始终叫 `bash`，但真正的命令语言以 `open_workspace.executionContext` 和 `forgerelay doctor` 报告的 runtime 为准。

如果 Host 不能访问 localhost，还需要一个你自己管理的公网 HTTPS 入口。

## 2. 安装

全局安装：

```bash
npm install -g @akira-tl/forgerelay
```

不想全局安装也可以直接用 `npx`：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

## 3. 初始化

```bash
forgerelay init
```

初始化时会配置 allowed roots、监听端口、可选的公网地址和路由前缀，也会让你选择 Command Shell Runtime 以及其他可选能力。

新安装默认写入：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

`auth.json` 包含 Owner password，把它当凭据保存。

### Allowed roots

只开放你确实希望 MCP Host 操作的目录，例如：

```text
~/personal,~/work
```

除非你明确希望 Host 能访问整个 Home，否则不要为了省事直接开放它。

## 4. 启动

```bash
forgerelay serve
```

默认本地 MCP 地址：

```text
http://127.0.0.1:7676/mcp
```

Host 能直接访问这个地址时，配置到这里就够了。

## 5. Host 访问不到 localhost

ForgeRelay 不负责创建公网 Tunnel。可以用 Cloudflare Tunnel、ngrok、Pinggy、Tailscale Funnel 或自己的 HTTPS reverse proxy，把请求转到：

```text
http://127.0.0.1:7676
```

假设公开基础地址是：

```text
https://forge.example.com/forgerelay/main
```

Host 应连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

`publicBaseUrl` 不要包含最后的 `/mcp`。

可以配置多个公网入口。第一个作为 canonical URL，其余入口仍会进入 Host allowlist 和 MCP App 资源配置。

## 6. OAuth 授权

Host 第一次连接时，ForgeRelay 会显示 Owner-password OAuth 授权页面。输入 `forgerelay init` 生成的 Owner password 批准客户端。

默认 OAuth redirect host 包括：

```text
chatgpt.com
localhost
127.0.0.1
```

其他 MCP Host 可以通过配置扩展 redirect host allowlist。

## 7. 运行自检

```bash
forgerelay doctor
```

`doctor` 会显示实际解析后的配置目录、Node / Git / 平台信息、runtime privilege、Command Shell Runtime、public URL、allowed hosts、SQLite 原生依赖、tool mode、widget mode，以及 artifact、subagent、Skills 等可选能力状态。

连接有问题时，先看 `doctor`，再决定要改哪项配置。

## 8. 第一次打开项目

普通开发直接打开 checkout：

```text
open_workspace(path="~/project")
```

ForgeRelay 会返回稳定的 `workspaceId`。后续文件、Shell 和 Capability 操作继续复用这个 ID。

默认不会自动创建 worktree。只有你明确需要隔离或并行开发时才使用：

```text
open_workspace(path="~/project", mode="worktree")
```

接下来可以看 [核心概念](Core-Concepts) 和 [Workspace 生命周期](Workspace-Lifecycle)。完整字段见主仓库 [Setup Guide](https://github.com/Akira-TL/forgerelay/blob/main/docs/setup.md) 与 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)。
