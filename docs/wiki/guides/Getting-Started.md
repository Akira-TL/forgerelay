# 快速开始

这篇页面用于第一次安装 ForgeRelay，并把 ChatGPT、Claude 或其他支持模型上下文协议（Model Context Protocol, MCP）的 Host 连接到本机开发环境。

## 1. 准备环境

ForgeRelay 需要：

- Node.js `>=22.19 <27`
- npm
- Git
- Bash 兼容 Shell
- 当 Host 无法直接访问 localhost 时，一个由你自行管理的公网 HTTPS 入口

Linux 和 macOS 可以直接使用系统常见 Bash 环境。Windows 需要 Git Bash、WSL、MSYS2 或 Cygwin Bash；仅有 PowerShell 或 `cmd.exe` 还不够。

## 2. 安装

全局安装：

```bash
npm install -g @akira-tl/forgerelay
```

也可以不全局安装，直接通过 `npx` 使用：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

## 3. 初始化配置

运行：

```bash
forgerelay init
```

初始化流程会要求你选择：

- 允许打开的项目根目录；
- 本地监听端口，默认 `7676`；
- 公网访问地址（如果需要）；
- 可选的路由前缀。

新安装默认使用：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

`auth.json` 包含 Owner password，请像凭据一样保护它。

### Allowed roots 怎么选

只开放你确实希望 MCP Host 操作的目录，例如：

```text
~/personal,~/work
```

不要仅仅为了省事把整个 Home 目录开放，除非这就是你明确希望建立的访问边界。

## 4. 启动 ForgeRelay

```bash
forgerelay serve
```

默认本地 MCP 地址：

```text
http://127.0.0.1:7676/mcp
```

如果 Host 能直接访问这个地址，就可以直接配置该 MCP endpoint。

## 5. Host 无法访问 localhost 时

ForgeRelay 不负责创建公网 Tunnel。你可以使用 Cloudflare Tunnel、ngrok、Pinggy、Tailscale Funnel 或自己的 HTTPS reverse proxy，把公网请求转发到：

```text
http://127.0.0.1:7676
```

假设公网基础地址是：

```text
https://forge.example.com/forgerelay/main
```

那么 MCP Host 应连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

注意：配置中的 `publicBaseUrl` **不要包含最后的 `/mcp`**。

ForgeRelay 也允许配置多个公网入口。第一个是 canonical URL，其余入口仍会参与 Host allowlist 和 MCP App 资源配置。

## 6. 完成 OAuth 授权

Host 第一次连接时，ForgeRelay 会显示 Owner-password OAuth 授权页面。输入 `forgerelay init` 生成的 Owner password 即可批准该客户端。

默认允许的 OAuth redirect host 包括：

```text
chatgpt.com
localhost
127.0.0.1
```

如果使用其他 MCP Host，可以通过配置扩展 redirect host allowlist。

## 7. 运行自检

```bash
forgerelay doctor
```

`doctor` 会报告实际解析到的：

- 配置目录；
- Node、Git、Bash 和平台环境；
- public URL 与 allowed hosts；
- SQLite 原生依赖；
- MCP tool mode；
- widget mode；
- artifact、subagent、Skill 等可选功能状态。

连接失败时，先看这里通常比直接改配置更有效。

## 8. 第一次打开项目

正常开发直接打开 checkout：

```text
open_workspace(path="~/project")
```

ForgeRelay 会返回稳定的 `workspaceId`，后续文件、Shell 和 Capability 操作都继续使用这个 ID。

默认不会偷偷创建 worktree。只有当你明确要求“隔离开发”“并行开发”或类似需求时，才应该使用：

```text
open_workspace(path="~/project", mode="worktree")
```

继续阅读：[核心概念](Core-Concepts) 和 [Workspace 生命周期](Workspace-Lifecycle)。

完整字段见主仓库的 [Setup Guide](https://github.com/Akira-TL/forgerelay/blob/main/docs/setup.md) 与 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)。
