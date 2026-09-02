# Troubleshooting Gotchas

## `forgerelay` command not found

Use `npx`:

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

If installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node version

ForgeRelay requires Node `>=22.19 <27`.

```bash
node --version
```

## `better-sqlite3` could not load

Native dependencies may have been installed under a different Node runtime.

```bash
npm rebuild better-sqlite3
npx @akira-tl/forgerelay doctor
```

## Public base URL includes `/mcp`

Store the public base URL *before* the final `/mcp`. A routed deployment keeps
its route inside the URL:

```text
publicBaseUrl: https://your-tunnel-host.example.com/forgerelay/main
```

The MCP client then uses:

```text
https://your-tunnel-host.example.com/forgerelay/main/mcp
```

Fix persisted routing with:

```bash
forgerelay config set publicBaseUrl https://your-tunnel-host.example.com/forgerelay/main
```

Do not include the final `/mcp` in `publicBaseUrl`.

## Tunnel URL changed

For one run:

```bash
FORGERELAY_PUBLIC_BASE_URL="https://new-tunnel.example.com/forgerelay/main" forgerelay serve
```

For a stable URL:

```bash
forgerelay config set publicBaseUrl https://forge.example.com/forgerelay/main
```

When multiple public entries are valid, configure them as a list (or a
comma-separated environment/CLI value); each entry may use a different route.

## Host-header or 403 problems

Run:

```bash
forgerelay doctor
```

Confirm the public hostname appears in the resolved allowed hosts.

For intentional local debugging only:

```bash
FORGERELAY_ALLOWED_HOSTS="*" forgerelay serve
```

## OAuth redirect host rejected

The default allowed redirect hosts are:

```text
chatgpt.com
localhost
127.0.0.1
```

For another MCP client:

```bash
FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" forgerelay serve
```

## Owner password not accepted

Check the auth file reported by:

```bash
forgerelay doctor
```

New installs normally use:

```text
~/.forgerelay/auth.json
```

Regenerate setup intentionally with:

```bash
forgerelay init --force
```

## Unknown `workspaceId`

Reopen the project with `open_workspace` and use the returned ID. Active
workspace identity is directory-based; reopening the same canonical checkout
reuses its workspace ID when the stored session remains valid.

Worktree directories have their own workspace identities.

## Worktree mode fails

Managed worktrees require:

- Git;
- a repository with at least one commit;
- an attached local source branch;
- a local `baseRef` when one is explicitly supplied.

New managed branches use:

```text
forgerelay/*
```

Uncommitted source-checkout changes are not automatically copied into a newly
created worktree.

## `close_workspace` refuses to finalize a managed worktree

For a managed-worktree-backed workspace, close is deliberately refused when:

- the source checkout is dirty;
- the source checkout is no longer on the recorded target branch;
- the managed worktree is on the wrong branch;
- source and managed histories diverged.

A `commitMessage` is also required for managed-worktree-backed close. Integration
is fast-forward-only. If histories diverge, rebase and verify inside the managed
worktree, then retry the same `close_workspace` call with the original workspaceId.
ForgeRelay does not intentionally leave the source checkout in a merge-conflict state.

## Windows shell commands fail

ForgeRelay shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not currently supported by the shell runtime.

Use Git Bash, WSL, MSYS2, or Cygwin Bash, then run:

```bash
forgerelay doctor
```

## Skills do not appear

Skills are enabled by default. Check:

```bash
FORGERELAY_SKILLS=1 forgerelay serve
```

Standard paths include:

- `~/.agents/skills`
- project `.agents/skills`
- active ForgeRelay config `skills` directory
- `FORGERELAY_AGENT_DIR/skills`
- additional `FORGERELAY_SKILL_PATHS`

## Subagent profiles do not appear

Enable subagents:

```bash
FORGERELAY_SUBAGENTS=1 forgerelay serve
```

New profile locations include:

```text
~/.forgerelay/agents/*.md
.forgerelay/agents/*.md
```

`forgerelay agents ls` lists sessions, not profile definitions. The compact
profile catalog is returned through `open_workspace`.

## Review/change card does not appear

Per-tool widgets default to:

```bash
FORGERELAY_WIDGETS=full
```

Use `FORGERELAY_WIDGETS=changes` for aggregate `review.changes` Capability results,
or `off` to disable UI. Plain MCP clients may ignore MCP App widget metadata.

If ChatGPT shows `Failed to fetch template`, first verify the server-side template
chain with:

```bash
npm run build
npm run debug:accept
```

The acceptance runner enables review-focused widgets and checks that the Gateway advertises a
content-hashed `ui://forgerelay/workspace-app-<hash>.html` resource, that
`resources/read` returns `text/html;profile=mcp-app`, and that the referenced
JavaScript asset is reachable. ForgeRelay also keeps the legacy
`ui://forgerelay/workspace-app.html` pointer and historical
`workspace-app-*.html` pointers readable so an older ChatGPT metadata snapshot
can still fetch the current template while the connection is being refreshed.
For a live ChatGPT trace, run the debug server with
`FORGERELAY_DEBUG_WIDGETS=full`, `FORGERELAY_LOG_LEVEL=debug`,
`FORGERELAY_LOG_REQUESTS=1`, and `FORGERELAY_LOG_ASSETS=1`; then distinguish a
missing `resources/read` request from a template callback failure or a failed
`/mcp-app-assets/` fetch.

## Data retention

ForgeRelay does not yet automatically prune all persisted workspace sessions,
conversation bindings, or review refs. Retention/GC remains roadmap work; do not
assume inactive records are deleted automatically.
