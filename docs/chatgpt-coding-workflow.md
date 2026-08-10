# ChatGPT Coding Workflow

ForgeRelay gives ChatGPT and other MCP hosts a local coding workspace with an
explicit lifecycle instead of treating every request as a fresh temporary
checkout.

## Workspace identity

`open_workspace` returns a `workspaceId`. Continue using that ID for later tools
in the same directory.

`workspaceId` is a logical conversation handle, not the physical-directory
identity. Reopening the same checkout in the same conversation keeps that
logical ID stable. A different conversation normally receives a different
`workspaceId` even when it points at the same checkout or worktree; pass an
existing ID explicitly when the user wants to resume that logical workspace.

A Git worktree directory is a separate physical workspace target from its source
checkout, and each conversation can still have its own logical handle for it.

## Checkout-first behavior

Checkout mode is the default:

```text
open_workspace(path="~/project")
```

ForgeRelay works directly in that directory. It does not silently create an
isolated checkout.

Use worktree mode only when the user explicitly requests isolated or parallel
work:

```text
open_workspace(path="~/project", mode="worktree")
```

## Managed worktrees

New ForgeRelay worktrees are branch-backed, not detached. A managed branch looks
like:

```text
forgerelay/<repo>-<id>
```

The worktree normally lives under:

```text
~/.forgerelay/worktrees
```

Existing configured/legacy roots remain supported.

The recorded target branch is the local branch that should receive completed
work. An explicit `baseRef` must identify a local branch.

By default, a repeated worktree request for the same source/target reuses the
existing managed worktree. An explicit new-worktree request creates another
parallel branch/worktree.

`open_workspace` also returns known managed worktree paths and branch metadata
so a specific existing worktree can be reopened directly.

## Closing a managed worktree

After the task is complete and verified, call `close_workspace` with the managed-worktree-backed
workspace ID and a `commitMessage`.

ForgeRelay:

1. verifies the source checkout remains on the expected target branch;
2. requires the source checkout to be clean;
3. verifies the managed worktree is on its recorded branch;
4. commits remaining worktree changes when needed;
5. rechecks cleanliness and source state;
6. requires the source HEAD to be an ancestor of the managed worktree commit;
7. fast-forwards the target branch;
8. removes the managed worktree;
9. deletes the already-merged managed branch.

If histories diverge, close is refused and the worktree is preserved. Rebase and
verify inside the worktree, then retry. The source checkout is not intentionally
placed into a merge-conflict state.

Legacy `devspace/*` managed branches remain closable when they are already stored
in workspace metadata; only new managed branches use `forgerelay/*`.

## Instructions

When a workspace opens, ForgeRelay first loads exactly one global system-instructions
file. The default is `~/.agents/AGENTS.md`; configure a different single path with
`FORGERELAY_SYSTEM_INSTRUCTIONS_PATH`. Symbolic links are followed so this entry can
point at a canonical source elsewhere on disk.

ForgeRelay then loads root-level project instruction files when they exist:

```text
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

Nested project instruction files are returned as available paths rather than all
being injected eagerly. Read the relevant nested file before working under that path.
`FORGERELAY_AGENT_DIR` is not an instruction source; it remains only a compatibility
skill-discovery path.

## MCP capability loading

ForgeRelay keeps a small callable MCP surface separate from low-frequency capability
details. `tools/list` remains the source of truth for the Host-visible tools, while
registered low-frequency actions are discovered through the single `capability`
gateway rather than each receiving another top-level tool schema.

`open_workspace` adds lightweight discovery surfaces:

- `capabilityFingerprint` is returned on every open/resume and includes the
  ForgeRelay version, active tool mode, and stable semantic capability names;
- `capabilityCatalog` lists currently available registered actions such as
  `hooks.check`, with compact guide metadata;
- `capabilityGuides` is returned with bootstrap context and contains compact
  descriptors for ForgeRelay-owned, versioned guides that can be loaded with
  the normal `read` tool.

Do not preload every capability guide. Read a guide only when the current task
needs that domain. Built-in guides cover lifecycle Hooks, advanced managed
worktrees, subagents, artifact/change-review workflows, Host/OAuth/MCP App
integration, and long-running shell/PTY/process behavior. Optional guides are
advertised only when their feature is enabled; for example, disabled subagents
and artifact/change-review features do not add those descriptors to bootstrap
context. Reopening a workspace in the same Host context does not repeat the
descriptors, but the previously advertised guides remain valid.

The fingerprint is also a stale-Host-schema diagnostic. If `open_workspace`
reports a capability such as `filesystem.rename-move` but the Host's current
MCP tool snapshot does not expose `rename`, the server and Host metadata are out
of sync. Refresh/reconnect the MCP integration or start a Host context that
reloads `tools/list`; do not conclude that the running ForgeRelay server lacks
that capability. ForgeRelay can report its own version/capabilities but cannot
force the Host to discard a cached tool schema.

## Agent Skills

ForgeRelay discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- the active ForgeRelay config directory's `skills` folder
- `FORGERELAY_AGENT_DIR/skills` (defaults to `~/.codex/skills`)
- paths from `FORGERELAY_SKILL_PATHS`

When a task matches an advertised skill, read its `SKILL.md` before using other
files in the skill directory.

`FORGERELAY_SKILLS=0` hides skills.

## Local subagent profiles

With `FORGERELAY_SUBAGENTS=1`, profiles are discovered from the active global
config directory plus:

```text
.forgerelay/agents/*.md
.devspace/agents/*.md   # migration compatibility
```

The workspace result exposes only compact profile metadata so the host can
choose a provider/profile without loading full provider launch details. Read the
ForgeRelay-owned `subagents` capability guide when delegation is actually needed;
0.3 no longer auto-loads the historical bundled `subagent-delegation` Skill for
new setups. Existing user-authored or previously seeded Skills remain normal
user configuration and are not deleted.

The current model-facing delegation workflow is:

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

A first-class MCP subagent interface is planned so this CLI indirection can be
removed.

## Tool modes

Default `FORGERELAY_TOOL_MODE=minimal` exposes:

```text
open_workspace
close_workspace
read
write
edit
rename
delete
bash
capability
```

In minimal mode, normal shell inspection commands such as `rg`, `find`, and `ls`
can be used rather than dedicated MCP search tools. `bash(action="run")` (or plain
`bash`, since `run` is the default) waits in the foreground for at most 300 seconds.
If the command is still running, ForgeRelay returns a canonical `processId` without
killing it. Reuse `bash(action="process", processId=...)` to poll/wait, send input,
resize a PTY, or interrupt the existing process; or continue other work and consume
the one-shot completion notice from a later result in the same workspace.

`FORGERELAY_TOOL_MODE=full` is retained as a compatibility value and exposes the
same canonical 9-tool surface as `minimal`; use `bash` for search and directory
inspection.

Experimental `FORGERELAY_TOOL_MODE=codex` keeps its Codex-shaped compatibility
surface, including direct `rename`/`delete` path mutations alongside `apply_patch`,
`exec_command`, and a compatibility `write_stdin` process adapter. `rename` is the
unified move/rename primitive for both files and directories; ForgeRelay does not
expose a separate `move` tool.

Workspace IDs are logical conversation handles rather than physical-directory
identities. The same conversation keeps a stable ID for a project, while another
conversation normally receives a different ID pointing at the same checkout or
worktree. `open_workspace` can explicitly resume a known `workspaceId`, and a
fresh logical ID is created only when the user asks for one. When a project has
other logical workspaces idle for more than two days, `open_workspace` reports
all of them so the user can choose to resume or clean them up. `close_workspace`
is the single public close operation: checkout-backed workspaces release the logical
handle, while managed-worktree-backed workspaces require `commitMessage` and run the
safe commit / fast-forward-only integration / cleanup lifecycle.

Shell commands are allowed to modify ordinary project files when that is a
natural part of the user's requested development task; ForgeRelay does not apply
a blanket ban to package managers, generators, formatters, or similar commands
that write files. They may also perform external device or hardware mutations
when the user's current request explicitly asks for the actual device-changing
operation. A check, audit, probe, backup, verification, dry-run, or build-only
request does not implicitly authorize a later persistent device write, and
ForgeRelay does not assume a particular flashing protocol or transport.

The Agent contract still prohibits shell mutation of security- or
privilege-sensitive operating-system files and credential material, and requires
an explicit user request before changing configuration files through `bash` or
`exec_command`.

## Change review UI

By default `FORGERELAY_WIDGETS=full` attaches ChatGPT Apps-compatible UI to the
normal workspace/file/edit/shell tools.

`FORGERELAY_WIDGETS=changes` enables aggregate `review.changes` Capability results
and keeps widget usage focused on workspace/change review.

`FORGERELAY_WIDGETS=off` disables widget UI.

## Legacy configuration

`FORGERELAY_*` is the canonical environment-variable prefix. Equivalent
`DEVSPACE_*` variables remain accepted as fallbacks during migration.

Likewise, an existing `~/.devspace` configuration/state setup is reused when the
new ForgeRelay location does not yet exist. See
[Configuration Reference](configuration.md) for the compatibility rules.
