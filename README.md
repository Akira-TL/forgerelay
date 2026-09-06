<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/forgerelay-lockup-dark.png">
    <img src="docs/assets/forgerelay-lockup-light.png" alt="ForgeRelay" width="620">
  </picture>
</p>

<p align="center">
  <strong>Use MCP coding agents on the projects and tools already on your machine.</strong><br>
  <strong>让 MCP 编程 Agent 直接使用你电脑上现有的项目和开发工具。</strong>
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@akira-tl/forgerelay"><img src="https://img.shields.io/npm/v/%40akira-tl%2Fforgerelay?style=flat-square" alt="npm"></a>
  <a href="https://github.com/Akira-TL/forgerelay/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Akira-TL/forgerelay/release.yml?style=flat-square&label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/%40akira-tl%2Fforgerelay?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <img src="docs/assets/forgerelay-ui-preview.png" alt="ForgeRelay Activity Panel" width="640">
</p>

# 中文

ForgeRelay 是一个运行在你自己机器上的 MCP Server。它解决的是一个很实际的问题：ChatGPT 这类 Host 会写代码，但默认碰不到你电脑上的项目、Shell 和 Git。

把 ForgeRelay 接上以后，Agent 就能直接在你现有的仓库里改文件、跑测试和构建、执行 Git、调用语言服务器，并继续使用你已经装好的工具链。项目不用搬到另一套工作目录，也不用为了这件事再换一套 Coding Agent。

## 安装

需要 Node.js `>=22.19 <27`、npm 和 Git。

```bash
npm install -g @akira-tl/forgerelay
forgerelay init
forgerelay serve
```

不想全局安装也可以：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

默认 MCP 地址：

```text
http://127.0.0.1:7676/mcp
```

`forgerelay init` 会让你选择允许访问的项目目录，并生成 Owner password。第一次连接 MCP Host 时，用这个密码批准客户端。

检查当前实际生效的配置和 Shell：

```bash
forgerelay doctor
```

### ChatGPT 访问不到 localhost？

如果 Host 运行在云端，需要给 ForgeRelay 一个公网 HTTPS 入口。Cloudflare Tunnel、ngrok、Tailscale Funnel 或普通反向代理都可以。

假设公网地址是：

```text
https://forge.example.com/forgerelay
```

那么 Host 连接：

```text
https://forge.example.com/forgerelay/mcp
```

`publicBaseUrl` 填到 `/mcp` 之前。更完整的 OAuth、Tunnel 和反向代理说明见 [快速开始](https://github.com/Akira-TL/forgerelay/wiki/Getting-Started)。

## 用起来是什么样

正常情况下，Agent 打开你现有的 checkout，然后直接在里面工作：

```text
open_workspace(path="~/project")
```

之后它可以读取和修改文件，也可以运行真实命令：

```text
read(path="src/server.ts")
bash(command="npm test")
bash(command="git status --short")
```

ForgeRelay 不会默认为每个任务创建 worktree。只有你明确要求隔离或并行开发时，才使用 managed worktree。

长命令也不会要求 Agent 高频轮询。命令超过当前等待窗口时会返回稳定的 `processId`，后续继续等待或中断同一个进程即可。

## 主要能力

- 文件、Shell、Git、测试、构建和项目脚本都在你的机器上运行。
- Linux / macOS 可以用 Bash、zsh、POSIX sh；Windows 原生支持 PowerShell 7、Windows PowerShell 5.1 和 `cmd.exe`。
- 同一个 checkout 会保留自己的 Workspace 身份。换一次对话，不需要重新创建工作区。
- `code.intelligence` 可以查 definition、hover、references、symbols 和 diagnostics。
- 项目里的 `AGENTS.md`、`CLAUDE.md` 和 Agent Skills 按需加载，不会每次都把整套说明重新塞进上下文。
- 需要并行开发时可以创建真实 Git worktree；集成回主分支时只接受安全的 fast-forward，不自动制造 merge conflict。
- Workspace Relay 可以把执行放到另一台 ForgeRelay；Composite Workspace 可以同时协调几个独立环境。

Lifecycle Hooks、Workspace Tasks、本地 Subagent、Activity/Audit、Checkpoint 和 Recovery 也已经包含在项目里，但第一次安装时不需要先学这些。需要哪个，再去 [Wiki](https://github.com/Akira-TL/forgerelay/wiki) 查哪个。

ForgeRelay 默认直接用现有 checkout。它不会偷偷创建 worktree、复制 Git ignored 文件、安装 Language Server，也不捆绑 Codex、Claude Code、Pi 之类的本地 Coding Agent runtime。

## 安全

ForgeRelay 给 Agent 的是真实本机执行权限，不是模拟环境。

文件工具受 Workspace 和 allowed roots 限制；Shell 命令使用启动 ForgeRelay 的本地用户权限执行，**Shell 不是 OS sandbox**。因此只连接你信任的 MCP Host，只开放确实需要的项目目录，并保护好 Owner password。

ForgeRelay 默认拒绝 elevated / administrator 启动。只有你显式选择高权限运行时才会继续，并会提示系统级修改可能不可逆。

完整边界见 [安全模型](https://github.com/Akira-TL/forgerelay/wiki/Security)。

## 文档

- [快速开始](https://github.com/Akira-TL/forgerelay/wiki/Getting-Started)
- [配置](https://github.com/Akira-TL/forgerelay/wiki/Configuration)
- [安全模型](https://github.com/Akira-TL/forgerelay/wiki/Security)
- [故障排查](https://github.com/Akira-TL/forgerelay/wiki/Troubleshooting)
- [完整 Wiki](https://github.com/Akira-TL/forgerelay/wiki)

> [!NOTE]
> ForgeRelay 是基于 MIT License 的 [Waishnav/devspace](https://github.com/Waishnav/devspace) 独立衍生项目，不是官方 DevSpace Release。原始版权与 MIT License 保留在 [LICENSE](LICENSE)，来源与修改说明见 [NOTICE.md](NOTICE.md)。

---

# English

ForgeRelay is a self-hosted MCP server for a practical gap: hosts such as ChatGPT can write code, but they do not normally have access to the projects, shells, and Git repositories on your machine.

Once ForgeRelay is connected, an Agent can edit the repository you already use, run tests and builds, execute Git, query language servers, and call your existing local toolchain. There is no separate project copy and no requirement to adopt another coding-agent runtime.

## Install

ForgeRelay requires Node.js `>=22.19 <27`, npm, and Git.

```bash
npm install -g @akira-tl/forgerelay
forgerelay init
forgerelay serve
```

Or run it without a global install:

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

The default MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

`forgerelay init` asks which project roots may be opened and generates an Owner password. Use that password to approve an MCP client on its first connection.

To see the configuration and Command Shell Runtime ForgeRelay actually resolved:

```bash
forgerelay doctor
```

### Host cannot reach localhost?

Cloud-hosted MCP clients need a public HTTPS route to ForgeRelay. Cloudflare Tunnel, ngrok, Tailscale Funnel, or a normal reverse proxy all work.

For a public base URL such as:

```text
https://forge.example.com/forgerelay
```

the MCP client connects to:

```text
https://forge.example.com/forgerelay/mcp
```

Set `publicBaseUrl` before the final `/mcp`. See [Getting Started](https://github.com/Akira-TL/forgerelay/wiki/Getting-Started) for OAuth, tunnels, and reverse-proxy setup.

## What using it looks like

For normal work, an Agent opens the checkout you already have:

```text
open_workspace(path="~/project")
```

It can then work with files and run real local commands:

```text
read(path="src/server.ts")
bash(command="npm test")
bash(command="git status --short")
```

ForgeRelay does not create a worktree for every task. Managed worktrees are for cases where you explicitly want isolation or parallel development.

Long commands do not require tight polling either. Once the current wait window expires, ForgeRelay returns a stable `processId`; later calls wait on, interact with, or interrupt that same process.

## Highlights

- Files, shells, Git, tests, builds, and project scripts run on your machine.
- Linux/macOS can use Bash, zsh, or POSIX sh. Windows has native PowerShell 7, Windows PowerShell 5.1, and `cmd.exe` support.
- Reopening the same checkout reuses the same Workspace identity instead of creating another one for every conversation.
- `code.intelligence` provides definition, hover, references, symbols, and diagnostics.
- `AGENTS.md`, `CLAUDE.md`, and Agent Skills are loaded as needed instead of being resent in full on every open.
- Managed worktrees provide real Git isolation when you ask for parallel work, with fast-forward-only finalization.
- Workspace Relay runs work on another ForgeRelay instance; Composite Workspaces coordinate several independent environments from one Host.

Lifecycle Hooks, Workspace Tasks, local Subagents, Activity/Audit, checkpoints, and recovery are included too. They are optional parts of the workflow; the [Wiki](https://github.com/Akira-TL/forgerelay/wiki) documents them when you need them.

By default, ForgeRelay works in the checkout you already have. It does not silently create worktrees, copy Git-ignored files, install Language Servers, or bundle local coding runtimes such as Codex, Claude Code, or Pi.

## Security

ForgeRelay gives an Agent real local execution capability.

Filesystem tools are constrained by the opened Workspace and configured allowed roots. Shell commands run with the authority of the local user running ForgeRelay; **the shell is not an OS sandbox**. Connect only MCP hosts you trust, expose only project roots you want an Agent to access, and keep the Owner password private.

Elevated / administrator startup is rejected by default. It only proceeds after explicit opt-in, with a warning that system-level AI-driven changes may be irreversible.

See the [Security model](https://github.com/Akira-TL/forgerelay/wiki/Security) for the full boundary.

## Documentation

- [Getting Started](https://github.com/Akira-TL/forgerelay/wiki/Getting-Started)
- [Configuration](https://github.com/Akira-TL/forgerelay/wiki/Configuration)
- [Security model](https://github.com/Akira-TL/forgerelay/wiki/Security)
- [Troubleshooting](https://github.com/Akira-TL/forgerelay/wiki/Troubleshooting)
- [Full Wiki](https://github.com/Akira-TL/forgerelay/wiki)

> [!NOTE]
> ForgeRelay is an independently maintained derivative of the MIT-licensed [Waishnav/devspace](https://github.com/Waishnav/devspace) project. It is not an official DevSpace release. The original copyright and MIT License remain in [LICENSE](LICENSE); provenance and modification details are documented in [NOTICE.md](NOTICE.md).

## Development

```bash
npm install --include=dev
npm run dev
npm run debug:accept
npm run typecheck
npm test
npm run build
```

`npm run dev` uses the 7677 debug runtime. Product port 7676 is kept separate from development acceptance.
