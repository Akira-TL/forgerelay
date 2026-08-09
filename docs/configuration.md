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
