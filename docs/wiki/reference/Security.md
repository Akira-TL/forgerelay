# 安全模型

ForgeRelay 把真实本地开发能力暴露给 MCP Host。应把一个已经通过认证的 Host 视为**受信任的本地 coding operator**，而不是只读聊天客户端。

最重要的边界是：

> **文件路径约束不等于 Shell 沙箱。**

## Allowed Workspace Roots

ForgeRelay 只允许在配置的 roots 下打开 Workspace。

例如：

```text
~/personal,~/work
```

只开放你确实愿意让 Host 操作的开发环境。不要默认把整个 Home 目录设成 allowed root。

File-oriented tools 会把访问限制在打开的 Workspace，并对已有 path segment 做 canonicalization，避免通过 symlink 从 Workspace 或 OS temp 目录逃逸到任意位置。

## OS Temp 目录

文件工具还允许使用操作系统临时目录，例如 Linux `/tmp`，用于正常的临时 artifact / handoff 工作。

这不会把 `/tmp` 变成可打开的 Workspace root，也不会扩大 Shell working directory 权限。

## Advertised documents

`read` 有一个非常窄的额外读取类别：`open_workspace` 明确 advertise 的 Agent Skill entry 或 ForgeRelay Capability Guide。

Agent 不能自己猜任意系统路径来利用这个入口。只有 Server 明确 advertise 的文档入口，以及加载后其自身目录内的支持文件，才属于这个只读路径类别。

该能力不会扩大 `write`、`edit`、`rename`、`delete` 或 Shell 权限。

## Owner-password OAuth

新安装通常使用：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

`auth.json` 保存 Owner password，应该像本地 credential 一样保护。

环境部署也可以显式设置：

```bash
FORGERELAY_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

Owner token 至少 16 字符。

只批准你信任的 MCP client。

## Public URL 与 Tunnel

ForgeRelay 自己不管理 Tunnel。

典型拓扑：

```text
MCP Host
   │ HTTPS
   ▼
Tunnel / Reverse Proxy
   │
   ▼
127.0.0.1:7676 ForgeRelay
```

对外基础 URL 配置不包含最终 `/mcp`。

默认情况下 ForgeRelay 会根据 local host 和 public URL 推导 Host-header allowlist。不要为了“先能跑”就长期设置：

```bash
FORGERELAY_ALLOWED_HOSTS="*"
```

该配置只应该在你明确理解风险的环境中使用。

## Shell 不是沙箱

File tools 的路径限制**不会**约束 `bash` 命令的 OS 权限。

Shell command 使用启动 ForgeRelay 的本地用户权限，可以访问该用户本来就能访问的：

- Workspace 外文件；
- 编译器与包管理器；
- Git credential；
- 本地服务；
- 外部 repository；
- 网络资源；
- 系统工具。

ForgeRelay 故意没有附加通用 OS sandbox，因为真实开发经常需要跨越单个项目目录访问 compiler、SDK、credential、service 和 dependency cache。

因此不要把 ForgeRelay 描述成 sandboxed coding environment。

## Agent Shell policy

Agent 可以在用户当前开发任务自然需要时，让 Shell 修改普通项目文件，例如：

- package manager；
- generator；
- formatter；
- build tool；
- project script。

但是 Agent 不应该仅为了“方便修好问题”就通过 Shell 修改 security/privilege-sensitive OS 文件或 credential，例如：

```text
/etc/sudoers
/etc/passwd
/etc/shadow
PAM/authentication policy
SSH private keys
```

配置文件修改也应该来自用户明确的配置意图，而不是把环境改动当成隐藏实现细节。

这是 Agent execution policy，不是内核级强制 sandbox。

## 用 Hook 增加项目级运行门禁

需要更强项目策略时，可以用 blocking `BeforeTool` Hook 检查 `bash` / tool request。

例如：

- 禁止特定 release 命令形式；
- 要求 Git state 满足条件；
- 在危险操作前运行项目自定义 policy script。

Hook 仍然使用本地用户权限执行，所以 Hook 本身也是可信代码边界。

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## 项目 Hook 本身是可执行约定

项目：

```text
<workspace>/.forgerelay/hooks/*.json
```

不是纯展示配置。`WorkspaceOpen`、`BeforeTool` 等事件可以让这些规则自动执行本地 command。

因此 allowed roots 不只是“文件可见范围”，也表示你愿意让 ForgeRelay 进入并遵守这些项目本地执行约定的范围。

## Managed Worktree 的安全策略

Managed Worktree 是 Git isolation，不是 security sandbox。

ForgeRelay 在 close 时拒绝以下状态：

- source checkout dirty；
- source checkout 已离开记录的 target branch；
- worktree 已离开 managed branch；
- source 与 worktree history 已经 diverge。

集成是 fast-forward-only，失败时保留 worktree，不故意把 source checkout 放进 merge conflict。

## Remote Authentication

CLI remote authentication 与 ChatGPT 网页 OAuth 分离。

直接认证时 Owner token 可以交互隐藏输入或通过 `--token` 显式传入。显式命令参数可能进入 Shell history，因此更推荐交互输入。

SSH route 下使用 `--ssh-auth` 时，远端 Owner token 只用于一次认证交换，应只短暂存在于发起进程内存，不写入：

- 参数；
- 日志；
- Activity audit；
- 持久 remote record。

持久 remote record 保存后续需要的 access / refresh token 和稳定实例信息，而不是把远端 Owner password 当作长期路由凭据。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Native Artifact Download

`artifact.download` 默认关闭。

启用后，只接受 Host 提供的受支持 native file transport，不接受任意：

- signed URL；
- local path；
- base64 string；
- embedded credential。

下载采用 streaming、size limit、no-overwrite 和 owner-only file publication。

## Logging 与秘密

默认 `pretty` log 会显示截断的 Shell command preview，方便本地 operator 观察 Agent 实际运行了什么。

但命令参数可能含秘密。必要时关闭：

```bash
FORGERELAY_LOG_SHELL_COMMANDS=0
```

Hook script 如果自己记录 `payload.command`，也必须按可能含敏感参数处理。

## 长进程

前台等待上限/feedback window 不等于进程强制寿命。

`bash` 返回 `processId` 后，进程可以继续运行，直到自然结束、达到显式 `timeoutMs` 或被 interrupt。

仍在运行的 process 会阻止 Workspace close，避免关闭后遗留没有明确 ownership 的 active command。

## 安全检查清单

部署 ForgeRelay 前至少确认：

- allowed roots 足够窄；
- Owner password 没有公开；
- public URL / reverse proxy 的 Host 配置正确；
- 只批准可信 Host；
- 理解 Shell 拥有本地用户真实权限；
- 项目 Hook 来源可信；
- command log 不会泄露 token；
- remote alias / SSH route / credential 没有混进项目仓库。

完整 threat/boundary reference 见主仓库 [Security Model](https://github.com/Akira-TL/forgerelay/blob/main/docs/security.md)。
