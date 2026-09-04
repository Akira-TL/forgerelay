# 故障排查

遇到 ForgeRelay 问题时，先尽量判断失败发生在哪一层：

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

不要因为最外层看到一个错误，就直接修改最底层配置。

## 第一条命令：`forgerelay doctor`

```bash
forgerelay doctor
```

先检查实际解析到的：

- config directory；
- Node / Git / Bash；
- public URL；
- allowed hosts；
- SQLite/native dependency；
- tool mode；
- widget mode；
- optional capability 状态。

很多“配置明明写了但不生效”的问题，本质上是进程读取了另一套 config directory 或环境变量。

## `forgerelay: command not found`

直接用 `npx`：

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

如果已经全局安装，检查 npm global bin directory 是否在 `PATH`。

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

尝试：

```bash
npm rebuild better-sqlite3
npx @akira-tl/forgerelay doctor
```

## Public Base URL 写成了 `/mcp`

错误：

```text
https://forge.example.com/forgerelay/main/mcp
```

持久配置应该是：

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

一次性覆盖：

```bash
FORGERELAY_PUBLIC_BASE_URL="https://new.example.com/forgerelay/main" forgerelay serve
```

稳定修改：

```bash
forgerelay config set publicBaseUrl https://new.example.com/forgerelay/main
```

多个入口可以配置为 list / comma-separated value。每个显式配置 URL 的 pathname 都是实际入站 route boundary；如果唯一配置 `/forgerelay/main`，裸 `/mcp` 不再是同一 deployment 的并行入口。

## Reverse proxy 报 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`

这通常表示 reverse proxy 已经发送 `X-Forwarded-For`，但 ForgeRelay 没有把该 proxy source 配置为可信来源。不要用 Express 风格的全局 `trust proxy=true` 规避；在 LAN bind 上这会允许直连客户端伪造转发头。

标准本机 reverse proxy / tunnel 建议重新运行：

```bash
forgerelay init --force
```

选择 **HTTPS reverse proxy / tunnel**。该模式 bind `127.0.0.1` 并只 trust loopback proxy source。

如果确实需要 `0.0.0.0` 上同时接受 LAN 直连和特定 reverse proxy，显式列出 proxy IP/CIDR：

```bash
FORGERELAY_TRUSTED_PROXIES="10.20.30.5,10.20.31.0/24" forgerelay serve
```

不要把 LAN 客户端网段本身加入 trusted proxies，除非那些地址确实都是 reverse proxy。

## Host-header / 403

先：

```bash
forgerelay doctor
```

确认公网 hostname 出现在 resolved allowed hosts。

只在明确的本地 debug 环境中考虑：

```bash
FORGERELAY_ALLOWED_HOSTS="*" forgerelay serve
```

不要把 `*` 当成长期公网修复方案。

## OAuth redirect host rejected

默认 redirect hosts：

```text
chatgpt.com
localhost
127.0.0.1
```

其他 MCP client：

```bash
FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" forgerelay serve
```

## Owner password 不接受

检查 `doctor` 报告的 auth file。

新安装通常是：

```text
~/.forgerelay/auth.json
```

确实需要重新初始化时：

```bash
forgerelay init --force
```

注意这属于有意修改认证配置，不应作为每次 OAuth 错误的第一反应。

## Host 看不到新工具 / schema 还是旧的

先观察 `open_workspace` 返回的 `capabilityFingerprint`。

如果 Server version/capability 已经是新的，但 ChatGPT 当前 MCP tool schema 仍然缺旧工具或字段，问题通常是 **Host metadata cache**。

处理：

1. refresh/reconnect integration；
2. 或创建一个会重新加载 `tools/list` 的 Host context；
3. 再检查实际 schema。

不要通过反复重装 ForgeRelay 来修复一个 Host 端缓存问题。

## Unknown `workspaceId`

先按项目 path reopen：

```text
open_workspace(path="~/project")
```

然后继续使用返回的 canonical Workspace ID。

同一个 checkout 会复用持久 identity；Managed Worktree 是独立物理 Workspace target。

如果是在整理旧工作，使用 `open_workspace(action="list")` 查 inventory，而不是盲猜 ID。

## Workspace 显示 stale

`stale` 表示仍然是 active persisted record，但长时间没有使用，不等于损坏，也不等于应该自动删除。

需要时 resume；需要清理时先确认用户意图，再按 close/delete 生命周期处理。

## Workspace 显示 invalid

通常说明持久记录还存在，但 backing root 已不存在或不可用。

例如：

- checkout 被外部移动/删除；
- managed worktree 被用户手动删除；
- remote backing 不再可达。

先确认真实文件系统 / remote state，不要直接删除 Workspace record 来掩盖根因。

## Worktree mode 创建失败

检查：

- 当前目录真的是 Git repository；
- repository 至少有一个 commit；
- source checkout 在 attached local branch；
- 显式 `baseRef` 指向 local branch；
- worktree root 可写。

主 checkout 的 uncommitted changes 不会自动复制到新 worktree。

## `close_workspace` 拒绝 finalize worktree

常见保护条件：

- source checkout dirty；
- source checkout 离开记录的 target branch；
- managed worktree 离开记录的 branch；
- source 与 worktree histories diverged；
- 仍有 active process；
- 仍有 active Language Service semantic work；
- `BeforeWorktreeClose` Hook 阻断。

如果 histories diverged：在 managed worktree 中 rebase 到最新 target、验证，然后重试 close。

ForgeRelay 不会为了“自动成功”给 source checkout 制造 merge conflict。

## `close_workspace` 被 running process 阻止

用原来的 `processId` 检查或等待：

```text
bash(action="process", processId=...)
```

如果用户明确不再需要该进程，可以 interrupt。

不要启动第二个同样命令来“看看第一个结束没”。

已经完成的后台进程不会继续阻止 close。

## Windows Shell 命令失败

ForgeRelay 当前要求 Bash-compatible shell。

支持的常见 Windows 方案：

- Git Bash；
- WSL；
- MSYS2；
- Cygwin Bash。

仅有 PowerShell / `cmd.exe` 不属于当前 supported shell runtime。

检查：

```bash
forgerelay doctor
```

## Skills 不出现

Skills 默认启用。

检查是否被关闭：

```bash
FORGERELAY_SKILLS=1 forgerelay serve
```

标准路径：

```text
~/.agents/skills
<project>/.agents/skills
<forgerelay-config>/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

另外要区分：Skill 与 ForgeRelay Capability Guide 不是同一个系统。

## Subagent profiles 不出现

启用：

```bash
FORGERELAY_SUBAGENTS=1 forgerelay serve
```

Profile 常见位置：

```text
~/.forgerelay/agents/*.md
<project>/.forgerelay/agents/*.md
```

注意 `forgerelay agents ls` 主要查看 Subagent Session，不等于“列出所有 profile definition”。Host 获取 compact profile catalog 的路径与 CLI session list 不完全相同。

## `code.intelligence` 不工作

分层检查：

1. Capability catalog 是否 advertise `code.intelligence`；
2. Host schema 是否过旧；
3. 目标 Language Server 是否安装并在 Server `PATH`；
4. `.forgerelay/language-servers.json` 是否匹配文件扩展名和 project marker；
5. monorepo 的 `path` 是否选择了正确 Language Project。

ForgeRelay 不自动安装 Language Server。

详见 [代码智能](Code-Intelligence)。

## Hook 没运行

先做只读检查：

```bash
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

确认：

- 文件真的是 `*.json`；
- event 正确；
- matcher 匹配的是 ForgeRelay 收到的 tool request；
- `commandRegex` 没有错误假设脚本内部命令也会被观察；
- 修改全局 Hook 后是否重启了 Server。

项目 Hook 每次 event 会重新读取，全局 Hook 则在 Server 启动时加载。

## Hook 报错但 Tool 还是完成了

确认事件是不是 observational。

只有：

```text
BeforeTool
BeforeWorktreeClose
```

是 blocking。

`AfterTool`、`AfterFileChange` 等发生在事实已经成立之后，失败不会回滚原操作。

## Review / Activity UI 不出现

先确认 Widget mode：

```bash
FORGERELAY_WIDGETS=full
```

纯 MCP client 可以忽略 MCP App UI metadata，这不代表基础 tool 调用失败。

如果 ChatGPT 报 `Failed to fetch template`，ForgeRelay 项目开发环境可以运行：

```bash
npm run build
npm run debug:accept
```

正式用户应优先判断：

- Server 是否真实暴露 MCP App resource；
- Host 是否刷新到当前 template metadata；
- public route / asset URL 是否可达；
- 错误是在 Host template callback、`resources/read` 还是 asset fetch。

不要把“tool command 成功”误判成“UI 一定渲染成功”。

## Remote auth 失败

### 没有 `-J` 却使用 `--ssh-auth`

`--ssh-auth` 必须和显式 SSH route 一起使用。

### 同时使用 `--ssh-auth` 与 `--token`

二者互斥。

### SSH route 下 target 写错

有 `-J` 时，service target 从**最终 SSH target 主机**视角解释，而不是 Gateway 本机视角。

### Relay alias 不存在/离线

先：

```bash
forgerelay auth list
forgerelay auth test <alias>
```

确认 remote record 和 MCP connectivity，再排查 Workspace path。

## Composite member 操作失败

确认每次 Core work call 都显式指定：

```text
member="..."
```

Composite 不维护隐式 current member，也不会在 member offline 时 fallback 到其他 member。

关闭 Composite 后需要先 reopen，不能直接继续 member routing。

## 数据为什么还在

ForgeRelay 的 Workspace identity、Task List 等 durable coordination state 不会因为 conversation 结束就自动删除。

Close 也不是 delete。

需要永久删除 ForgeRelay-owned Workspace state 时，应使用显式 delete lifecycle。不要假设长期未使用记录会自动 GC。

## 仍然无法定位时

把问题缩小到一个明确边界，并保留原始错误：

- Host tool schema；
- OAuth HTTP response；
- ForgeRelay tool result；
- Hook report；
- Git status/history；
- Language Server stderr；
- remote `auth test`；
- `doctor` 输出。

一个 adapter exception 不等于模型失败；一条 Shell command exit 0 也不等于 Host UI 已经成功刷新。

更多已知问题见主仓库 [Troubleshooting Gotchas](https://github.com/Akira-TL/forgerelay/blob/main/docs/gotchas.md)。
