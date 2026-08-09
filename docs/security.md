# Security Model

ForgeRelay exposes local coding capabilities over MCP. Treat a connected client
as a trusted coding operator with access to the capabilities you expose.

## Allowed workspace roots

ForgeRelay only opens workspaces under configured roots. Keep the root list as
narrow as practical.

Example:

```text
~/personal,~/work
```

Do not use your entire home directory unless that is intentionally the access
boundary you want.

Filesystem-oriented tools validate workspace-relative paths and reject paths
that escape the opened workspace or configured roots.

## Owner-password OAuth

New installations store local configuration in:

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

`auth.json` contains the Owner password and should remain private. When a client
connects, ForgeRelay presents an approval page where that password authorizes
the connection.

For environment-only deployments:

```bash
FORGERELAY_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

The token must be at least 16 characters.

Existing `~/.devspace` configuration and `DEVSPACE_*` variables remain readable
for migration compatibility when the new ForgeRelay equivalents are absent.

## Public URL and tunnels

ForgeRelay needs `FORGERELAY_PUBLIC_BASE_URL` when an MCP client reaches it
through a public HTTPS origin.

Use the origin without `/mcp`:

```text
https://forge.example.com
```

The client connects to:

```text
https://forge.example.com/mcp
```

ForgeRelay does not manage the tunnel. Your tunnel or reverse proxy should point
to the local server, normally:

```text
http://127.0.0.1:7676
```

By default, ForgeRelay derives allowed Host headers from the local host and
configured public URL. `FORGERELAY_ALLOWED_HOSTS=*` disables that allowlist and
should only be used intentionally.

## Shell execution is not sandboxed

This boundary is important:

**Filesystem path containment is not a shell sandbox.**

ForgeRelay's file tools are scoped to the opened workspace, but shell commands
run with the authority of the local operating-system user that started
ForgeRelay. A shell command can therefore access resources that the local user
can access, including paths outside the workspace.

ForgeRelay intentionally does not add its own OS sandbox. Many development
workflows need compilers, package managers, system tools, credentials, external
repositories, local services, and other resources outside a narrow workspace
sandbox, and MCP currently does not provide a clean universal interaction model
for dynamically crossing such a boundary.

The security model is therefore based on:

- strong authentication;
- narrow allowed project roots for filesystem tools;
- a trusted MCP client/model relationship;
- explicit tool calls and observable local execution;
- the user's existing OS/account permissions.

Do not describe ForgeRelay as a sandboxed coding environment.

## Lifecycle hooks

Hook command 是本地代码执行，使用与 ForgeRelay 相同的操作系统用户权限并继承进程环境。

Hooks v1 有两个自动作用域：当前 ForgeRelay 配置目录中的 `hooks/<hook-name>.json` 全局规则，以及 workspace 根目录的 `.forgerelay/hooks/<hook-name>.json` 项目规则。项目规则不需要额外批准；打开允许根目录中的项目时，ForgeRelay 会把这些 Hook 当作该开发环境的执行约定直接使用，`WorkspaceOpen` 也可以立即触发命令。因此 allowed roots 不只是文件访问边界，也界定了你愿意让 ForgeRelay 操作的本地项目环境。

每个独立 Hook 文件只声明一个 event、可选 matcher 和一个 command，以及 timeout/report。文件名只决定 Hook 名和排序，不能扩大 allowed roots、修改 OAuth 配置或删除全局规则。全局与项目规则采用组合关系。若某个项目 Hook 文件损坏，ForgeRelay 返回可见 diagnostic、跳过该无效文件并继续加载其他有效 Hook，同时保持工具可用，便于 Agent 修复。旧聚合格式仍兼容。

`BeforeTool` 和 `BeforeWorktreeClose` 是阻断点：命中的 handler 失败或超时后，待执行操作不会继续。其余事件用于观察已发生的生命周期结果，失败不会回滚已经完成的工作。`report:false` 可以隐藏成功的高频报告，但不能隐藏阻断失败。

Hook payload 刻意不携带文件正文、native-file credentials 或 subagent prompt。Shell tool 的 command metadata 仍可能包含敏感参数，因此 Hook 脚本自己的日志也应按敏感输入处理。

详见 [Configuration Reference](configuration.md#lifecycle-hooks)。

## Git and managed worktrees

Managed worktrees are branch-backed and visible in the source repository.
ForgeRelay refuses unsafe close operations when:

- the source checkout is dirty;
- the source checkout left the recorded target branch;
- source and worktree histories diverged;
- the managed worktree is on the wrong branch.

Integration is fast-forward-only, so a failed close does not intentionally put
the source checkout into a merge-conflict state.

## Native artifact download

When enabled, `download_artifact` accepts only the supported native file value
provided by the MCP host. It does not accept arbitrary signed URLs, local paths,
embedded credentials, or base64 strings as substitutes.

Downloads are streamed, size-limited, created without overwrite, and published
as owner-only files. See [Native File Download](artifact-exchange.md).

## Logging

ForgeRelay logs requests/tool calls by default. Shell command previews are off
unless explicitly enabled:

```bash
FORGERELAY_LOG_SHELL_COMMANDS=1
```

Command arguments can contain secrets, so only enable command-preview logging
when necessary.

## Package provenance

ForgeRelay is derived from the MIT-licensed DevSpace project. Public releases
preserve the upstream copyright/license and include `NOTICE.md`. The release
check fails if required attribution is removed.

See [NOTICE.md](../NOTICE.md) and [LICENSE](../LICENSE).
