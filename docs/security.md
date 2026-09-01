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

Opening a workspace still requires the path to be inside the configured allowed
roots. File and search tools additionally accept paths inside the operating
system temporary directory (for example `/tmp` on Linux) without treating that
directory as an allowed workspace root. Workspace paths remain confined to the
opened workspace, and shell working directories are not expanded by this temp
access.

Filesystem-oriented tools canonicalize existing path segments before access so
symlinks inside either the workspace or OS temp directory cannot escape to
arbitrary filesystem locations.

`read` has one narrow additional path class for explicitly advertised documents.
`open_workspace` may advertise a Skill entry file or a ForgeRelay capability
Guide outside the normal workspace/temp roots. Only that advertised entry file is
readable initially; after it is read, files inside that advertised document's
own directory may be read as supporting material. This does not expand write,
edit, rename, delete, shell working-directory, or workspace-open roots.

Capability Guides are ForgeRelay-owned, versioned package documentation. Their
paths are surfaced by the running server rather than guessed by the Agent. This
keeps progressive disclosure from becoming a general arbitrary-file read escape.

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

Rename-era `DEVSPACE_*` environment-variable and automatic `~/.devspace`
configuration fallbacks have ended. Use canonical `FORGERELAY_*` settings and
explicit paths when migrating older installations.

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

The Agent-facing shell contract therefore does not ban every command that can
change files. Commands may modify ordinary project files when that is a natural
part of the user's requested development task, including package managers,
generators, formatters, and similar tooling. Shell commands may also perform
external device or hardware mutations when the user's current request explicitly
asks for the actual device-changing operation. ForgeRelay does not assume a
particular flashing protocol, transport, device path, or firmware workflow. A
check, audit, probe, backup, verification, dry-run, or build-only request must not
be treated as authorization for a later persistent hardware write.

The contract does prohibit shell mutation of security- or privilege-sensitive
operating-system files and credential material such as `/etc/sudoers`,
`/etc/passwd`, `/etc/shadow`, PAM or authentication policy, SSH private keys, and
equivalent privileged targets. Configuration files may be changed through shell
only when the user's request explicitly calls for that configuration change
rather than merely making it a convenient implementation detail.

This is an Agent execution policy, not an OS-level sandbox or command parser.
Operators that need a stronger project-specific runtime gate can use blocking
`BeforeTool` Hooks around `bash` or `exec_command`.

The security model is therefore based on:

- strong authentication;
- narrow allowed project roots for filesystem tools;
- a trusted MCP client/model relationship;
- explicit tool calls and observable local execution;
- the user's existing OS/account permissions.

Do not describe ForgeRelay as a sandboxed coding environment.

Shell execution has a 300-second foreground wait ceiling, not a 300-second
process lifetime. When `bash` is still running after that window, ForgeRelay
returns a canonical `processId` and leaves the process alive. Regular tool modes
reuse `bash(action="process")` to poll, wait, write input, resize a PTY, or
explicitly interrupt that process. An asynchronously completed process
is reported on a later tool result for the same persistent Workspace ID, including
error-result paths, and is never broadcast to another Workspace ID. Reusing that
Workspace from another conversation intentionally shares the same completion scope
as well. Hook handlers keep their separate bounded timeout
policy because they are lifecycle gates rather than user-command execution.

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

When enabled, the registered `artifact.download` Capability accepts only the supported
native file value provided by the MCP host through the `capability` Gateway. It does
not accept arbitrary signed URLs, local paths,
embedded credentials, or base64 strings as substitutes.

Downloads are streamed, size-limited, created without overwrite, and published
as owner-only files. See [Native File Download](artifact-exchange.md).

## Logging

ForgeRelay's default human-facing `pretty` logs focus on tool and Hook
operations; HTTP request records are off by default. Pretty mode includes a
truncated shell command preview so local operators can see what the Agent ran.
Command arguments can contain secrets, so disable previews when necessary:

```bash
FORGERELAY_LOG_SHELL_COMMANDS=0
```

Explicit `json` mode is intended for machine collection. Its default preserves
HTTP request records and omits shell command previews unless those settings are
overridden explicitly.

## Package provenance

ForgeRelay is derived from the MIT-licensed DevSpace project. Public releases
preserve the upstream copyright/license and include `NOTICE.md`. The release
check fails if required attribution is removed.

See [NOTICE.md](../NOTICE.md) and [LICENSE](../LICENSE).
