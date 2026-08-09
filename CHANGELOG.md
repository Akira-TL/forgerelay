# Changelog

All notable ForgeRelay changes are documented here.

## [Unreleased]

### Added

- User-configured lifecycle hooks for workspace creation, MCP tool execution, explicit file changes, managed-worktree close, and local subagent execution.
- Blocking `BeforeTool` and `BeforeWorktreeClose` policy gates with bounded command timeouts, plus observational after-events that log failures without rolling back completed work.
- Hook lifecycle context through `FORGERELAY_HOOK_*` and workspace environment variables without exposing native-file credentials or subagent prompts.

### Security

- Hook definitions are loaded only from user-controlled ForgeRelay configuration; repositories do not gain implicit local-command execution by containing hook files.

## [0.1.1] - 2026-08-09

### Changed

- GitHub CI is now release-only: ordinary branch pushes, pull-request updates, and manual dispatches do not start cloud CI; the reusable CI workflow is invoked only by the stable `vX.Y.Z` tag release workflow.
- Release automation now triggers only for stable `vX.Y.Z` version tags, waits for cloud CI to pass, then publishes; ordinary branch pushes never enter the CI or publication workflows.
- Global system instructions now come from exactly one configured file, defaulting to `~/.agents/AGENTS.md`; `FORGERELAY_AGENT_DIR` remains a skill-compatibility path rather than an instruction source.

### Fixed

- Symbolic-link system instruction entries now follow their configured target even when the canonical source lives outside the runtime instruction directory.

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
