# 故障排查

先判断错误发生在哪一层，再改配置：

```text
Host / MCP metadata
        ↓
MCP transport / OAuth
        ↓
Gateway ForgeRelay
        ↓
Workspace / Capability
        ↓
Execution ForgeRelay（Relay 时）
        ↓
本地工具 / Git / Language Server / 项目本身
```

最外层报错，不代表最底层一定有问题。

## 先跑 `forgerelay doctor`

```bash
forgerelay doctor
```

它会显示实际生效的 config directory、Node / Git / platform、runtime privilege、Command Shell Runtime、public URL、allowed hosts、SQLite native dependency、tool / widget mode 和可选能力状态。

“配置明明写了但没生效”经常只是当前进程读了另一套配置目录或环境变量。

## `forgerelay: command not found`

可以直接用 `npx`：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

已经全局安装时，检查 npm global bin directory 是否在 `PATH`。

## Node 版本不支持

要求：

```text
>=22.19 <27
```

检查：

```bash
node --version
```

## `better-sqlite3` 无法加载

常见原因是 native dependency 在另一套 Node runtime 下安装。

```bash
npm rebuild better-sqlite3
npx @akira-tl/forgerelay doctor
```

## Public Base URL 写成了 `/mcp`

错误配置：

```text
https://forge.example.com/forgerelay/main/mcp
```

`publicBaseUrl` 应该是：

```text
https://forge.example.com/forgerelay/main
```

Host 才连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

修复：

```bash
forgerelay config set publicBaseUrl https://forge.example.com/forgerelay/main
```

## Tunnel URL 变了

临时覆盖：

```bash
FORGERELAY_PUBLIC_BASE_URL="https://new.example.com/forgerelay/main" forgerelay serve
```

持久修改：

```bash
forgerelay config set publicBaseUrl https://new.example.com/forgerelay/main
```

多个入口可以用 list / comma-separated value。每个显式 pathname 都是实际 route boundary；如果唯一入口是 `/forgerelay/main`，裸 `/mcp` 不会作为同一 deployment 的另一个入口继续存在。

## `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`

Reverse proxy 已经发送 `X-Forwarded-For`，但 ForgeRelay 没把该 proxy source 识别为可信来源时会出现这个错误。

本机 reverse proxy / tunnel 建议重新运行：

```bash
forgerelay init --force
```

选择 HTTPS reverse proxy / tunnel。该模式 bind `127.0.0.1`，只 trust loopback proxy source。

不要用全局 `trust proxy=true` 绕过错误。在 LAN bind 上，这会让直连客户端有机会伪造转发头。

确实需要 `0.0.0.0` 同时接受 LAN 和指定 reverse proxy 时，明确列 proxy IP / CIDR：

```bash
FORGERELAY_TRUSTED_PROXIES="10.20.30.5,10.20.31.0/24" forgerelay serve
```

不要把普通 LAN 客户端网段误加进 trusted proxies。

## Host-header / 403

先看：

```bash
forgerelay doctor
```

确认公网 hostname 在 resolved allowed hosts 中。

下面配置只适合明确的本地 debug：

```bash
FORGERELAY_ALLOWED_HOSTS="*" forgerelay serve
```

不要把 `*` 当成长期公网方案。

## OAuth redirect host rejected

默认 redirect hosts：

```text
chatgpt.com
localhost
127.0.0.1
```

其他 MCP client 可以扩展 allowlist：

```bash
FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" forgerelay serve
```

## Owner password 不接受

先看 `doctor` 报告的 auth file。新安装通常是：

```text
~/.forgerelay/auth.json
```

确实要重建认证配置时：

```bash
forgerelay init --force
```

不要把重新初始化当成每次 OAuth 错误的第一步。

## Host 看不到新工具 / schema 还是旧的

先看 `open_workspace` 返回的 `capabilityFingerprint`。

Server 已经报告新版本 / 新 capability，但 Host 仍显示旧 schema 时，通常是 Host metadata cache。刷新或重连 MCP integration，让 Host 重新加载 `tools/list`。

反复重装 ForgeRelay 不会修复 Host 端缓存。

## Unknown `workspaceId`

先按项目 path reopen：

```text
open_workspace(path="~/project")
```

继续使用返回的 canonical Workspace ID。

整理旧工作时，用：

```text
open_workspace(action="list")
```

不要盲猜历史 ID。

## Workspace 显示 stale

`stale` 表示 persisted record 仍是 active，只是很久没有使用。它不是损坏状态，也不是自动删除信号。

需要就 resume；需要清理时先确认用户意图，再走 close / delete lifecycle。

## Workspace 显示 invalid

说明记录还在，但 backing root 已不存在或不可用。常见原因是 checkout 被外部移动 / 删除、managed worktree 被手动删除，或 remote backing 已不可达。

先检查真实 filesystem / remote state，不要靠删除 Workspace record 隐藏根因。

## Worktree mode 创建失败

检查当前目录是不是 Git repository、至少有一个 commit、source checkout 是否在 attached local branch、显式 `baseRef` 是否指向 local branch，以及 worktree root 是否可写。

Source checkout 的 uncommitted changes 不会自动复制进新 worktree。

## `close_workspace` 拒绝 finalize worktree

常见阻断原因：

- source checkout dirty 或已经离开 target branch；
- managed worktree 离开记录的 branch；
- source 与 worktree histories diverged；
- 仍有 active process 或 active Language Service semantic work；
- `BeforeWorktreeClose` Hook 阻断。

如果 histories diverged，在 managed worktree 中 rebase 到最新 target，重新验证，再重试 close。

ForgeRelay 不会为了自动成功把 source checkout 推进 merge conflict。

## `close_workspace` 被 running process 阻止

继续使用原 `processId`：

```text
bash(action="process", processId=...)
```

可以等待、检查输出，或者在用户明确不再需要时 interrupt。

不要启动第二个同样的命令只为了判断第一个有没有结束。已经完成的后台进程不会继续阻止 close。

## Windows Shell 命令失败

Windows 原生支持 PowerShell 7 (`pwsh`)、Windows PowerShell 5.1 (`powershell.exe`) 和 `cmd.exe`。公共 Core tool 名仍叫 `bash`，但这只是 Host contract 名称，不表示命令一定使用 Bash 语法。

先检查：

```bash
forgerelay doctor
```

或看 `open_workspace.executionContext.commandShellRuntime`。

`cmd.exe` 使用 `%NAME%`、`%ERRORLEVEL%`、`^` escaping 和 cmd 自己的 quoting / chaining / redirection 语义；PowerShell 使用对应版本的 PowerShell 语义。ForgeRelay 不会为了兼容静默换 Shell。

Relay / Composite 下以实际 Execution ForgeRelay / member 的 `executionContext` 为准，不要套用 Gateway 的 Shell 方言。

## Skills 不出现

Skills 默认启用。确认没有关闭：

```bash
FORGERELAY_SKILLS=1 forgerelay serve
```

常见发现位置：

```text
~/.agents/skills
<project>/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

发现到的 Skill 应通过 `open_workspace` 向 Agent 暴露 `name + description`。Skill 和 ForgeRelay Capability Guide 是两个系统。

## Subagent profiles 不出现

启用：

```bash
FORGERELAY_SUBAGENTS=1 forgerelay serve
```

常见 profile 位置：

```text
~/.forgerelay/agents/*.md
<project>/.forgerelay/agents/*.md
```

`forgerelay agents ls` 主要查看 Subagent Session，不等于列出所有 profile definition。Host 的 compact profile catalog 走自己的 discovery 路径。

## `code.intelligence` 不工作

按这个顺序检查：

1. Capability catalog 是否 advertise `code.intelligence`；
2. Host schema 是否过旧；
3. Language Server 是否安装，并且 ForgeRelay 进程能在 `PATH` 找到；
4. `.forgerelay/language-servers.json` 是否匹配扩展名和 project marker；
5. monorepo 调用的 `path` 是否落在正确 Language Project。

TypeScript / JavaScript 和 Pyright 只有在用户显式授权 managed install 后才会由 ForgeRelay 安装。其他 Language Server 不会自动安装。

详见 [代码智能](Code-Intelligence)。

## Hook 没运行

先做只读检查：

```bash
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

确认文件是 `*.json`、event 正确、matcher 匹配 ForgeRelay 收到的 request，并且没有把脚本内部命令误当成新的 MCP request。

项目 Hook 每次 event 重新读取；全局 Hook 修改后需要重启 Server。

## Hook 报错但 Tool 还是完成了

只有：

```text
BeforeTool
BeforeWorktreeClose
```

是 blocking。

`AfterTool`、`AfterFileChange` 等发生在原事实成立之后，Hook 失败不会回滚原操作。

## Review / Activity UI 不出现

先确认：

```bash
FORGERELAY_WIDGETS=full
```

纯 MCP client 忽略 MCP App UI metadata 很正常，不影响 Core tools。

ChatGPT 报 `Failed to fetch template` 时，项目开发环境可以运行：

```bash
npm run build
npm run debug:accept
```

正式部署则分别检查 Server 是否 advertise MCP App resource、Host 是否刷新 template metadata、public asset route 是否可达，以及错误发生在 template callback、`resources/read` 还是 asset fetch。

Tool command 成功和 UI 成功渲染是两件事。

## Remote auth 失败

`--ssh-auth` 必须和 `-J` 一起用，并且和 `--token` 互斥。

使用 `-J` 时，service target 从最终 SSH target 主机的视角解释，不是 Gateway 本机视角。

Relay alias 不存在或离线时先检查：

```bash
forgerelay auth list
forgerelay auth test <alias>
```

先确认 remote record 和 MCP connectivity，再排查 Workspace path。

## Composite member 操作失败

每次 Core work call 都要显式指定：

```text
member="..."
```

Composite 没有隐式 current member，也不会在 member offline 时 fallback 到其他 member。Composite 已关闭时要先 reopen。

## 数据为什么还在

Workspace identity、Task List 等 durable state 不会因为 conversation 结束而删除。Close 也不是 delete。

永久删除 ForgeRelay-owned Workspace state 时使用显式 delete lifecycle。不要假设长期未使用记录会自动 GC。

## 还是定位不了

保留原始错误，并把问题缩到一个边界：Host tool schema、OAuth HTTP response、ForgeRelay tool result、Hook report、Git status / history、Language Server stderr、remote `auth test` 或 `doctor` 输出。

Adapter exception 不等于模型失败；Shell command exit 0 也不代表 Host UI 一定刷新成功。

更多已知问题见主仓库 [Troubleshooting Gotchas](https://github.com/Akira-TL/forgerelay/blob/main/docs/gotchas.md)。
