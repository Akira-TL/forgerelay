# 安全模型

ForgeRelay 给 MCP Host 的不是模拟开发环境，而是真实本地执行能力。一个已经通过认证的 Host 应当按“可信的本地 coding operator”来对待。

最容易误解的一点是：文件路径限制不等于 Shell sandbox。

## Allowed Workspace Roots

ForgeRelay 只允许在配置的 roots 下打开 Workspace，例如：

```text
~/personal,~/work
```

只开放你确实愿意让 Host 操作的开发目录。除非这是你的明确意图，否则不要把整个 Home 目录设成 allowed root。

File-oriented tools 会把访问限制在 Workspace，并对已有 path segment 做 canonicalization，避免通过 symlink 从 Workspace 或 OS temp 目录逃逸到任意位置。

## OS Temp 目录

文件工具可以使用操作系统临时目录，例如 Linux `/tmp`，用于临时 artifact 或 handoff。

这不会让 `/tmp` 变成可打开的 Workspace root，也不会改变 Shell 的权限边界。

## Advertised documents

`read` 还可以读取一类非常窄的外部文档：`open_workspace` 明确 advertise 的 Agent Skill entry 或 ForgeRelay Capability Guide。

Agent 不能自己猜任意系统路径。只有 Server 已广告的入口，以及对应 Skill / Guide 加载后允许的内部支持文件，才属于这个只读范围。

它不会扩大 `write`、`edit`、`rename`、`delete` 或 Shell 权限。

## Owner-password OAuth

新安装通常使用：

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

`auth.json` 保存 Owner password，应当按本地 credential 保护。

环境部署也可以显式设置：

```bash
FORGERELAY_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

Owner token 至少 16 字符。只批准你信任的 MCP client。

## Public URL 与 Tunnel

ForgeRelay 不负责创建 Tunnel。常见拓扑：

```text
MCP Host
   │ HTTPS
   ▼
Tunnel / Reverse Proxy
   │
   ▼
127.0.0.1:7676 ForgeRelay
```

`publicBaseUrl` 不包含最后的 `/mcp`。

ForgeRelay 会根据 local host 和 public URL 推导 Host-header allowlist。不要为了快速排障把下面配置长期留在公网环境：

```bash
FORGERELAY_ALLOWED_HOSTS="*"
```

## Shell 不是沙箱

File tools 的 Workspace 边界不会限制 `bash` 命令的 OS 权限。

Shell 使用启动 ForgeRelay 的本地用户权限，因此可以访问这个用户原本就能访问的 Workspace 外文件、编译器、包管理器、Git credential、本地服务、网络资源和系统工具。

ForgeRelay 不额外提供通用 OS sandbox。真实开发经常需要访问 compiler、SDK、dependency cache、credential 和本地 service，这些本来就不一定在单个项目目录里。

所以不要把 ForgeRelay 当成 sandboxed coding environment。

## Agent Shell policy

当前开发任务正常需要时，Agent 可以通过 Shell 运行 package manager、generator、formatter、build tool 或 project script，这些工具自然可能修改项目文件。

但不应该为了“顺手修好”而修改 security / privilege-sensitive OS 文件或 credential，例如：

```text
/etc/sudoers
/etc/passwd
/etc/shadow
PAM/authentication policy
SSH private keys
```

系统配置改动应该来自用户明确意图，而不是隐藏在一次普通代码修复里。

这是 Agent execution policy，不是内核级强制 sandbox。

## Elevated / administrator 运行

ForgeRelay 默认拒绝 elevated / administrator 启动。只有用户显式选择高权限运行时才允许继续，并会警告 AI 驱动的修改可能扩大到系统范围且不可逆。

如果普通用户权限已经够用，不要为了省一次权限问题就长期以管理员身份运行 ForgeRelay。

## 用 Hook 增加项目门禁

需要项目级策略时，可以用 blocking `BeforeTool` Hook 检查 tool request，例如限制 release 命令形式、检查 Git state，或在危险操作前跑项目自己的 policy script。

Hook 也使用 ForgeRelay 的本地用户权限，所以 Hook 本身就是可信代码边界。

项目中的：

```text
<workspace>/.forgerelay/hooks/*.json
```

不是纯展示配置。`WorkspaceOpen`、`BeforeTool` 等事件可以让它们自动执行本地 command。

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## Managed Worktree

Managed Worktree 提供 Git isolation，不提供 security sandbox。

Close 时如果 source checkout dirty、已经离开 target branch、worktree 离开记录的 managed branch，或者双方 history diverge，ForgeRelay 会拒绝 finalize。

集成采用 fast-forward-only。失败时保留 worktree，不会为了自动完成而把 source checkout 推进 merge conflict。

## Remote Authentication

CLI remote auth 和 Host 网页 OAuth 是两套流程。

直接认证时，Owner token 可以交互式隐藏输入，也可以通过 `--token` 传入。显式命令参数可能进入 Shell history，因此优先使用交互输入。

SSH route 配合 `--ssh-auth` 时，远端 Owner token 只服务这一次认证交换。它不应写进命令参数、日志、Activity audit 或持久 remote record。

持久 remote record 保存后续需要的 access / refresh token 和实例信息，不把 Owner password 当作长期路由凭据。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Native Artifact Download

`artifact.download` 默认关闭。

启用后只接受 Host 提供的受支持 native file transport，不接受任意 signed URL、local path、base64 string 或 embedded credential。

下载使用 streaming、size limit、no-overwrite 和 owner-only file publication。

## Logging 与秘密

默认 `pretty` log 会显示截断后的 Shell command preview，方便本地观察 Agent 实际运行了什么。命令参数可能包含 secret 时，关闭：

```bash
FORGERELAY_LOG_SHELL_COMMANDS=0
```

Hook script 如果记录 `payload.command`，也要按可能含敏感参数处理。

## 长进程

`yieldTimeMs` 是当前请求的反馈窗口，不是进程寿命。

`bash` 返回 `processId` 后，进程可以继续运行，直到自然结束、达到显式 `timeoutMs` 或被 interrupt。

仍在运行的 process 会阻止 Workspace close，避免关闭后留下 ownership 不清楚的 active command。

## 部署前检查

至少确认 allowed roots 足够窄、Owner password 没有公开、public URL / reverse proxy 配置符合真实拓扑，并且只批准可信 Host。

同时确认项目 Hooks 的来源可信、command log 不会泄露 token，remote alias / SSH route / credential 没有写进项目仓库。最重要的是记住：Shell 拥有本地用户真实权限。

完整 threat / boundary reference 见主仓库 [Security Model](https://github.com/Akira-TL/forgerelay/blob/main/docs/security.md)。
