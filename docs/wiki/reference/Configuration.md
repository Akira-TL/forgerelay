# 配置指南

这篇页面只覆盖日常最常用的 ForgeRelay 配置。完整字段和低频选项请查主仓库 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)。

## 配置来源

ForgeRelay 可以通过：

- `forgerelay init` 生成的持久配置；
- 环境变量；
- 项目级 `.forgerelay/` 配置；

共同决定运行行为。

新安装默认目录：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

## 常用 CLI

```bash
forgerelay init
forgerelay serve
forgerelay doctor
forgerelay config get
forgerelay config set publicBaseUrl https://forge.example.com
```

修改配置后，如果不确定最终生效值，优先运行：

```bash
forgerelay doctor
```

## 核心环境变量

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

公网 URL 填写到 **MCP endpoint 之前**。

正确：

```text
https://forge.example.com/forgerelay/main
```

Host 连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

不要把最后 `/mcp` 写进 `publicBaseUrl`。

可以配置多个入口：

```json
{
  "publicBaseUrl": [
    "https://forge.example.com/forgerelay/main",
    "https://forge-alt.example.com/relay"
  ]
}
```

每个显式配置 URL 的 pathname 都是可接受的入站 operational route boundary；第一个 URL 仍是 canonical，用于生成 OAuth/MCP metadata 和链接。比如唯一配置 `https://forge.example.com/forgerelay/main` 时，MCP、OAuth 操作、health 和 MCP App assets 都位于 `/forgerelay/main/*` 下，不会同时继续暴露裸 `/mcp`、`/authorize`、`/token`、`/healthz`。OAuth/MCP 标准 discovery metadata 仍按规范位于对应的 `/.well-known/...` 路径。所有配置 hostname 都会参与 derived Host-header allowlist。

环境变量中使用逗号分隔：

```bash
FORGERELAY_PUBLIC_BASE_URL="https://forge.example.com/main,https://forge-alt.example.com/relay"
```

## Tool mode

### `minimal`

默认 canonical surface：

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

搜索和目录 inspection 直接通过 `bash` 使用系统 `rg`、`find`、`ls` 等工具。

### `full`

当前仅作为兼容值保留，与 `minimal` 使用相同 canonical 9-tool surface。

### `codex`

实验性 Codex-shaped adapter，面向兼容性，不代表 ForgeRelay 的 canonical MCP interface。

## Widget mode

```text
FORGERELAY_WIDGETS=full
FORGERELAY_WIDGETS=changes
FORGERELAY_WIDGETS=off
```

当前语义：

- `full`：默认，使用 ForgeRelay Panel；
- `changes`：保留同一 Panel，并启用 change-review checkpoint 行为；
- `off`：关闭 Widget UI。

Activity Panel 默认在第一次 Activity 出现后折叠。需要新 Host Turn 默认展开：

```bash
FORGERELAY_ACTIVITY_PANEL_EXPANDED=1
```

也可以持久化为：

```json
{
  "activityPanelExpanded": true
}
```

## Workspace Task reminder

默认每 30 次成功语义 Workspace 操作，在仍有 unfinished Tasks 且长时间没有 Task mutation 时提醒 Agent 更新进度。

```bash
FORGERELAY_TASK_REMINDER_INTERVAL=30
```

设置为 `0` 关闭 reminder。

Task 数据本身仍然持久，不受 reminder counter 是否在 Server restart 后重置影响。

## LSP Code Intelligence

Language Server definition 按优先级读取：

```text
<project>/.forgerelay/language-servers.json
~/.forgerelay/config.json -> languageServers
ForgeRelay-managed private npm executables
inherited PATH built-in discovery
```

`forgerelay init` 可以私有安装 TypeScript/JavaScript 与 Pyright Language Servers。Agent 按需安装默认关闭；只有配置 `allowAgentLanguageServerInstall: true` 后，`code.intelligence` 的 `managed.install` 才允许产生网络下载和持久化安装。安装后下一次 semantic request 即可使用，无需重启 Server。

详见 [代码智能](Code-Intelligence)。

## Lifecycle Hooks

推荐：

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

ForgeRelay 只加载一个全局 system-instructions 文件，默认：

```text
~/.agents/AGENTS.md
```

更改路径：

```bash
FORGERELAY_SYSTEM_INSTRUCTIONS_PATH=/path/to/AGENTS.md
```

项目 root 的 `AGENTS.md` / `CLAUDE.md` 仍然单独加载；更深目录的指令按访问路径懒发现。

`FORGERELAY_AGENT_DIR` **不是** system-instructions 路径，它只保留 Agent Skill 兼容用途。

## Agent Skills

Skills 默认启用。

```bash
FORGERELAY_SKILLS=0
```

可关闭 Skill discovery。

标准发现位置包括：

```text
~/.agents/skills
<project>/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

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

本地 CLI diagnostics：

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

Host 正常委派应按运行版本的 `subagents` Capability Guide 使用 Capability Gateway，而不是把 CLI 当成长期 MCP interface。

## Native Artifact Download

默认关闭：

```bash
FORGERELAY_ARTIFACTS=1
```

启用后才 advertise `artifact.download` Capability。

单文件默认最大 100 MiB。该能力接受 Host 提供的受支持 native file transport，不接受随意替换成 URL、本地路径、base64 或 embedded credential。

## Logging

常见变量：

| Variable | 默认 |
| --- | --- |
| `FORGERELAY_LOG_LEVEL` | `info` |
| `FORGERELAY_LOG_FORMAT` | `pretty` |
| `FORGERELAY_LOG_REQUESTS` | `pretty: 0`, `json: 1` |
| `FORGERELAY_LOG_ASSETS` | `0` |
| `FORGERELAY_LOG_TOOL_CALLS` | `1` |
| `FORGERELAY_LOG_SHELL_COMMANDS` | `pretty: 1`, `json: 0` |

`pretty` 面向本地人类阅读，会显示截断 Shell command preview。命令参数可能包含秘密时：

```bash
FORGERELAY_LOG_SHELL_COMMANDS=0
```

`json` 适合机器收集，默认保留 request log 并关闭 Shell command preview。

## Proxy trust

当 ForgeRelay bind 在 loopback，但配置了非 loopback public URL 时，只 trust loopback proxy source，而不是按 hop 数信任任意来源。`forgerelay init` 的 **HTTPS reverse proxy / tunnel** 模式固定 bind `127.0.0.1`；**Direct LAN** 模式固定 bind `0.0.0.0` 且默认不信任 proxy。

可显式关闭自动 loopback trust：

```bash
FORGERELAY_TRUST_PROXY=0
```

旧的 `FORGERELAY_TRUST_PROXY=1` 只允许用于 loopback bind。需要高级 LAN + reverse proxy 拓扑时，明确列出真实 proxy IP/CIDR：

```bash
FORGERELAY_TRUSTED_PROXIES="127.0.0.1,10.20.30.0/24" forgerelay serve
```

也可以在 `config.json` 中持久化 `trustedProxies` 数组。全局/wildcard trust 会被拒绝；不要在 LAN bind 上使用 `trust proxy=true`。

## Environment-only 示例

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
