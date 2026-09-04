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

## Commands

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
npx @akira-tl/forgerelay doctor
npx @akira-tl/forgerelay config get
npx @akira-tl/forgerelay config set publicBaseUrl https://forge.example.com/forgerelay/main,https://forge-alt.example.com/relay
npx @akira-tl/forgerelay maintenance inspect
```

## Environment variables

The public environment-variable prefix is `FORGERELAY_*`.

## Core variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `FORGERELAY_ALLOWED_ROOTS` | Comma-separated roots that workspaces may open. |
| `FORGERELAY_PUBLIC_BASE_URL` | One public base URL or a comma-separated list. Each URL may include its own routed path prefix; the first URL is canonical. All configured hostnames are added to the derived Host-header allowlist. |
| `FORGERELAY_ALLOWED_HOSTS` | Optional Host-header allowlist override. |
| `FORGERELAY_OAUTH_OWNER_TOKEN` | Owner password. Must be at least 16 characters. |
| `FORGERELAY_STATE_DIR` | SQLite state directory. New default: `~/.local/share/forgerelay`. |
| `FORGERELAY_WORKTREE_ROOT` | Managed worktree directory. New default: `~/.forgerelay/worktrees`. |
| `FORGERELAY_WORKFLOW_INSTRUCTIONS` | Replace the built-in workflow policy while retaining the capability contract. |
| `FORGERELAY_APPEND_INSTRUCTIONS` | Append project/operator workflow policy. |
| `FORGERELAY_RETENTION_HISTORY_DAYS` | Optional owner-authorized age window for related Activity/Audit, Host Turn, and durable Bash history. Unset means unlimited retention. |
| `FORGERELAY_RETENTION_ORPHANED_ADMIN` | Optional boolean authorization for provably orphaned/rebuildable administrative state. Unset/false means do not reclaim it. |

### Retention inspection

Durable ForgeRelay history is retained without an age limit by default. The owner can
inspect what is retained, protected, and potentially reclaimable without starting the
server:

```bash
npx @akira-tl/forgerelay maintenance inspect
npx @akira-tl/forgerelay maintenance inspect --json
```

Inspection is read-only: it snapshots an existing SQLite database and WAL into a
temporary directory before opening that snapshot read-only, reads bounded
Workspace-private Task/checkpoint metadata, and uses read-only Git ref/worktree
queries. It does not create or migrate a missing/older source database, touch Workspace
last-used timestamps, move refs, or alter worktrees.

The persisted policy shape is:

```json
{
  "retention": {
    "historyDays": 30,
    "orphanedAdministrativeState": false
  }
}
```

`historyDays` is one shared cutoff for related Activity/Audit, Host Turn, and durable
Bash history so later owner-authorized maintenance can preserve cross-store
consistency. Omit it for unlimited durable-history retention. The environment override
is `FORGERELAY_RETENTION_HISTORY_DAYS`. `orphanedAdministrativeState` is a separate
explicit authorization, with `FORGERELAY_RETENTION_ORPHANED_ADMIN` as its environment
override.

Named Workspace checkpoints and Workspace Tasks are protected by this policy:
checkpoint removal remains an explicit checkpoint operation, and retention maintenance
never treats Tasks as disposable history. Existing automatic runtime GC is separate:
it bounds rebuildable/in-memory runtime resources and expires stale context-delivery
bookkeeping; it does **not** age-prune durable Activity/Audit history, durable Bash
output, named checkpoints, persistent Workspace identity, or Task Lists.

### Routed and multi-origin public deployments

`publicBaseUrl` stays the single deployment setting. Persist one URL as a string,
or multiple URLs as an array:

```json
{
  "publicBaseUrl": [
    "https://forge.example.com/forgerelay/main",
    "https://forge-alt.example.com/relay"
  ]
}
```

Each entry keeps its own route prefix. Every configured pathname is an accepted
inbound operational route boundary; the first URL remains canonical for generated
OAuth/MCP metadata and links. For example, if the only configured URL is
`https://forge.example.com/forgerelay/main`, MCP, OAuth operations, health, and MCP App
assets are served below `/forgerelay/main/*`; naked `/mcp`, `/authorize`, `/token`,
`/healthz`, and `/mcp-app-assets/*` are not parallel deployment routes. Standards-based
OAuth/MCP discovery metadata remains under its required `/.well-known/...` paths.
Every configured hostname is included in the derived Host-header allowlist. MCP App
`_meta.ui.domain` uses the canonical URL's origin, while CSP resource/connect entries
include every full public base URL. The full ordered `publicBaseUrl` list also
participates in the MCP App resource cache identity, so changing any domain or route
produces a new `ui://` resource URI.

A single persisted string remains fully supported, so existing configs require no
migration. For environment configuration, use a comma-separated list in
`FORGERELAY_PUBLIC_BASE_URL`.

## Native artifact download

Native-file download is disabled by default. Enable it with:

```bash
FORGERELAY_ARTIFACTS=1 npx @akira-tl/forgerelay serve
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGERELAY_ARTIFACTS` | `0` | Advertise the `artifact.download` Capability for trusted native files. |
| `FORGERELAY_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted as `artifactsEnabled` and
`artifactMaxFileBytes` in `config.json`.

The tool currently supports the secure native-file publication path on Linux.
See [Native File Download](reference/artifact-exchange.md).

## OAuth

ForgeRelay uses a single-user Owner-password OAuth approval flow.

| Variable | Default |
| --- | --- |
| `FORGERELAY_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `FORGERELAY_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `FORGERELAY_OAUTH_SCOPES` | `forgerelay` |
| `FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool modes

`FORGERELAY_TOOL_MODE` controls the exposed MCP tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default canonical surface: `open_workspace`, `capability`, `close_workspace`, `read`, `write`, `edit`, `rename`, `delete`, and `bash`. |
| `full` | Compatibility value. Uses the same canonical 9-tool surface as `minimal`; search and directory inspection go through `bash`. |
| `codex` | Experimental Codex-shaped compatibility adapter using `open_workspace`, `close_workspace`, `read`, `rename`, `delete`, `apply_patch`, `exec_command`, `write_stdin`, and `capability`. It does not define the ForgeRelay canonical interface. |

`FORGERELAY_MINIMAL_TOOLS` remains a compatibility-style boolean alias when the
explicit tool mode is unset.

`minimal` and `full` now resolve to the same regular 9-tool `tools/list`; `full`
is retained only as a configuration-compatibility value. `codex` selects a
separate compatibility adapter. ForgeRelay does not hide core callable tools
behind capability documentation. In every mode,
`open_workspace` returns a `capabilityFingerprint` containing the package
version, tool mode, and stable semantic capability names. The fingerprint also
reports enabled optional domains such as subagent profile discovery, native
artifact download, MCP App UI, or aggregate `review.changes` when those
features are actually available; it remains a semantic summary rather than a
copy of `tools/list`.

Bootstrap responses also return `capabilityGuides`, which are compact descriptors
for built-in ForgeRelay documentation that the Agent can explicitly load with
`read` when a task needs that domain. Current built-in domains cover lifecycle
Hooks, managed worktrees, subagents, artifact/change-review workflows, Host/OAuth/
MCP App integration, and long-running shell/PTY/process behavior. Optional-domain
descriptors such as `subagents` and `artifacts-review` are advertised only when
the corresponding feature is enabled, so disabled features do not add bootstrap
context.

There is no separate progressive-disclosure configuration switch. Capability
Guide discovery is built in, while optional low-frequency actions are advertised
through the workspace Capability catalog instead of adding top-level tools. If the
fingerprint reports a capability that is missing from the Host's current tool
snapshot, treat that as stale Host MCP metadata: reconnect/refresh the integration
or use a Host context that reloads `tools/list`. The ForgeRelay process cannot
force a Host to invalidate its cached schema.

### LSP code intelligence

ForgeRelay advertises `code.intelligence` through the Capability Gateway; it does
not add language-specific top-level MCP tools. ForgeRelay 0.4 LSP v1 supports
`definition`, `hover`, `references`, `documentSymbols`, `workspaceSymbols`, and
`diagnostics`.
Position-based operations accept the same workspace-relative source position. Hover
results normalize plaintext, Markdown, and supported legacy LSP payloads into one
`contents` string with optional `language` and normalized `range` metadata.
References use the same normalized location shape as definition, default to 100
returned locations, and accept a `limit` from 1 through 1000. Document symbols use
`path` plus optional `limit`, preserve server hierarchy when present, and keep flat
legacy symbol responses flat. Workspace symbols use `path` to select the Language
project/service, then apply a `query` with an optional bounded `limit`; ForgeRelay
does not silently merge results from multiple nested Language services. Diagnostics
use `path` plus optional `limit`, prefer LSP pull diagnostics when the selected server
advertises them, and otherwise consume the latest bounded `publishDiagnostics`
snapshot. Push and pull use one normalized result shape with `provider`,
`returned`/`truncated`/`total`, and freshness metadata tied to ForgeRelay's synchronized
filesystem document version. Bounded collection results report `returned`, `truncated`,
and the real `total` when the complete Language-server response makes it known. Language Servers are external
dependencies: ForgeRelay may discover an executable already installed on the
machine, but it never downloads or installs one automatically. Built-in discovery
knows `typescript-language-server`, `pyright-langserver`, `rust-analyzer`, `gopls`,
and `clangd`. See `examples/language-servers.json` for copyable explicit TypeScript
and Pyright definitions.

ForgeRelay 0.4.5 hardens this shared Language-service runtime. Semantic requests
have one internal bounded deadline, Host cancellation propagates to LSP cancellation,
and each service has finite concurrent and queued request budgets rather than
Agent-configurable timeouts. An unexpected server crash is retried at most once;
repeated crashes enter a short cooldown. Effective server-definition fingerprints
invalidate only the affected project/service on the next resolution without adding
a recursive filesystem watcher.

Language services are keyed by physical Language project identity, so logical
workspaces over the same checkout reuse one process. Truly idle services are
reclaimed after a bounded TTL and the global service cap evicts the least-recently-
used safe idle service. A server request that ignores cancellation still counts as
active until the underlying JSON-RPC request settles. Managed-worktree finalization
releases services rooted in that worktree before removal and refuses finalization
while semantic work is active. Debug `runtime_resources` telemetry includes only
aggregate Language-service/process/request/document/diagnostic/stderr counts; it
does not log source contents or source paths.

Effective Language-server definitions resolve in this order:

1. project configuration in `.forgerelay/language-servers.json`;
2. global definitions from the `languageServers` object in
   `~/.forgerelay/config.json`;
3. built-in discovery for known executables.

A project configuration file is an object keyed by definition name. Definitions
use structured process launch and never go through a shell:

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "env": {},
    "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    "extensions": [".ts", ".tsx", ".js", ".jsx"],
    "languageIdByExtension": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    },
    "projectMarkers": ["tsconfig.json", "jsconfig.json"]
  }
}
```

Global configuration uses the same definition shape under `languageServers`. ForgeRelay can also keep optional npm-managed Language Servers under its private config directory. Agent-triggered installation is disabled by default and must be explicitly enabled:

```json
{
  "languageServers": {
    "typescript": {
      "command": "/absolute/path/to/typescript-language-server",
      "args": ["--stdio"]
    }
  },
  "allowAgentLanguageServerInstall": false
}
```

`forgerelay init` can manage TypeScript/JavaScript and Pyright installations without touching global npm. When `allowAgentLanguageServerInstall` is `true`, an Agent may use `code.intelligence` operations `managed.status` and `managed.install`; successful installs become discoverable by the same running ForgeRelay process on the next semantic request, with no restart required. Rust Analyzer, `gopls`, and `clangd` remain external toolchain/system installations.

Explicit configuration can set `"enabled": false` to suppress the matching
built-in definition. Project values override global values, and both override
built-in defaults. ForgeRelay resolves a Language project by walking ancestors of
the requested source file according to that definition's `projectMarkers`; it does
not recursively scan the Workspace.

Code-intelligence input positions are 1-based line and 1-based Unicode code-point
column values. The Workspace filesystem is the only v1 document source of truth.

Successful `write`, `edit`, `rename`, and Codex `apply_patch` mutations automatically request Language Server diagnostics for affected code files. Non-empty diagnostics are appended to the same mutation response; missing Language Servers are skipped without turning a successful file mutation into a failure.

For contributor/release interoperability checks, run `npm run lsp:interop`. The
command tests each supported real Language server that is already discoverable through
ForgeRelay built-in resolution and stdio LSP, reports a clear skip when an executable
is absent, and never installs external dependencies itself.
Definition results may point outside the Workspace and are then marked
`external: true`; this is informational only and does not expand allowed roots or
file-tool authority.

`rename` is the canonical move/rename primitive for files and directories; there
is no separate `move` MCP tool.

Codex-mode commands run without a PTY by default. `tty: true` enables interactive
programs when the optional `node-pty` dependency is available.

Workspace IDs identify persistent ForgeRelay Workspaces rather than individual
conversation handles. A canonical checkout path maps to one checkout Workspace, and
a managed worktree path maps to one managed-worktree Workspace; different Host
conversations can bind to and reuse the same `workspaceId`. Pass `workspaceId` to
`open_workspace` to resume that known Workspace explicitly. Historical duplicate
IDs created by older ForgeRelay versions remain accepted during migration and
resolve to the canonical Workspace. `newWorkspace: true` is retained only as a
deprecated compatibility input and no longer allocates another identity for the
same physical target; use `newWorktree: true` for genuinely separate Git isolation.

Bootstrap delivery is tracked separately from Workspace identity.
`open_workspace` defaults to `context="auto"`: ForgeRelay keeps the overall
`contextFingerprint` for change detection while also tracking fingerprints for the
individual bootstrap components (`agentsFiles`, nested-instruction discovery,
Skills, Skill diagnostics, Capability guides, and Subagent profiles). The first
useful open returns the complete bootstrap; later `auto` opens return only components
whose current fingerprint has not already been delivered to that conversation for
the canonical Workspace target. A changed component is returned as its complete
current value, including an empty array when previously delivered content was removed,
so Hosts can clear stale bootstrap state without receiving unrelated context again.
`context="full"` forces every component to be returned. `context="none"` opens or
resumes the Workspace without returning bootstrap components and does not acknowledge
new component fingerprints. Conversation-scoped bootstrap delivery therefore remains
independent from the persistent Workspace identity, and another conversation may reuse
the same Workspace while receiving its own current bootstrap state.

Composite Workspaces use the same `open_workspace` entry point with
`kind="composite"` and a human-readable `name`. They have no filesystem root of
their own and may contain zero or more named members. Member management also stays
on `open_workspace` through `action="member"`; an added member either references an
existing `workspaceId` or reuses the normal local/managed/relay Workspace open
definition (`path`, optional `relay`, `mode`, and worktree options). Every Composite
open returns its `kind`, name, and member purposes regardless of
`context="auto"|"full"|"none"`. To receive one member's heavy project bootstrap,
reopen the Composite with `memberName=<name>`; this does not create an implicit
current member. Core work calls against a Composite require an explicit `member`
and retain the `cws_...` ID as the Host-facing Workspace identity.

Composite member purpose text is descriptive only. ForgeRelay never routes by tool
type, hardware role, load, or availability, and a missing/offline member never falls
back to another member or local execution. Member filesystems, Git state, processes,
Hooks, Skills, language services, and Activity facts remain owned by the underlying
Workspace. The Composite Activity Panel only aggregates their presentation into one
Host Turn.

## Workspace Tasks

`workspace.tasks` keeps lightweight Task Lists in ForgeRelay-owned private Workspace
state. Task data is not project bootstrap context and is not written into checkout or
managed-worktree Git contents. Reads use progressive disclosure: default `get` returns
List summaries and unfinished counts, `level="headers"` adds Task ID/status/subject,
and `level="detail"` returns full content for one explicitly selected Task.

ForgeRelay can append a bounded forgotten-update reminder after semantic Workspace
work when active Lists still contain unfinished Tasks. The counter defaults to 30
successful semantic work calls, resets on any Task mutation, treats one
`batch.execute` as one call, and does not count Workspace inventory/lifecycle UI,
Activity queries, Task reads, or Bash/process follow-up polling/input as new work.
The counter is process-local and may reset on server restart; Task state itself
remains durable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FORGERELAY_TASK_REMINDER_INTERVAL` | `30` | Successful semantic work calls between Task update reminders; `0` disables reminders. |

The same value may be persisted as `taskReminderInterval` in `config.json`.

Use `open_workspace(action="list")` only when the Agent needs lightweight inventory
to discover known Workspaces, continue earlier work, or organize Workspace state. The
inventory is paginated (50 records by default, at most 100) and can filter by Workspace
ID, persisted status, derived state, mode, canonical root/source root, or stale-only
state. Reading inventory does not refresh `lastUsedAt`. Persisted `status="active"`
means the record has not been explicitly closed; the derived `state` distinguishes
`active`, `stale`, `invalid`, and `closed`. Active managed-worktree entries also expose
a bounded `recovery` projection: ForgeRelay observes backing/source availability, the
recorded managed and target branches, Git worktree registration, and the backing's
current branch, then classifies the result as `healthy`, `recoverable`, or
`manual-intervention`. A missing checkout or externally damaged managed worktree can
therefore remain diagnostically `status="active"` while appearing as `state="invalid"`.
This projection is observation only: inventory never runs `git worktree prune`, creates
or removes worktrees/branches, or otherwise repairs Git state. Canonical identity means
ordinary same-target opens no longer accumulate duplicate inventory rows;
`action="list"` remains the formal on-demand inventory path.

`open_workspace(action="inspect", workspaceId="...")` is the bounded read-only detail
path for one known Workspace. It uses an explicit allowlist and never opens/resumes the
target, changes conversation bindings or bootstrap-delivery records, refreshes
`lastUsedAt`, or grants file/process/Git/Capability authority. Safe projections include
ordinary/worktree lifecycle metadata, managed-worktree recovery observations,
Composite member availability summaries, Relay alias/execution-location presentation
metadata, and an already-existing Task List summary. Inspection never returns
AGENTS/CLAUDE contents, Skills, Capability-guide paths or contents, Subagent
bodies/sessions, files, Git diffs, process/Activity output, Hook/review artifacts,
credentials, network/SSH routes, or Task bodies. For Relay Workspaces the Gateway asks
the Execution ForgeRelay for this same bounded inspection and forwards sanitized
lifecycle/recovery facts under the Gateway Workspace identity; the Gateway does not
inspect or mutate the remote Git repository itself.

For checkout-backed Workspaces, `close_workspace` defaults to `action="close"`:
it marks the persistent Workspace closed, removes current conversation bindings, and
keeps the same Workspace identity available for later `open_workspace` by path or ID.
Closed Workspaces remain visible in inventory but ordinary execution tools reject them
until reopened. `action="delete"` permanently removes ForgeRelay-owned checkout
identity/state while never deleting or mutating the user's checkout directory.

Managed-worktree close also preserves the Workspace identity. It still requires
`commitMessage` and runs the existing BeforeWorktreeClose / commit / fast-forward-only
integration / physical cleanup / AfterWorktreeClose lifecycle, then leaves the
Workspace closed after its old worktree path and managed branch are removed. Reopening
the closed Workspace by ID recreates fresh managed-worktree backing from its recorded
source/target branch relationship while keeping the same `workspaceId`; an
unambiguous repeated source/target open can reuse the same closed identity as well.
If backing recreation fails, the record remains closed and unchanged.

`action="delete"` on an active managed-worktree Workspace is not a discard operation:
it requires `commitMessage`, completes the same safe finalize lifecycle, and only then
removes the persistent ForgeRelay identity. Deleting an already-closed worktree
Workspace removes only ForgeRelay-owned state and does not recreate backing.
Composite close now marks only the Composite record closed while preserving its identity,
name, members, and coordination metadata. Closed Composites remain inspectable and reject
member routing or mutation until reopened with the same `cws_...` ID. Composite
`action="delete"` permanently dissolves only Composite-owned state; it never closes,
finalizes, deletes, or otherwise mutates member Workspaces. Relayed delete remains
deferred to Workspace Relay lifecycle parity.

Hot workspace/session activity timestamps are coalesced in memory and flushed to the
SQLite state database in a transaction at most every five minutes; normal shutdown
performs a final explicit flush. Reads within the running ForgeRelay process see the
latest in-memory timestamps immediately. Workspace creation, close/status changes,
context-delivery checkpoints, and other semantic state transitions remain immediate
persistent writes. A hard process crash may therefore lose only the most recent
activity timestamp window, not the existence or closed/open state of a workspace.

Regular `bash` separates the **feedback window** from the **execution deadline**. For
`action="run"`, `yieldTimeMs` controls how long the current MCP request waits before
returning `running: true` plus a canonical `processId`; it defaults to 10 seconds and
`0` is the intentional-background form. `timeoutMs` is independent: when explicitly
set it limits total runtime from process start and ForgeRelay terminates the process
on expiry; when omitted ForgeRelay imposes no execution deadline. Reuse the same
`bash` with `action="process"` to poll incremental output, wait, send `input`, resize
a PTY, or set `interrupt:true`; each poll wait can be up to 300 seconds and does not
kill the process merely because the feedback window expires. Host cancellation of
the initial run request terminates a not-yet-handed-off process so ForgeRelay does
not leave an orphan process whose `processId` the Agent never received.

Completed background processes are delivered once with a later tool result for the
same Workspace ID. Full buffered completion output is retained for five
minutes; after that ForgeRelay compacts the completion to a bounded head/tail record
and keeps it deliverable for up to 24 hours, still subject to the global completed
process count bound. Completed processes no longer prevent `close_workspace`; the
close response itself delivers any available completion notice. Running processes
continue to block close until they finish or are interrupted.

Codex mode retains `write_stdin` only as an experimental compatibility adapter;
regular Agent workflows should use the single `bash` process lifecycle.

## Widgets

`FORGERELAY_WIDGETS` controls ChatGPT Apps-compatible UI attachments.

| Value | Behavior |
| --- | --- |
| `full` | Default. Attach the single ForgeRelay Panel through `activity_panel(workspaceId)`; ordinary work tools remain data-only. |
| `changes` | Attach the same ForgeRelay Panel while retaining change-review checkpoint behavior. |
| `off` | Disable widget UI. |

The Workspace Summary in the ForgeRelay Panel is always visible. While a Host Turn has no Activity, the Activity section is not rendered. After the first Activity appears, the Activity Panel starts collapsed by default. Set
`FORGERELAY_ACTIVITY_PANEL_EXPANDED=1` to start each new Host Turn expanded once Activity is present. The
same preference may be persisted as `activityPanelExpanded: true` in
`~/.forgerelay/config.json`; an explicit environment variable overrides the
persisted value. The preference is delivered only to the MCP App and does not
change the Activity snapshot/query contract.

## Lifecycle hooks

Hooks v1 是自动生命周期规则。规则由用户或 Agent 主动写入；命中后 ForgeRelay 直接执行，不再增加批准步骤。

首选格式是 **一个 Hook 一个 JSON 文件**。全局 Hook 放在当前 ForgeRelay 配置目录的 `hooks/` 下，新安装通常是：

```text
~/.forgerelay/hooks/<hook-name>.json
```

项目 Hook 放在工作区根目录：

```text
<workspace>/.forgerelay/hooks/<hook-name>.json
```

文件名去掉 `.json` 后就是 Hook 名，也是日志和 Agent-visible report 中显示的名称。例如 `release-tag-gate.json` 会显示为 `release-tag-gate`。目录内按文件名字典序执行；需要显式排序时可以使用 `10-release-verify.json`、`20-package-inspection.json` 这样的前缀。ForgeRelay 只读取普通 `*.json` 文件，所以临时停用某条 Hook 时可以把扩展名改掉。

全局 Hook 在 server 启动时读取，修改后需要重启 ForgeRelay；项目目录在每次事件时重新读取，所以 Agent 修改项目 Hook 后不需要重启。全局规则先执行，项目规则随后执行，两边都只做追加，不互相覆盖。

每个独立 Hook 文件只描述一条规则：

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

这个例子可以保存为 `.forgerelay/hooks/release-tag-gate.json`。Agent 通过 ForgeRelay `bash` 请求推送稳定版本 tag 时，Hook 只执行轻量仓库状态门禁：拒绝 force/delete 形式，校验 clean working tree（含 untracked）、tag 与 package version 一致，并要求本地 tag 指向当前 HEAD。Hook 不运行、也不要求本地 CI；tag 推送后由 GitHub Actions 的 Linux/macOS/Windows 矩阵执行权威验证，全部通过后发布 job 才会继续。`npm run release:verify` 仅用于需要时本地复现云端环境。

独立 Hook 文件支持这些顶层字段：

| 字段 | 含义 |
| --- | --- |
| `event` | 必填，九个 Hook event 之一。 |
| `matcher` | 可选，只在匹配当前生命周期上下文时执行。 |
| `command` | 必填，本地 shell 命令。 |
| `timeoutSeconds` | 默认 `30`，范围 `1` 到 `300`。 |
| `report` | 默认 `true`。为 `false` 时成功结果不主动出现在 Agent 可见报告中；blocking 失败始终可见。 |

独立文件不写 `name`：文件名就是唯一的 Hook 名。一个逻辑 Hook 如果需要多个独立步骤，拆成多个文件；这样可以单独启停、重命名、排序和审查每一步。

为兼容已有配置，ForgeRelay 仍接受旧的 `config.json -> hooks`、全局 `hooks.json` 和项目 `.forgerelay/hooks.json` 聚合格式。执行顺序是旧配置在前、`hooks/*.json` 独立文件在后。新配置应优先使用独立文件。

若某个项目 Hook 文件 JSON 或 schema 无效，ForgeRelay 会返回 `Project hooks config` diagnostic，同时继续加载其他有效项目 Hook，并保持 workspace/tool 可用，让 Agent 可以直接修复出错文件。

### 检查 Hook 配置

CLI 可以只读检查规则，不会启动 MCP server，也不会执行 Hook：

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

不传 `--project` 时使用当前目录。`list` 展示实际加载的全局与项目规则，包括 event、matcher、timeout、`report` 和 command；`check` 只做解析与 schema 校验，成功时输出全局/项目 Hook 数量，发现坏的全局或项目文件时返回非零状态。

`matcher` 当前支持：

| 字段 | 匹配方式 |
| --- | --- |
| `tool` | 精确匹配 MCP tool 名称。 |
| `commandRegex` | 对 tool payload 中的 `command` 做 JavaScript 正则匹配；命中后 Hook 收到的 `payload.command` 是实际匹配片段，完整原命令在片段不等于整串命令时保留为 `payload.originalCommand`。 |
| `pathRegex` | 对 payload 中的 `path` 或 `paths` 做正则匹配。 |
| `provider` | 精确匹配 subagent provider。 |
| `workspaceMode` | `checkout` 或 `worktree`。 |

Matcher 匹配 ForgeRelay 收到的那次 tool request，不会窥探该命令内部后续启动的子进程。例如 `bash` 参数本身是 `git push origin v0.2.0` 时可以命中；若参数只是 `./release.sh`，而脚本内部再执行 `git push`，ForgeRelay 不会把内部子进程重新解释成新的 Hook 事件。

旧聚合格式里的 `matcher -> handlers` 与 handler `name` 继续按原语义工作，只作为兼容入口保留。

### 事件

| Event | 语义 |
| --- | --- |
| `WorkspaceOpen` | 新 workspace session 创建后触发；复用已有 workspace 不重复触发。 |
| `BeforeTool` | workspace-scoped MCP tool 执行前触发；失败或超时会阻断原操作。`open_workspace` 因执行前还没有 workspace，不走该事件。 |
| `AfterTool` | tool 成功后触发。 |
| `AfterToolFailure` | tool 失败或被 `BeforeTool` 拒绝后触发。 |
| `AfterFileChange` | `write`、`edit`、`rename`、`delete`、`apply_patch`、native artifact 等明确文件变更成功后触发；不会推断 shell 的文件副作用。 |
| `BeforeWorktreeClose` | worktree commit、fast-forward、cleanup 前触发；失败会保留 worktree 并阻断 close。 |
| `AfterWorktreeClose` | managed worktree 成功关闭后触发；此时从 source checkout 运行。 |
| `SubagentStart` | 本地 subagent worker 进入执行时触发。 |
| `SubagentStop` | subagent 完成或进入 error 状态时触发。 |

`BeforeTool` 与 `BeforeWorktreeClose` 是 blocking 事件。其他事件是 observational：失败会被记录并报告，但不会回滚已经完成的文件、Git、进程或网络副作用。Blocking 同样不是事务；Hook 命令自己已经产生的副作用不会因 exit code 非零而撤销。Host 在 blocking Hook 仍运行时取消 MCP request，会终止该 Hook 并阻止原始 tool operation 开始，因此不会出现 Host 已放弃请求后 Hook 又放行后续原始副作用的情况。

### Agent 可见报告

`report:true` 的执行结果会进入模型可见 tool result，例如：

```text
Hook results:
✓ release-tag-gate (BeforeTool, project) passed in 42ms
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

Hook 命令与 ForgeRelay 使用同一个本地用户权限。项目 `.forgerelay/hooks/*.json` 是可执行项目约定；允许某个 root 后，应把该 root 中的项目 Hook 视为本地开发环境的一部分。详见 [Security Model](security.md)。

## System instructions

ForgeRelay loads exactly one global system-instructions file. The default is
`~/.agents/AGENTS.md`. Set `FORGERELAY_SYSTEM_INSTRUCTIONS_PATH` or the
`systemInstructionsPath` config key to point at a different single file.
Arrays or empty values are not accepted. Symbolic links are followed, so the
runtime entry may point at a canonical source elsewhere on disk.

Project-root `AGENTS.md` / `CLAUDE.md` files remain project context and are
loaded separately. Initial nested-instruction discovery checks only direct child
directories; deeper instruction files are discovered lazily when a workspace path
is first accessed. Reads surface newly discovered instructions inline, while
side-effecting file/shell operations stop before execution and require a retry if
that access discovers new local instructions. `FORGERELAY_AGENT_DIR` does not
select a global instruction file; its `skills` child is an additional Agent Skills source.

## Skills and subagents

| Variable | Purpose |
| --- | --- |
| `FORGERELAY_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `FORGERELAY_SUBAGENTS` | Set to `1` to expose configured subagent profiles. |
| `FORGERELAY_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is included as an additional Skill source. |
| `FORGERELAY_SKILL_PATHS` | Optional comma-separated additional skill directories. |

Standard Agent Skills are discovered from:

- `~/.agents/skills`
- project `.agents/skills`
- the active ForgeRelay config directory's `skills` folder
- `FORGERELAY_AGENT_DIR/skills`
- paths from `FORGERELAY_SKILL_PATHS`

When subagents are enabled, profiles are discovered from:

- the active ForgeRelay config directory's `agents/*.md`;
- project `.forgerelay/agents/*.md`.


ForgeRelay does not install or bundle coding-agent executors. Subagent providers
are available only when the corresponding user-installed executable can be found
on the server. The default commands are `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, and `copilot`. Override the first four when needed with
`CODEX_COMMAND`, `CLAUDE_COMMAND`, `OPENCODE_COMMAND`, or `PI_COMMAND`.

The ForgeRelay-owned `subagents` capability guide teaches the current CLI
workflow on demand:

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

ForgeRelay no longer ships or seeds the historical bundled `subagent-delegation` Skill.
The official delegation rules live in the `subagents` capability guide and MCP
contract. A user-authored Skill with that name is an ordinary Skill discovered
from the normal Skill paths; ForgeRelay does not reserve, delete, or rewrite it.

## Logging

| Variable | Default |
| --- | --- |
| `FORGERELAY_LOG_LEVEL` | `info` |
| `FORGERELAY_LOG_FORMAT` | `pretty` |
| `FORGERELAY_LOG_REQUESTS` | `0` in `pretty`, `1` in `json` |
| `FORGERELAY_LOG_ASSETS` | `0` |
| `FORGERELAY_LOG_TOOL_CALLS` | `1` |
| `FORGERELAY_LOG_SHELL_COMMANDS` | `1` in `pretty`, `0` in `json` |
| `FORGERELAY_TRUST_PROXY` | legacy compatibility override; `1` is accepted only with a loopback bind |
| `FORGERELAY_TRUSTED_PROXIES` | explicit comma-separated trusted proxy IP addresses/CIDRs; unset by default |

`pretty` is the human-facing local console format. It uses terminal-aware color,
short timestamps, workspace-first context, and compact operation results while
keeping HTTP request records off by default. Project names receive stable
per-project colors and logical `ws_...` identifiers remain visible; transient MCP
transport session IDs and normal transport lifecycle events are shown only at
`debug` level, where they are labeled as `transport` rather than workspace/process
identity. Shell command previews are enabled
in this mode and truncated to 120 characters; set
`FORGERELAY_LOG_SHELL_COMMANDS=0` when command arguments may contain secrets.

Set `FORGERELAY_LOG_FORMAT=json` for machine collection. Unless explicitly
overridden, JSON mode preserves request logging and omits shell command previews.
`FORGERELAY_LOG_REQUESTS` and `FORGERELAY_LOG_SHELL_COMMANDS` always override
these format-specific defaults when set.

When ForgeRelay binds to loopback (`127.0.0.1`, `::1`, or `localhost`) but is
configured with a non-loopback public URL, it trusts only the loopback proxy source.
This matches the normal local tunnel/reverse-proxy topology while preventing a public
or LAN client from becoming trusted merely because it supplied forwarded headers.
`forgerelay init` uses this model for **HTTPS reverse proxy / tunnel** mode and binds
that mode to `127.0.0.1`; **Direct LAN** mode binds to `0.0.0.0` and does not trust a
proxy by default.

Set `FORGERELAY_TRUST_PROXY=0` to disable inferred loopback trust. The legacy
`FORGERELAY_TRUST_PROXY=1` form is accepted only when ForgeRelay itself is bound to
loopback. For an advanced topology that intentionally combines direct LAN reachability
with a reverse proxy, list only the actual proxy source addresses or CIDRs, for example:

```bash
FORGERELAY_TRUSTED_PROXIES="127.0.0.1,10.20.30.0/24" forgerelay serve
```

The same list may be persisted as `trustedProxies` in `config.json`. Wildcard/global
trust is rejected; do not replace this with Express `trust proxy=true` on a LAN bind.

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
