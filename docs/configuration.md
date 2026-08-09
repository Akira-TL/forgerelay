# Configuration Reference

ForgeRelay can be configured through `forgerelay init`, persisted config files,
or environment variables.

## Config directory

New installations use:

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

Override the directory with:

```bash
FORGERELAY_CONFIG_DIR=/path/to/config npx @akira-tl/forgerelay serve
```

For migration compatibility, `DEVSPACE_CONFIG_DIR` is accepted when
`FORGERELAY_CONFIG_DIR` is unset. Without either variable, ForgeRelay uses
`~/.forgerelay` unless that directory is absent and an existing `~/.devspace`
directory is present; in that case the legacy directory is reused.

## Commands

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
npx @akira-tl/forgerelay doctor
npx @akira-tl/forgerelay config get
npx @akira-tl/forgerelay config set publicBaseUrl https://forge.example.com
```

## Environment variable compatibility

The public prefix is `FORGERELAY_*`.

During the rename transition, the equivalent `DEVSPACE_*` variable remains a
fallback when the ForgeRelay variable is unset. For example:

```text
FORGERELAY_ALLOWED_ROOTS
        ↓ if unset
DEVSPACE_ALLOWED_ROOTS
```

When both are present, `FORGERELAY_*` wins.

## Core variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `FORGERELAY_ALLOWED_ROOTS` | Comma-separated roots that workspaces may open. |
| `FORGERELAY_PUBLIC_BASE_URL` | Public origin, without `/mcp`. |
| `FORGERELAY_ALLOWED_HOSTS` | Optional Host-header allowlist override. |
| `FORGERELAY_OAUTH_OWNER_TOKEN` | Owner password. Must be at least 16 characters. |
| `FORGERELAY_STATE_DIR` | SQLite state directory. New default: `~/.local/share/forgerelay`. |
| `FORGERELAY_WORKTREE_ROOT` | Managed worktree directory. New default: `~/.forgerelay/worktrees`. |
| `FORGERELAY_WORKFLOW_INSTRUCTIONS` | Replace the built-in workflow policy while retaining the capability contract. |
| `FORGERELAY_APPEND_INSTRUCTIONS` | Append project/operator workflow policy. |

If an existing legacy state/worktree directory is present and the new default is
not, ForgeRelay reuses the legacy location rather than orphaning stored state.
Persisted `stateDir` and `worktreeRoot` values in `config.json` also continue to
win over defaults.

## Native artifact download

Native-file download is disabled by default. Enable it with:

```bash
FORGERELAY_ARTIFACTS=1 npx @akira-tl/forgerelay serve
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGERELAY_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `FORGERELAY_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted as `artifactsEnabled` and
`artifactMaxFileBytes` in `config.json`.

The tool currently supports the secure native-file publication path on Linux.
See [Native File Download](artifact-exchange.md).

## OAuth

ForgeRelay uses a single-user Owner-password OAuth approval flow.

| Variable | Default |
| --- | --- |
| `FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `FORGERELAY_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `FORGERELAY_OAUTH_SCOPES` | legacy-compatible internal scope `devspace` |
| `FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

The default OAuth scope intentionally remains the legacy internal value during
the rename so existing registrations/state do not need a destructive migration.
This is a protocol compatibility identifier, not product branding.

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool modes

`FORGERELAY_TOOL_MODE` controls the exposed MCP tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. |
| `full` | Adds dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental Codex-shaped tool surface using `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. |

`FORGERELAY_MINIMAL_TOOLS` remains a compatibility-style boolean alias when the
explicit tool mode is unset. The corresponding legacy `DEVSPACE_*` names are
also accepted.

Codex-mode commands run without a PTY by default. `tty: true` enables interactive
programs when the optional `node-pty` dependency is available.

## Widgets

`FORGERELAY_WIDGETS` controls ChatGPT Apps-compatible UI attachments.

| Value | Behavior |
| --- | --- |
| `full` | Default. Attach UI to exposed workspace/file/edit/shell tools. |
| `changes` | Attach UI to `open_workspace` and aggregate `show_changes`. |
| `off` | Disable widget UI. |

## Lifecycle hooks

Hooks v1 是自动生命周期规则。规则由用户或 Agent 主动写入；命中后 ForgeRelay 直接执行，不再增加批准步骤。

全局规则放在当前 ForgeRelay 配置目录的 `hooks.json`。新安装通常是：

```text
~/.forgerelay/hooks.json
```

使用 `FORGERELAY_CONFIG_DIR` 时，文件跟随该目录。旧的 `config.json -> hooks` 仍兼容，并与 `hooks.json` 中的规则组合执行。全局规则随 server config 在启动时加载，修改后需要重启 ForgeRelay。

项目规则放在工作区根目录：

```text
<workspace>/.forgerelay/hooks.json
```

全局规则先执行，项目规则随后执行；两者都是追加关系。项目文件在每次事件时重新读取，所以 Agent 修改项目 Hook 后不需要重启 ForgeRelay。若项目 Hook JSON 或 schema 无效，ForgeRelay 会把 `Project hooks config` diagnostic 返回给 Agent，同时保留工作区和工具可用性，让 Agent 可以直接修复文件。

### 规则结构

一个事件可以写旧版简写 handler：

```json
{
  "BeforeWorktreeClose": [
    {
      "name": "Project tests",
      "command": "npm test",
      "timeoutSeconds": 120,
      "report": true
    }
  ]
}
```

需要精确触发时使用 `matcher -> handlers`：

```json
{
  "BeforeTool": [
    {
      "matcher": {
        "tool": "bash",
        "commandRegex": "^git\\s+push\\s+origin\\s+v\\d+\\.\\d+\\.\\d+$"
      },
      "handlers": [
        {
          "name": "Local release CI",
          "command": "npm run release:verify",
          "timeoutSeconds": 300,
          "report": true
        },
        {
          "name": "Package inspection",
          "command": "npm pack --dry-run",
          "timeoutSeconds": 120,
          "report": true
        }
      ]
    }
  ]
}
```

这条规则的语义是：Agent 通过 ForgeRelay `bash` 工具请求推送稳定版本 tag 时，先跑本地发布检查；所有 blocking handlers 成功后才执行原始 `git push`。任一 handler 失败时，push 不会执行，失败报告直接返回给 Agent。

`matcher` 当前支持：

| 字段 | 匹配方式 |
| --- | --- |
| `tool` | 精确匹配 MCP tool 名称。 |
| `commandRegex` | 对 tool payload 中的 `command` 做 JavaScript 正则匹配。 |
| `pathRegex` | 对 payload 中的 `path` 或 `paths` 做正则匹配。 |
| `provider` | 精确匹配 subagent provider。 |
| `workspaceMode` | `checkout` 或 `worktree`。 |

Matcher 匹配 ForgeRelay 收到的那次 tool request，不会窥探该命令内部后续启动的子进程。例如 `bash` 参数本身是 `git push origin v0.2.0` 时可以命中；若参数只是 `./release.sh`，而脚本内部再执行 `git push`，ForgeRelay 不会把内部子进程重新解释成新的 Hook 事件。

Handler 字段：

| 字段 | 含义 |
| --- | --- |
| `name` | 可选的人类可读名称；建议为需要向用户报告的 Hook 设置。 |
| `command` | 必填，本地 shell 命令。 |
| `timeoutSeconds` | 默认 `30`，范围 `1` 到 `300`。 |
| `report` | 默认 `true`。为 `false` 时成功结果不主动出现在 Agent 可见报告中；blocking 失败始终可见。 |

同一个 rule 的 handlers 按配置顺序串行执行。

### 事件

| Event | 语义 |
| --- | --- |
| `WorkspaceOpen` | 新 workspace session 创建后触发；复用已有 workspace 不重复触发。 |
| `BeforeTool` | workspace-scoped MCP tool 执行前触发；失败或超时会阻断原操作。`open_workspace` 因执行前还没有 workspace，不走该事件。 |
| `AfterTool` | tool 成功后触发。 |
| `AfterToolFailure` | tool 失败或被 `BeforeTool` 拒绝后触发。 |
| `AfterFileChange` | `write`、`edit`、`apply_patch`、native artifact 等明确文件变更成功后触发；不会推断 shell 的文件副作用。 |
| `BeforeWorktreeClose` | worktree commit、fast-forward、cleanup 前触发；失败会保留 worktree 并阻断 close。 |
| `AfterWorktreeClose` | managed worktree 成功关闭后触发；此时从 source checkout 运行。 |
| `SubagentStart` | 本地 subagent worker 进入执行时触发。 |
| `SubagentStop` | subagent 完成或进入 error 状态时触发。 |

`BeforeTool` 与 `BeforeWorktreeClose` 是 blocking 事件。其他事件是 observational：失败会被记录并报告，但不会回滚已经完成的文件、Git、进程或网络副作用。Blocking 同样不是事务；Hook 命令自己已经产生的副作用不会因 exit code 非零而撤销。

### Agent 可见报告

`report:true` 的执行结果会进入模型可见 tool result，例如：

```text
Hook results:
✓ Local release CI (BeforeTool, project) passed in 38124ms
```

阻断失败会明确显示 `failed`。ForgeRelay 的 server instructions 要求 Agent 在出现 Hook results 时，向用户说明有意义的 Hook 是否通过或阻断了操作。异步 subagent 的 `SubagentStart` / `SubagentStop` 报告会随 session 持久化，并由 `forgerelay agents show` 展示。

### Hook 环境

Hook 命令继承 ForgeRelay 进程环境，并额外获得：

| Variable | 含义 |
| --- | --- |
| `FORGERELAY_HOOK_EVENT` | 当前事件名。 |
| `FORGERELAY_HOOK_PAYLOAD` | 事件相关 metadata 的 JSON。 |
| `FORGERELAY_WORKSPACE_ROOT` | 当前 workspace root。 |
| `FORGERELAY_WORKSPACE_ID` | 已知时提供 workspace ID；直接 CLI subagent 可能没有。 |
| `FORGERELAY_WORKSPACE_MODE` | 已知时为 `checkout` 或 `worktree`。 |
| `FORGERELAY_SOURCE_ROOT` | managed worktree 场景中的 source checkout。 |
| `FORGERELAY_TOOL_NAME` | tool 生命周期事件中的 MCP tool 名称。 |

Payload 用于策略和自动化，不包含文件正文、native-file credentials 或 subagent prompt。Shell Hook 会看到请求本身的 command metadata，因此 Hook 自己的日志仍应按可能含敏感参数处理。

Hook 命令与 ForgeRelay 使用同一个本地用户权限。项目 `.forgerelay/hooks.json` 也是可执行项目约定；允许某个 root 后，应把该 root 中的项目 Hook 视为本地开发环境的一部分。详见 [Security Model](security.md)。

## System instructions

ForgeRelay loads exactly one global system-instructions file. The default is
`~/.agents/AGENTS.md`. Set `FORGERELAY_SYSTEM_INSTRUCTIONS_PATH` or the
`systemInstructionsPath` config key to point at a different single file.
Arrays or empty values are not accepted. Symbolic links are followed, so the
runtime entry may point at a canonical source elsewhere on disk.

Project-root `AGENTS.md` / `CLAUDE.md` files remain project context and are
loaded separately. `FORGERELAY_AGENT_DIR` does not select a global instruction
file; it remains a compatibility path for Agent Skills.

## Skills and subagents

| Variable | Purpose |
| --- | --- |
| `FORGERELAY_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `FORGERELAY_SUBAGENTS` | Set to `1` to expose configured subagent profiles. |
| `FORGERELAY_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `FORGERELAY_SKILL_PATHS` | Optional comma-separated additional skill directories. |

Standard Agent Skills are discovered from:

- `~/.agents/skills`
- project `.agents/skills`
- the active ForgeRelay config directory's `skills` folder
- `FORGERELAY_AGENT_DIR/skills`
- paths from `FORGERELAY_SKILL_PATHS`

When subagents are enabled, profiles are discovered from:

- `~/.forgerelay/agents/*.md` for new installations;
- project `.forgerelay/agents/*.md`;
- active legacy config directory `~/.devspace/agents/*.md` when reused;
- project `.devspace/agents/*.md` for migration compatibility.

The bundled `subagent-delegation` skill teaches the current CLI workflow:

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

## Logging

| Variable | Default |
| --- | --- |
| `FORGERELAY_LOG_LEVEL` | `info` |
| `FORGERELAY_LOG_FORMAT` | `json` |
| `FORGERELAY_LOG_REQUESTS` | `1` |
| `FORGERELAY_LOG_ASSETS` | `0` |
| `FORGERELAY_LOG_TOOL_CALLS` | `1` |
| `FORGERELAY_LOG_SHELL_COMMANDS` | `0` |
| `FORGERELAY_TRUST_PROXY` | `0` |

Set `FORGERELAY_LOG_FORMAT=pretty` for local debugging. Enable shell command
previews only when intentionally needed; they can reveal sensitive arguments.

## Environment-only example

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
