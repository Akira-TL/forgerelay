# ForgeRelay

**Give MCP coding agents a real local workspace.**

**让 MCP 编码 Agent 真正接入你的本地开发环境。**

[中文](#中文) · [English](#english)

[![npm](https://img.shields.io/npm/v/%40akira-tl%2Fforgerelay?style=flat-square)](https://www.npmjs.com/package/@akira-tl/forgerelay)
[![Release](https://img.shields.io/github/actions/workflow/status/Akira-TL/forgerelay/release.yml?style=flat-square&label=release)](https://github.com/Akira-TL/forgerelay/actions/workflows/release.yml)
[![License](https://img.shields.io/npm/l/%40akira-tl%2Fforgerelay?style=flat-square)](LICENSE)

---

# 中文

ForgeRelay 是一个自托管 MCP Server，让 ChatGPT 和其他支持 MCP 的 Host 可以直接在你现有的开发环境中工作：读取和修改文件、运行命令、操作 Git、使用 LSP、管理 Workspace、创建隔离 worktree、调用本地 Subagent，并通过 Relay / Composite Workspace 跨设备协作。

它不是模型，也不是另一套 Coding Agent UI。ForgeRelay 的职责是把 **Host 的推理能力** 和 **你机器上的真实开发工具** 连接起来。

你的项目仍然留在原来的目录里，继续使用你已经安装的编译器、包管理器、Git、Shell、SSH、语言服务器和本地凭据。

> [!NOTE]
> ForgeRelay 是基于 MIT License 的 [Waishnav/devspace](https://github.com/Waishnav/devspace) 独立维护的衍生项目，不是官方 DevSpace Release。原始版权与 MIT License 保留在 [LICENSE](LICENSE)，详细来源与修改说明见 [NOTICE.md](NOTICE.md)。

## 为什么使用 ForgeRelay

ForgeRelay 重点解决的是“让远端或 Host 内的 AI 安全、稳定、低上下文成本地使用真实本地开发环境”，而不是再造一套 Agent Runtime。

它提供：

- **持久 Workspace**：同一个 checkout / managed worktree 会复用稳定的 Workspace identity；关闭不等于删除。
- **真实文件与命令执行**：Agent 可以在允许的项目根目录内读写文件，并使用你选择的真实 Command Shell Runtime。
- **跨平台 Shell**：Linux / macOS 支持 Bash、zsh、POSIX sh；Windows 原生支持 PowerShell 7、Windows PowerShell 5.1 和 `cmd.exe`。
- **Git 与 managed worktree**：需要隔离或并行开发时才创建 `forgerelay/*` branch-backed worktree，并提供安全的 close / finalize 生命周期。
- **LSP Code Intelligence**：通过 `code.intelligence` 提供 definition、hover、references、symbols 和 diagnostics，而不增加一组语言专用 MCP tools。
- **Agent Skills**：Workspace 打开时只向 Agent 暴露已发现 Skill 的 `name + description`，Agent 匹配到任务后再通过 `read("skills://<name>")` 按需加载正文。
- **渐进式 Capability 披露**：常用 Core tools 保持稳定，低频能力通过 Capability Gateway 和按需 guide 暴露，避免 MCP 首次加载越来越臃肿。
- **Workspace Tasks**：为跨 Host Turn / 跨会话的长任务保存轻量、持久的 Workspace-owned Task Lists。
- **Subagent Session**：可调用用户已经安装并配置的本地 Coding Agent Runtime；ForgeRelay 不捆绑这些执行器。
- **Workspace Relay**：通过另一个 ForgeRelay 实例执行远端 Workspace 操作，支持直连或 SSH 路由。
- **Composite Workspace**：把多个本地 / 远端 Workspace 组合到一个 Host-facing 工作上下文，同时保持各成员自己的文件、Git、Shell、Hook、Skill、Process 和 Audit 所有权。
- **Activity / Audit**：持久记录语义操作和 Bash 输出，并可通过 MCP App Activity Panel 展示当前 Host Turn。
- **Lifecycle Hooks**：在 Workspace、tool、文件变化、worktree close 和 Subagent 生命周期上执行用户定义的自动规则。
- **Recovery / Checkpoint / Maintenance**：支持 managed-worktree recovery、持久 Workspace checkpoint、安全 restore，以及显式授权的历史状态维护。

ForgeRelay 默认使用你现有的 checkout。只有你明确要求隔离或并行工作时，才应该创建 managed worktree。

## 快速开始

要求：

- Node.js `>=22.19 <27`
- npm
- Git
- 一个受支持的 Command Shell Runtime

全局安装：

```bash
npm install -g @akira-tl/forgerelay
```

初始化并启动：

```bash
forgerelay init
forgerelay serve
```

也可以直接使用 `npx`：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

默认本地 MCP endpoint：

```text
http://127.0.0.1:7676/mcp
```

检查当前运行环境：

```bash
forgerelay doctor
```

## 从公网 Host 连接

如果 MCP Host 无法访问你的 localhost，可以把 ForgeRelay 放在 HTTPS reverse proxy 或 tunnel 后面，例如 Cloudflare Tunnel、ngrok、Pinggy、Tailscale Funnel，或者你自己的反向代理。

`forgerelay init` 会区分：

- **Direct LAN**：绑定 `0.0.0.0`
- **HTTPS reverse proxy / tunnel**：绑定 `127.0.0.1`，只信任 loopback proxy

例如公开入口为：

```text
https://example.com/forgerelay/main
```

则 MCP Host 使用：

```text
https://example.com/forgerelay/main/mcp
```

ForgeRelay 使用 Owner-password OAuth approval。新安装默认配置位于：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

请保护好 `auth.json` 和 Owner password。

## MCP 接口设计

ForgeRelay 的长期 Core tool surface 保持小而稳定：

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

低频能力，例如 Code Intelligence、Hooks 检查、Workspace Tasks、Checkpoint、Recovery 和 Subagent Session，通过 Capability Gateway 按需提供，而不是不断新增顶层 MCP tools。

`open_workspace(context="auto")` 只在项目上下文发生变化时补充新的 AGENTS / CLAUDE instructions、Skills、Capability guides、profiles 或 diagnostics；不会在每次调用时重复塞入完整上下文。

## Skills

ForgeRelay 会从配置的 Skill 目录发现 Skill，但不会替 Agent 做语义匹配，也不会自动把 Skill 正文注入上下文。

流程是：

```text
用户任务
  ↓
Agent 看到 Skill name + description
  ↓
Agent 判断任务是否匹配
  ↓
read("skills://<name>")
  ↓
Skill activated
  ↓
允许继续读取该 Skill 内部资源
```

旧的 `disable-model-invocation` frontmatter 不再用于隐藏 Skill；发现到的 Skill 都保持 model-visible，由 Agent 自己判断是否需要加载。

## LSP Code Intelligence

`code.intelligence` 当前支持：

- definition
- hover / type information
- references
- document symbols
- workspace symbols
- diagnostics

ForgeRelay 可以使用系统或项目已配置的 Language Server。TypeScript / JavaScript 和 Pyright 也可以在 `forgerelay init` 中由用户显式授权后安装到 ForgeRelay 私有配置目录，并在运行中动态生效。

ForgeRelay **不会未经授权自动安装语言服务器**。`rust-analyzer`、`gopls`、`clangd` 等仍由系统或项目工具链提供。

详见 [Configuration Reference](docs/configuration.md#lsp-code-intelligence)。

## Managed worktree

当用户明确需要隔离 / 并行开发时，ForgeRelay 可以创建 branch-backed managed worktree，而不是 detached HEAD。

关闭 active managed-worktree Workspace 时，ForgeRelay 会：

1. 验证 source checkout 仍然 clean 且位于预期 target branch；
2. commit worktree 中剩余修改；
3. 验证 target 可以安全 fast-forward；
4. fast-forward target branch；
5. 删除 worktree 和已经 merge 的 managed branch。

如果历史已经分叉，close 会被拒绝，worktree 保留，不会把 source checkout 推入 merge conflict。

需要复制 `.gitignore` 中的本地文件时，可以由 Agent 或用户显式复制；ForgeRelay 不额外维护一套 ignored-file provisioning 机制。

## Relay 与 Composite Workspace

Workspace Relay 允许 Gateway ForgeRelay 把操作路由到另一个 Execution ForgeRelay。远端 Workspace 的文件、Git、Shell、Process、Skill、Hook、LSP、Activity 和 Audit 事实仍由远端实例拥有。

Composite Workspace 则把多个 Workspace 组合到一个 Host-facing context：

```text
open_workspace({ kind: "composite", name: "research-project" })
```

成员操作始终显式指定 member：

```text
read({ workspaceId: "cws_...", member: "code", path: "src/model.py" })
bash({ workspaceId: "cws_...", member: "compute", command: "python train.py" })
```

Composite 不合并成员文件系统，也不会根据 tool type 或 purpose 自动猜 member。

## Lifecycle Hooks

推荐一个 Hook 一个 JSON 文件：

```text
~/.forgerelay/hooks/<hook-name>.json
<repo>/.forgerelay/hooks/<hook-name>.json
```

例如项目可以在稳定 tag push 前执行本地 release gate：

```json
{
  "event": "BeforeTool",
  "matcher": {
    "tool": "bash",
    "commandRegex": "git\\s+push\\s+origin\\s+v\\d+\\.\\d+\\.\\d+"
  },
  "command": "node scripts/release-proof.mjs check-hook",
  "timeoutSeconds": 30,
  "report": true
}
```

检查当前 Hook 配置：

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
```

详见 [Configuration Reference](docs/configuration.md#lifecycle-hooks)。

## 本地 Subagent

ForgeRelay 可以通过用户定义的 profiles 调用已经安装在服务器上的本地 Coding Agent Runtime。当前 adapter 支持 Codex、Claude、OpenCode、Pi、Cursor 和 Copilot；ForgeRelay 本身不安装、不捆绑这些执行器。

Profiles：

```text
~/.forgerelay/agents/*.md
.forgerelay/agents/*.md
```

CLI：

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

MCP Host 通过 `subagent.session` Capability 使用这套能力。

## 安全边界

ForgeRelay 是真实的本地执行能力，不是模拟环境。

- 文件系统工具受 Workspace / allowed roots 约束。
- Shell 命令使用运行 ForgeRelay 的本地用户权限。
- Shell **不是 ForgeRelay 提供的 OS sandbox**。
- 默认拒绝 elevated / administrator 启动；只有用户显式选择高权限运行时才允许继续，并会提示 AI 操作可能产生不可逆系统修改。
- 只应连接你信任的 MCP Host。
- 只暴露你确实希望 Agent 访问的项目根目录。
- Owner password 必须保持私密。

详见 [Security Model](docs/security.md)。

## 平台支持

| 平台 | 状态 | Command Shell Runtime |
| --- | --- | --- |
| Linux | 支持 | Bash 为主要 POSIX compatibility target；可显式选择 zsh / POSIX sh |
| macOS | 支持 | Bash 为主要 POSIX compatibility target；可显式选择 zsh / POSIX sh |
| Windows + PowerShell 7 | 支持 | 原生 `pwsh`，Agent / Hook / pipe / PTY 使用统一 runtime |
| Windows + Windows PowerShell 5.1 | 支持 | 原生 `powershell.exe`，带 5.1-specific guidance |
| Windows + `cmd.exe` | 支持 | 原生 cmd / ConPTY / `.cmd` launcher |
| Windows + Git Bash / WSL / MSYS2 / Cygwin | 兼容路径 | 使用对应 Bash command language |

Linux、macOS、Windows 都进入稳定 Release 的云端验证矩阵。

## ForgeRelay 不打算做什么

ForgeRelay 有意保持边界，不计划把自己扩张成完整 Agent 平台：

- 不提供自己的模型或推理 runtime；
- 不提供另一套对话 / session runtime；
- 不提供长期记忆或 autonomous memory system；
- 不提供 plugin marketplace；
- 不提供操作系统级 Shell sandbox；
- 不接管 Host 的 web、multimodal、planning、model selection 等能力；
- 不为了“自动化更多”而持续扩张本地环境 provisioning。

目标始终是：**把 MCP Host 可靠地连接到用户真实、已有的开发环境。**

## 文档

- [GitHub Wiki](https://github.com/Akira-TL/forgerelay/wiki)
- [Setup Guide](docs/setup.md)
- [Configuration Reference](docs/configuration.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Local Debugging and 7677 Acceptance](docs/debugging.md)
- [Agent Profile Schema](docs/agents/profile-schema.md)
- [Security Model](docs/security.md)
- [Troubleshooting](docs/gotchas.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
- [Attribution Notice](NOTICE.md)

## 本地开发

```bash
npm install --include=dev
npm run dev
npm run debug:accept
npm run typecheck
npm test
npm run build
```

`npm run dev` 使用 7677 debug runtime，不占用正常产品端口 7676。开发验收也应使用 7677 / 7678，不要触碰正常安装实例。

---

# English

ForgeRelay is a self-hosted MCP server that lets ChatGPT and other MCP-capable hosts work directly inside your existing development environment: files, commands, Git, LSP, persistent Workspaces, isolated worktrees, local Subagents, and multi-device execution through Relay and Composite Workspaces.

It is not a model and it is not another coding-agent UI. ForgeRelay connects the **reasoning performed by the Host** to the **real development tools on your machine**.

Your repositories stay where they already are and continue to use the compilers, package managers, Git installation, shells, SSH setup, language servers, and local credentials you already maintain.

> [!NOTE]
> ForgeRelay is an independently maintained derivative of the MIT-licensed [Waishnav/devspace](https://github.com/Waishnav/devspace) project. It is not an official DevSpace release. The original copyright and MIT License are preserved in [LICENSE](LICENSE); provenance and modification details are documented in [NOTICE.md](NOTICE.md).

## Why ForgeRelay

ForgeRelay focuses on one job: giving a remote or Host-based AI reliable, low-overhead access to a real local development environment without rebuilding the Agent runtime itself.

It provides:

- **Persistent Workspaces** — the same checkout or managed worktree reuses a stable Workspace identity; close is not delete.
- **Real files and commands** — Agents can work inside configured roots and execute through the selected native Command Shell Runtime.
- **Cross-platform shells** — Bash, zsh, and POSIX sh on Linux/macOS; native PowerShell 7, Windows PowerShell 5.1, and `cmd.exe` on Windows.
- **Git and managed worktrees** — branch-backed `forgerelay/*` worktrees for explicitly requested isolation or parallel work, with a safe close/finalize lifecycle.
- **LSP Code Intelligence** — definition, hover, references, symbols, and diagnostics through `code.intelligence` without language-specific top-level MCP tools.
- **Agent Skills** — discovered Skills are advertised as `name + description`; the Agent loads a matching Skill on demand with `read("skills://<name>")`.
- **Progressive Capability disclosure** — stable Core tools stay small while low-frequency capabilities and guides are loaded only when needed.
- **Workspace Tasks** — lightweight, persistent Workspace-owned Task Lists for work that spans Host Turns or conversations.
- **Subagent Sessions** — delegation to local coding runtimes that the user has already installed and configured; ForgeRelay does not bundle those runtimes.
- **Workspace Relay** — execute against a Workspace owned by another ForgeRelay instance over direct or SSH-routed connectivity.
- **Composite Workspaces** — combine several local or remote Workspaces into one Host-facing context while preserving each member's file, Git, shell, Hook, Skill, process, and audit ownership.
- **Activity and Audit** — durable semantic activity and Bash output, with an MCP App Activity Panel for the current Host Turn.
- **Lifecycle Hooks** — user-defined rules around Workspace, tool, file-change, worktree-close, and Subagent lifecycle events.
- **Recovery, checkpoints, and maintenance** — managed-worktree recovery, persistent Workspace checkpoints, safe restore, and explicitly authorized historical-state maintenance.

Normal work stays in the existing checkout. ForgeRelay should create a managed worktree only when isolation or parallel development is explicitly requested.

## Quick start

Requirements:

- Node.js `>=22.19 <27`
- npm
- Git
- a supported Command Shell Runtime

Install globally:

```bash
npm install -g @akira-tl/forgerelay
```

Initialize and start:

```bash
forgerelay init
forgerelay serve
```

Or use `npx` directly:

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

Default local MCP endpoint:

```text
http://127.0.0.1:7676/mcp
```

Inspect the resolved runtime:

```bash
forgerelay doctor
```

## Connecting from a public Host

If the MCP Host cannot reach localhost, expose ForgeRelay through an HTTPS reverse proxy or tunnel such as Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own reverse proxy.

`forgerelay init` distinguishes:

- **Direct LAN** — bind to `0.0.0.0`
- **HTTPS reverse proxy / tunnel** — bind to `127.0.0.1` with loopback-only proxy trust

For example, with this public base URL:

```text
https://example.com/forgerelay/main
```

the MCP Host connects to:

```text
https://example.com/forgerelay/main/mcp
```

ForgeRelay uses an Owner-password OAuth approval flow. New installations use:

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

Keep `auth.json` and the Owner password private.

## MCP interface design

ForgeRelay keeps its long-term Core tool surface intentionally small and stable:

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

Low-frequency functionality such as Code Intelligence, Hook inspection, Workspace Tasks, checkpoints, recovery, and Subagent Sessions is exposed through the Capability Gateway instead of continuously adding top-level MCP tools.

`open_workspace(context="auto")` incrementally delivers changed AGENTS / CLAUDE instructions, Skills, Capability guides, profiles, and diagnostics instead of resending the complete project context on every call.

## Skills

ForgeRelay discovers Skills from configured Skill roots, but it does not perform semantic task matching for the Agent and does not automatically inject Skill bodies.

The intended flow is:

```text
user task
  ↓
Agent sees Skill name + description
  ↓
Agent decides whether it matches
  ↓
read("skills://<name>")
  ↓
Skill activated
  ↓
nested Skill resources become readable
```

Legacy `disable-model-invocation` frontmatter no longer hides a discovered Skill. Discovered Skills remain model-visible and matching stays with the Agent.

## LSP Code Intelligence

`code.intelligence` currently supports:

- definition
- hover / type information
- references
- document symbols
- workspace symbols
- diagnostics

ForgeRelay can use Language Servers already available through the system or project configuration. TypeScript / JavaScript and Pyright can also be installed into ForgeRelay's private config directory after explicit user authorization during `forgerelay init`, and become available live without a server restart.

ForgeRelay **never installs a Language Server without user authorization**. `rust-analyzer`, `gopls`, and `clangd` remain external system/toolchain dependencies.

See [Configuration Reference](docs/configuration.md#lsp-code-intelligence).

## Managed worktrees

When isolation or parallel development is explicitly requested, ForgeRelay can create a branch-backed managed worktree instead of a detached HEAD.

When closing an active managed-worktree Workspace, ForgeRelay:

1. verifies that the source checkout is clean and still on the expected target branch;
2. commits remaining worktree changes;
3. verifies that the target can be advanced safely without a merge commit;
4. fast-forwards the target branch;
5. removes the worktree and the already-merged managed branch.

If histories diverge, close is refused and the worktree is preserved. ForgeRelay does not put the source checkout into a merge-conflict state.

If a task needs a local file that is ignored by Git, the user or Agent can copy it explicitly. ForgeRelay does not maintain a separate ignored-file provisioning system.

## Relay and Composite Workspaces

Workspace Relay lets a Gateway ForgeRelay route operations to a Workspace owned by another Execution ForgeRelay. Files, Git state, shell runtime, processes, Skills, Hooks, LSP services, Activity, and Audit facts remain owned by the execution instance.

A Composite Workspace combines several Workspaces into one Host-facing context:

```text
open_workspace({ kind: "composite", name: "research-project" })
```

Member operations stay explicit:

```text
read({ workspaceId: "cws_...", member: "code", path: "src/model.py" })
bash({ workspaceId: "cws_...", member: "compute", command: "python train.py" })
```

Composite Workspaces do not merge member filesystems and never infer a member from tool type or purpose text.

## Lifecycle Hooks

The recommended layout is one JSON file per Hook:

```text
~/.forgerelay/hooks/<hook-name>.json
<repo>/.forgerelay/hooks/<hook-name>.json
```

For example, a repository can gate stable tag pushes through a local release check:

```json
{
  "event": "BeforeTool",
  "matcher": {
    "tool": "bash",
    "commandRegex": "git\\s+push\\s+origin\\s+v\\d+\\.\\d+\\.\\d+"
  },
  "command": "node scripts/release-proof.mjs check-hook",
  "timeoutSeconds": 30,
  "report": true
}
```

Inspect Hook configuration without executing it:

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
```

See [Configuration Reference](docs/configuration.md#lifecycle-hooks).

## Local Subagents

ForgeRelay can delegate work to user-configured local coding runtimes that are already installed on the server. The current adapter layer supports Codex, Claude, OpenCode, Pi, Cursor, and Copilot. ForgeRelay does not install or bundle those executors.

Profiles live in:

```text
~/.forgerelay/agents/*.md
.forgerelay/agents/*.md
```

CLI workflow:

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

MCP Hosts use the `subagent.session` Capability for delegation.

## Security boundary

ForgeRelay provides real local execution capability, not a simulated environment.

- Filesystem operations are constrained by Workspace and allowed-root boundaries.
- Shell commands run with the authority of the local user running ForgeRelay.
- The shell is **not** contained by an operating-system sandbox provided by ForgeRelay.
- Elevated / administrator startup is rejected by default. Explicit elevated startup requires an opt-in and warns that AI-driven changes may become irreversible at system scope.
- Connect only MCP Hosts you trust.
- Expose only project roots you actually want an Agent to access.
- Keep the Owner password private.

See [Security Model](docs/security.md).

## Platform support

| Platform | Status | Command Shell Runtime |
| --- | --- | --- |
| Linux | Supported | Bash is the primary POSIX compatibility target; zsh / POSIX sh can be selected explicitly |
| macOS | Supported | Bash is the primary POSIX compatibility target; zsh / POSIX sh can be selected explicitly |
| Windows + PowerShell 7 | Supported | Native `pwsh` across Agent commands, Hooks, pipe, and PTY execution |
| Windows + Windows PowerShell 5.1 | Supported | Native `powershell.exe` with 5.1-specific command guidance |
| Windows + `cmd.exe` | Supported | Native cmd / ConPTY / packaged `.cmd` launcher |
| Windows + Git Bash / WSL / MSYS2 / Cygwin | Compatibility path | Uses the corresponding Bash command language |

Stable releases are verified in Linux, macOS, and Windows cloud jobs before publication.

## What ForgeRelay deliberately does not do

ForgeRelay intentionally keeps a narrow product boundary. It does not aim to become a complete Agent platform:

- no model or reasoning runtime;
- no second conversation/session runtime;
- no long-term or autonomous memory system;
- no plugin marketplace;
- no ForgeRelay-provided operating-system shell sandbox;
- no replacement for Host-native web, multimodal, planning, or model-selection capabilities;
- no continuous expansion into local environment provisioning merely for the sake of more automation.

The goal remains simple: **reliably connect an MCP Host to the user's real, existing development environment.**

## Documentation

- [GitHub Wiki](https://github.com/Akira-TL/forgerelay/wiki)
- [Setup Guide](docs/setup.md)
- [Configuration Reference](docs/configuration.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Local Debugging and 7677 Acceptance](docs/debugging.md)
- [Agent Profile Schema](docs/agents/profile-schema.md)
- [Security Model](docs/security.md)
- [Troubleshooting](docs/gotchas.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](CHANGELOG.md)
- [Attribution Notice](NOTICE.md)

## Local development

```bash
npm install --include=dev
npm run dev
npm run debug:accept
npm run typecheck
npm test
npm run build
```

`npm run dev` uses the 7677 debug runtime and leaves the normal product port 7676 untouched. Development acceptance should use 7677 / 7678 and must not modify the normal installed instance.
