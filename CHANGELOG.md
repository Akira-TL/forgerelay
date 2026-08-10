# Changelog

All notable ForgeRelay changes are documented here.

## [Unreleased]

### Changed

- Regular MCP tool modes now use one `bash` interface for both command start and long-process interaction. `action="run"` preserves normal shell execution while `action="process"` polls/waits, writes input, resizes PTYs, or interrupts an existing workspace-owned `processId`; top-level `write_stdin` is no longer exposed in regular modes.
- `close_workspace` is now the single public Workspace close operation. Checkout-backed workspaces release their logical handle, while managed-worktree-backed workspaces require `commitMessage` and run the existing Hook/commit/fast-forward/cleanup lifecycle; top-level `close_worktree` is no longer exposed.
- Shell/process and managed-worktree Capability Guides, Host instructions, configuration docs, debugging acceptance, and workflow docs now use the unified process and Workspace lifecycle model.

## [0.3.3] - 2026-08-10

### Added

- Added `review.changes` and `artifact.download` as registered Capability Gateway actions. Review preserves the existing Git-backed checkpoint and diff-card metadata; native artifact ingress preserves Host-native file transport, workspace-relative no-overwrite publication, size limits, and `AfterFileChange` lifecycle reporting.

### Changed

- The Capability catalog now advertises only capabilities that are actually available in the current runtime. Explicit calls to known-but-disabled capabilities still return stable `capability_unavailable` diagnostics.
- `show_changes` and `download_artifact` remain compatibility aliases for the 0.3.3 migration window, but the artifacts/review guide now treats the Capability Gateway as the canonical Agent workflow.

## [0.3.2] - 2026-08-10

### Added

- Added a ForgeRelay-owned Capability Registry and the single `capability` MCP gateway with `describe` / `run`, stable dotted names, runtime availability, validated input contracts, guide metadata, and stable diagnostic error codes.
- `open_workspace` now returns a lightweight Capability catalog on every open. The first tracer capability, `hooks.check`, validates active global/project Hook configuration without requiring Agents to route through shell or the CLI.

### Changed

- Server instructions now direct Agents to use the Capability catalog for low-frequency actions, describing and reading only an unfamiliar capability's advertised guide before first use instead of preloading all low-frequency instructions.

## [0.3.1] - 2026-08-10

### Changed

- Release-tag Hooks now treat `commandRegex` as a command extractor as well as a filter: a matching substring becomes Hook `payload.command`, while a different full shell request is preserved as `payload.originalCommand`. This lets stable tag pushes trigger local release gates even when an Agent wraps them in a compound shell command.
- GitHub Release pages now use the matching `CHANGELOG.md` version section as their release notes instead of relying only on generated compare notes.

### Fixed

- MCP App resources now advertise a unique `_meta.ui.domain` derived from the resolved public deployment origin while preserving existing CSP, content-hashed template identity, and legacy/historical compatibility resources.
- `forgerelay doctor` now reports the resolved MCP runtime shape, including public base URL, tool/widget modes, proxy trust, and optional artifact/subagent/Skill capability switches.

## [0.3.0] - 2026-08-10

### Added

- `open_workspace` now reports a lightweight ForgeRelay version/capability fingerprint on every open, allowing Agents to distinguish a stale Host tool-schema snapshot from a missing server capability.
- ForgeRelay-owned capability guides can be loaded explicitly with the normal `read` tool. Built-in guides cover lifecycle Hooks, managed worktrees, subagents, artifact/change review, Host/OAuth/MCP App integration, and long-running shell/PTY/process behavior; optional guides are advertised only when their feature is enabled.

### Changed

- MCP bootstrap context now keeps low-frequency operational detail out of server instructions while `tools/list` remains the source of truth for the real callable tool surface. Artifact/review feature flags no longer inflate the core instruction payload.
- New setups no longer auto-seed or auto-inject the historical bundled `subagent-delegation` Skill; ForgeRelay's own subagent workflow is documented by the on-demand `subagents` capability guide. Existing user-authored or previously seeded Skills remain supported.
- Shell capability instructions now explicitly permit persistent external device or hardware mutations only when the user's current request asks for the actual device-changing operation; checks, audits, probes, backups, verification, dry-runs, and build-only requests do not implicitly authorize a later hardware write.

### Fixed

- Loopback deployments behind a public tunnel/reverse proxy now trust exactly one upstream proxy hop by default, preventing MCP SDK OAuth rate limiting from emitting `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`; explicit proxy trust also no longer maps to Express's unsafe blanket `trust proxy = true` mode.
- Local checkout builds now restore the executable bit on `dist/cli.js`, so `npm run build && npm install -g .` produces a runnable `forgerelay` command on POSIX systems.

## [0.2.6] - 2026-08-10

### Changed

- Running shell commands now expose canonical `processId` handles; `write_stdin` accepts `processId`, while the former process `sessionId` remains a deprecated compatibility alias throughout 0.2.x.
- ForgeRelay now names protocol-level MCP state as a transport session in internal/debug terminology. Workspace identity remains `workspaceId`, one-request tracing remains `requestId`, and third-party provider session identifiers are unchanged.
- Process elapsed time now uses a monotonic clock, preventing negative `wallTimeMs` values when the operating-system wall clock is adjusted while a long-running command or release Hook is executing.

## [0.2.5] - 2026-08-10

### Changed

- Human-facing `pretty` logs are workspace-first: normal tool and hook lines no longer show transient MCP transport session IDs, MCP session create/close lifecycle events are debug-only, and project names receive stable per-project terminal colors while the logical `ws_...` identifier remains visible.
- MCP App tool metadata now uses a content-hashed UI resource URI derived from the built JavaScript/CSS, advertises both `model` and `app` visibility, and includes the ChatGPT `openai/outputTemplate` compatibility alias. Legacy `ui://forgerelay/workspace-app.html` and historical `workspace-app-*.html` pointers continue to resolve to the current template so stale ChatGPT metadata snapshots do not fail with a missing resource. Debug logs now distinguish current, legacy, and historical template reads, and real acceptance exercises current/compatibility resources plus the referenced JavaScript asset.
- `~/...` paths are expanded before allowed-root resolution, so advertised skills rendered with home-relative paths can be read directly instead of being interpreted as a literal `~` directory under the workspace.
- Successful MCP session shutdown and idle-cleanup lifecycle logs moved to `debug`; individual session close failures remain visible as warnings.

## [0.2.4] - 2026-08-09

### Added

- Conversation-scoped logical workspace handles: the same conversation keeps a stable `workspaceId`, different conversations normally receive separate IDs for the same physical checkout/worktree, `open_workspace` can explicitly resume a known ID or allocate a user-requested fresh logical handle, and workspaces idle for more than two days are reported for user-directed resumption or cleanup.
- `close_workspace` releases a logical workspace handle without deleting checkout files; the last handle anchoring a physical worktree remains protected for `close_worktree`.

### Changed

- `bash` now uses ForgeRelay's process-session runtime instead of the Pi bash executor. It waits in the foreground for at most 300 seconds and, if still running, returns a `sessionId` without killing the process. `write_stdin` is available in regular tool modes to poll, wait, interact, or interrupt, and asynchronous completion is delivered once on a later tool result for the same workspace ID.

### Security

- Background-process ownership and completion delivery are scoped to the logical `workspaceId`; logical workspace cleanup is refused while that ID owns a running or unconsumed process completion, and idle-session scanning does not refresh stale activity timestamps.

## [0.2.3] - 2026-08-09

### Changed

- Shell tools no longer carry a blanket prohibition against commands that modify files. `bash` and Codex `exec_command` may update ordinary project files when that is a natural part of the user's requested development task, including package managers, generators, and formatters.

### Security

- The Agent shell contract continues to prohibit mutation of security- or privilege-sensitive operating-system files and credential material such as `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`, authentication policy, and SSH private keys; configuration-file changes through shell require an explicit user request.

## [0.2.2] - 2026-08-09

### Added

- First-class `rename` and `delete` MCP tools for files and directories in workspace or OS-temp file roots, including direct availability in minimal, full, and Codex tool modes.

### Security

- `rename` validates both source and destination canonical roots and refuses existing destinations; `delete` refuses allowed roots themselves and requires explicit `recursive: true` for non-empty directory trees.

## [0.2.1] - 2026-08-09

### Changed

- Local console logging now defaults to a compact Loguru-style `pretty` format focused on Agent operations: short timestamps, workspace/session context, tool or Hook action, target, and `ok`/`error` or shell exit status. HTTP request logging is off by default in human mode, while explicit `json` mode keeps the previous request-on and shell-command-off machine defaults.

### Fixed

- File and search tools can access and modify files in the operating system temporary directory without making that directory an implicit workspace root; Codex `apply_patch` supports absolute OS-temp paths while workspace patch paths remain relative.

### Security

- 文件工具在 workspace 与 OS temp 边界内都会校验 canonical path，阻止通过 symlink 跳转到任意文件系统位置；shell cwd 与 workspace-open allowed roots 不随 temp 文件访问而扩大。

## [0.2.0] - 2026-08-09

### Added

- A checked-in `127.0.0.1:7677` local debug environment with reproducible OAuth/MCP acceptance scripts, isolated runtime state, and Hooks v1 lifecycle recording.
- 用户或 Agent 可写的生命周期 Hook，覆盖 workspace、MCP tool、明确文件变更、managed-worktree close 与本地 subagent 生命周期。
- 首选的一 Hook 一文件配置：全局 `hooks/<hook-name>.json` 与项目 `.forgerelay/hooks/<hook-name>.json` 自动组合，文件名直接作为 Hook 名并按文件名稳定排序；旧 inline/聚合格式继续兼容。
- 独立 Hook 的 `event + matcher + command`、bounded timeout 与 `report` 配置；可报告结果进入 Agent 可见返回，阻断失败始终可见。
- 只读的 `forgerelay hooks list` / `hooks check` CLI，用于查看实际加载规则和在不执行 Hook 的情况下校验全局/项目配置。
- `BeforeTool` 与 `BeforeWorktreeClose` 阻断语义，以及不会伪装回滚已完成操作的 observational after-events。
- 通过 `FORGERELAY_HOOK_*` 和 workspace 环境变量提供生命周期上下文，同时避免暴露 native-file credentials 或 subagent prompts。
- 异步 subagent Hook report 的 session 持久化与 `agents show` 展示。

### Fixed

- MCP `initialize` now reports the package version from `package.json` instead of a stale hardcoded `0.1.0` server version.
- Hook commands on Windows preserve quoted arguments when executed through `cmd.exe`, fixing release-gate and other Hook commands that reference absolute paths.

### Security

- 项目 Hook 作为 allowed-root 内项目执行约定自动生效，不需要批准；Hook 文件只能声明生命周期规则，不能扩大 allowed roots、修改认证配置或覆盖全局规则。
- 无效项目 Hook 配置会作为 Agent 可见 diagnostic 返回，同时保持工具可用；独立目录中的坏文件会被跳过，其他有效 Hook 继续加载，避免 Agent 因写坏单个规则而无法修复。

## [0.1.1] - 2026-08-09

### Changed

- GitHub CI is now release-only: ordinary branch pushes, pull-request updates, and manual dispatches do not start cloud CI; the reusable CI workflow is invoked only by the stable `vX.Y.Z` tag release workflow.
- Release automation now triggers only for stable `vX.Y.Z` version tags, waits for cloud CI to pass, then publishes; ordinary branch pushes never enter the CI or publication workflows.
- Global system instructions now come from exactly one configured file, defaulting to `~/.agents/AGENTS.md`; `FORGERELAY_AGENT_DIR` remains a skill-compatibility path rather than an instruction source.

### Fixed

- Symbolic-link system instruction entries now follow their configured target even when the canonical source lives outside the runtime instruction directory.
- Project instruction aliases that resolve to the same file are loaded once, preventing duplicate `AGENTS.md` context on case-insensitive filesystems such as default macOS and Windows checkouts.

## [0.1.0] - 2026-08-09

### Added

- Initial ForgeRelay release, independently maintained by Akira-TL and based on the MIT-licensed DevSpace project by Waishnav.
- Reusable workspace identity based on the actual checkout or worktree directory rather than request or conversation identity.
- Branch-backed managed worktrees with explicit source, target-branch, and branch metadata.
- `close_worktree` lifecycle that commits remaining worktree changes, requires safe fast-forward integration, and cleans up the managed worktree and branch.
- Persistent worktree branch and target-branch metadata in the workspace store.
- Local coding-agent profiles and provider adapters for Codex, Claude, OpenCode, Pi, Cursor, and Copilot integrations already supported by the runtime.
- Tag-triggered GitHub Actions publishing for npm and GitHub Releases.
- Release metadata validation, package inspection, attribution checks, and standard SemVer release helpers.
- `NOTICE.md` and release-time attribution checks preserving the upstream MIT copyright and provenance.

### Changed

- Product identity is now ForgeRelay, published as `@akira-tl/forgerelay` with the `forgerelay` CLI.
- Versioning now follows independent stable SemVer beginning at `0.1.0` instead of the temporary `X.Y.Z-akira.N` fork version format.
- New managed worktrees use dedicated `forgerelay/*` branches instead of detached HEADs or the earlier `devspace/*` prefix.
- Worktree creation is reserved for explicitly requested isolated or parallel work; ordinary work continues in the user's checkout.
- New configuration prefers `FORGERELAY_*` variables and `~/.forgerelay` while retaining legacy DevSpace configuration compatibility.
- New default state and worktree directories use ForgeRelay naming when no legacy state needs to be reused.
- MCP lifecycle instructions direct agents to reuse directory workspaces and close completed managed worktrees safely.
- Project file modifications are directed through dedicated edit/write capabilities rather than shell-based file mutation.

### Compatibility

- Existing `DEVSPACE_*` environment variables remain accepted as fallbacks while `FORGERELAY_*` takes precedence.
- Existing `~/.devspace` configuration is reused automatically when `~/.forgerelay` does not yet exist.
- Existing DevSpace state directories and managed worktree metadata remain readable so upgrades do not orphan active work.
- Legacy internal persistence identifiers such as the existing SQLite schema names and review Git refs are intentionally retained where renaming would break stored state.
- Existing `@akira-tl/devspace` and upstream `@waishnav/devspace` install paths remain recognized by Pi PATH cleanup logic.

### Fixed

- Reopening the same directory no longer creates a different workspace solely because the request came from another conversation.
- Worktree reuse resolves the actual target branch instead of treating the string `HEAD` as a stable reuse identity.
- Managed worktree close refuses dirty, wrong-branch, or diverged source checkouts instead of putting the source checkout into a merge-conflict state.
- Pi subagent PATH handling correctly removes ForgeRelay's own `node_modules/.bin` entry after the package rename.
