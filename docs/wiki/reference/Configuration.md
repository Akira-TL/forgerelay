# 配置指南

这里列日常最常用的 ForgeRelay 配置。完整字段和低频选项见主仓库 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)。

## 配置来源

运行行为可以同时来自 `forgerelay init` 写入的持久配置、环境变量和项目级 `.forgerelay/` 文件。

新安装默认目录：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
~/.forgerelay/mcp.json       # 可选 External MCP 配置
~/.forgerelay/mcp-auth.json  # External MCP OAuth 状态存在时创建
```

项目还可以使用：

```text
<workspace>/.forgerelay/mcp.json
```

常用命令：

```bash
forgerelay init
forgerelay serve
forgerelay doctor
forgerelay config get
forgerelay config set publicBaseUrl https://forge.example.com
forgerelay mcp list
forgerelay mcp test <server>
forgerelay mcp auth <server>
forgerelay mcp logout <server>
```

不确定最终生效值时，直接跑：

```bash
forgerelay doctor
```

## 常用环境变量

| Variable | 用途 |
| --- | --- |
| `HOST` | 本地 bind host，默认 `127.0.0.1` |
| `PORT` | 本地端口，默认 `7676` |
| `FORGERELAY_ALLOWED_ROOTS` | 允许打开 Workspace 的 project roots |
| `FORGERELAY_PUBLIC_BASE_URL` | 一个或多个公网基础 URL |
| `FORGERELAY_ALLOWED_HOSTS` | 可选 Host-header allowlist override |
| `FORGERELAY_OAUTH_OWNER_TOKEN` | Owner password，至少 16 字符 |
| `FORGERELAY_STATE_DIR` | ForgeRelay SQLite state 目录 |
| `FORGERELAY_WORKTREE_ROOT` | Managed Worktree 根目录 |
| `FORGERELAY_TOOL_MODE` | MCP tool surface mode |
| `FORGERELAY_WIDGETS` | MCP Apps UI mode |

## Public Base URL

`publicBaseUrl` 写到 MCP endpoint 之前。

```text
https://forge.example.com/forgerelay/main
```

Host 实际连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

不要把最后的 `/mcp` 写进 `publicBaseUrl`。

可以配置多个入口：

```json
{
  "publicBaseUrl": [
    "https://forge.example.com/forgerelay/main",
    "https://forge-alt.example.com/relay"
  ]
}
```

第一个 URL 是 canonical，用于生成 OAuth / MCP metadata 和链接。每个显式配置 URL 的 pathname 都会成为可接受的入站 route boundary。

例如只有 `https://forge.example.com/forgerelay/main` 时，MCP、OAuth 操作、health 和 MCP App assets 都位于 `/forgerelay/main/*` 下，不会同时暴露裸 `/mcp`、`/authorize`、`/token`、`/healthz`。标准 discovery metadata 仍按规范使用对应的 `/.well-known/...` 路径。

所有配置 hostname 都参与 derived Host-header allowlist。

环境变量中用逗号分隔多个入口：

```bash
FORGERELAY_PUBLIC_BASE_URL="https://forge.example.com/main,https://forge-alt.example.com/relay"
```

## Tool mode

默认 `minimal` 和兼容值 `full` 都使用同一套 canonical 9-tool surface：

```text
open_workspace
capability
close_workspace
read
write
edit
rename
delete
bash
```

目录和文本搜索直接通过 `bash` 使用系统 `rg`、`find`、`ls` 等工具。

`codex` 是实验性的 Codex-shaped compatibility adapter，不代表 ForgeRelay 的长期 canonical interface。

## Widget mode

```text
FORGERELAY_WIDGETS=full
FORGERELAY_WIDGETS=changes
FORGERELAY_WIDGETS=off
```

`full` 使用常规 ForgeRelay Panel；`changes` 在同一 Panel 上启用 change-review checkpoint 行为；`off` 关闭 Widget UI metadata。

Activity Panel 默认在第一次 Activity 出现后折叠。需要新 Host Turn 默认展开：

```bash
FORGERELAY_ACTIVITY_PANEL_EXPANDED=1
```

持久配置：

```json
{
  "activityPanelExpanded": true
}
```

## Workspace Task reminder

默认每 30 次成功的语义 Workspace 操作检查一次：如果 active Task List 仍有 unfinished Task，而 Agent 长时间没有更新 Task，就附加 reminder。

```bash
FORGERELAY_TASK_REMINDER_INTERVAL=30
```

设为 `0` 关闭。Task 本身是持久数据，Server restart 只会重置 reminder counter。

## LSP Code Intelligence

Language Server definition 按以下优先级解析：

```text
<project>/.forgerelay/language-servers.json
~/.forgerelay/config.json -> languageServers
ForgeRelay-managed private npm executables
inherited PATH built-in discovery
```

`forgerelay init` 可以把 TypeScript / JavaScript 和 Pyright Language Server 安装到 ForgeRelay 私有目录。Agent 按需安装默认关闭；只有 `allowAgentLanguageServerInstall: true` 时，`code.intelligence` 的 `managed.install` 才能下载并持久化安装。

安装完成后，下一次 semantic request 即可使用，不需要重启 Server。

详见 [代码智能](Code-Intelligence)。

## External MCP

External MCP 使用独立配置：

```text
~/.forgerelay/mcp.json
<workspace>/.forgerelay/mcp.json
```

同名 Server 的优先级是 `Project > global > legacy config.json.mcpServers`。Project 可用 `"disabled": true` 屏蔽继承的 Server；合法修改会热加载，不需要重启。已经成功加载过的 source 后来写坏时，运行中的 ForgeRelay 保留整份 last-known-good，而不是半加载新配置。

日常检查和认证：

```bash
forgerelay mcp list
forgerelay mcp test <server>
forgerelay mcp auth <server>
forgerelay mcp logout <server>
```

`list` 和 `doctor` 是被动检查；`test` 才会真正连接 MCP。OAuth credential 保存在机器私有的 `mcp-auth.json`，Project credential 不写进项目目录，也不会因为复制相同配置就跨 Project 自动共享。

完整配置、OAuth/headless、CIMD、Relay ownership 和安全边界见 [External MCP](External-MCP)。

## Lifecycle Hooks

推荐文件位置：

```text
~/.forgerelay/hooks/<hook-name>.json
<workspace>/.forgerelay/hooks/<hook-name>.json
```

项目 Hook 每次事件重新读取；全局 Hook 修改后需要重启 Server。

检查配置：

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## System Instructions

ForgeRelay 默认加载一个全局 system-instructions 文件：

```text
~/.agents/AGENTS.md
```

更换路径：

```bash
FORGERELAY_SYSTEM_INSTRUCTIONS_PATH=/path/to/AGENTS.md
```

项目 root 的 `AGENTS.md` / `CLAUDE.md` 仍然单独加载，更深目录按访问路径懒发现。

`FORGERELAY_AGENT_DIR` 不是 system-instructions 路径，它只保留 Agent Skill 兼容用途。

## Agent Skills

Skills 默认启用。关闭 discovery：

```bash
FORGERELAY_SKILLS=0
```

标准发现位置：

```text
<project>/.agents/skills
~/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

这些目录只是发现来源，不代表同一个所有权域。`.agents/skills` 属于开放 Agent Skills 生态，可以包含其他 Agent 工具安装或软链接进去的 Skill；ForgeRelay 自己管理的 Skill 保留在 `<forgerelay-config>/skills`（默认 `~/.forgerelay/skills`），不会迁移或安装到 `~/.agents/skills`。

发现到的 Skill 会向 Agent 暴露 `name + description`；Agent 需要时再通过 `skills://<name>` 加载正文。

## Subagents

启用：

```bash
FORGERELAY_SUBAGENTS=1
```

常见 profile 位置：

```text
~/.forgerelay/agents/*.md
<project>/.forgerelay/agents/*.md
```

本地诊断：

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

正常 MCP 委派应使用运行版本提供的 Subagent Capability Guide，而不是把 CLI 当成长期 Host interface。

## Native Artifact Download

默认关闭。启用：

```bash
FORGERELAY_ARTIFACTS=1
```

启用后才会 advertise `artifact.download` Capability。单文件默认最大 100 MiB。

它接受 Host 提供的受支持 native file transport，不接受随意替换成 URL、本地路径、base64 或 embedded credential。

## Logging

| Variable | 默认 |
| --- | --- |
| `FORGERELAY_LOG_LEVEL` | `info` |
| `FORGERELAY_LOG_FORMAT` | `pretty` |
| `FORGERELAY_LOG_REQUESTS` | `pretty: 0`, `json: 1` |
| `FORGERELAY_LOG_ASSETS` | `0` |
| `FORGERELAY_LOG_TOOL_CALLS` | `1` |
| `FORGERELAY_LOG_SHELL_COMMANDS` | `pretty: 1`, `json: 0` |

`pretty` 适合本地查看，会显示截断后的 Shell command preview。命令参数可能带 secret 时关闭它：

```bash
FORGERELAY_LOG_SHELL_COMMANDS=0
```

`json` 更适合机器收集，默认保留 request log，并关闭 Shell command preview。

## Proxy trust

ForgeRelay bind 在 loopback、同时配置了非 loopback public URL 时，只 trust loopback proxy source，不按 hop 数信任任意来源。

`forgerelay init` 的 HTTPS reverse proxy / tunnel 模式固定 bind `127.0.0.1`；Direct LAN 模式固定 bind `0.0.0.0`，默认不信任 proxy。

关闭自动 loopback trust：

```bash
FORGERELAY_TRUST_PROXY=0
```

旧的 `FORGERELAY_TRUST_PROXY=1` 只允许用于 loopback bind。

LAN + reverse proxy 这类高级拓扑应明确写真实 proxy IP / CIDR：

```bash
FORGERELAY_TRUSTED_PROXIES="127.0.0.1,10.20.30.0/24" forgerelay serve
```

也可以在 `config.json` 中保存 `trustedProxies` 数组。全局 / wildcard trust 会被拒绝；不要在 LAN bind 上使用 `trust proxy=true`。

## 纯环境变量示例

```bash
FORGERELAY_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
FORGERELAY_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
FORGERELAY_PUBLIC_BASE_URL="https://forge.example.com" \
FORGERELAY_WORKTREE_ROOT="$HOME/.forgerelay/worktrees" \
FORGERELAY_ARTIFACTS="1" \
FORGERELAY_TOOL_MODE="minimal" \
FORGERELAY_WIDGETS="full" \
npx @akira-tl/forgerelay serve
```
