# Changelog

All notable ForgeRelay changes are documented here.

## [Unreleased]

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
