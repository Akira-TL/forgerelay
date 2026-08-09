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

Hook commands are local code execution. They run with the same operating-system
user authority as ForgeRelay and inherit its process environment, so only put
commands you trust in the active ForgeRelay `config.json`.

ForgeRelay Hooks v1 deliberately does **not** auto-discover hook configuration
from an opened repository. Opening an untrusted checkout therefore does not, by
itself, grant that checkout a new command-execution path through lifecycle
hooks. Repository-local hooks would require a separate explicit trust or approval
model before they could be supported safely.

`BeforeTool` and `BeforeWorktreeClose` are enforcement points: failure or timeout
blocks the pending operation. The remaining v1 events are observational; their
failures are logged instead of rolling back work that has already completed.

Hook payloads expose lifecycle metadata but intentionally avoid file contents,
native-file credentials, and subagent prompts. Shell command metadata may still
contain sensitive arguments when a tool hook observes a shell tool, so hook
handlers and their own logging should treat payloads as potentially sensitive.

See [Configuration Reference](configuration.md#lifecycle-hooks) for the event and
environment contract.

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
