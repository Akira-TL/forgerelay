# ChatGPT Coding Workflow

ForgeRelay gives ChatGPT and other MCP hosts a local coding workspace with an
explicit lifecycle instead of treating every request as a fresh temporary
checkout.

## Workspace identity

`open_workspace` returns a `workspaceId`. Continue using that ID for later tools
in the same directory.

Workspace identity follows the canonical opened directory rather than the
conversation/request identity. Reopening the same checkout reuses the same
active workspace even from another conversation. Conversation metadata is used
only to decide whether bootstrap context such as project instructions should be
repeated to that conversation.

A Git worktree directory is a separate workspace identity from its source
checkout.

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

After the task is complete and verified, call `close_worktree` with the managed
workspace ID and a commit message.

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
choose a provider/profile without loading full provider launch details.

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
write_stdin
close_worktree
```

The exact lifecycle tools available depend on the active server configuration.
In minimal mode, normal shell inspection commands such as `rg`, `find`, and `ls`
can be used rather than dedicated MCP search tools. `bash` waits in the foreground
for at most 300 seconds. If the command is still running, ForgeRelay returns a
process `sessionId` without killing it. The Agent can use `write_stdin` to poll,
wait again, interact, or explicitly send Ctrl-C, or continue other work; once the
command finishes, its completion is attached to a later tool result using the
same workspace ID.

`FORGERELAY_TOOL_MODE=full` adds dedicated search/directory tools.

Experimental `FORGERELAY_TOOL_MODE=codex` provides a smaller Codex-shaped
surface including direct `rename`/`delete` path mutations alongside `apply_patch`,
`exec_command`, and `write_stdin`.

Workspace IDs are logical conversation handles rather than physical-directory
identities. The same conversation keeps a stable ID for a project, while another
conversation normally receives a different ID pointing at the same checkout or
worktree. `open_workspace` can explicitly resume a known `workspaceId`, and a
fresh logical ID is created only when the user asks for one. When a project has
other logical workspaces idle for more than two days, `open_workspace` reports
all of them so the user can choose to resume or clean them up. `close_workspace`
releases only the logical handle; the last handle for a physical worktree cannot
be released that way and must be finalized with `close_worktree`.

Shell commands are allowed to modify ordinary project files when that is a
natural part of the user's requested development task; ForgeRelay does not apply
a blanket ban to package managers, generators, formatters, or similar commands
that write files. The Agent contract still prohibits shell mutation of
security- or privilege-sensitive operating-system files and credential material,
and requires an explicit user request before changing configuration files
through `bash` or `exec_command`.

## Change review UI

By default `FORGERELAY_WIDGETS=full` attaches ChatGPT Apps-compatible UI to the
normal workspace/file/edit/shell tools.

`FORGERELAY_WIDGETS=changes` exposes aggregate `show_changes` behavior and keeps
widget usage focused on workspace/change review.

`FORGERELAY_WIDGETS=off` disables widget UI.

## Legacy configuration

`FORGERELAY_*` is the canonical environment-variable prefix. Equivalent
`DEVSPACE_*` variables remain accepted as fallbacks during migration.

Likewise, an existing `~/.devspace` configuration/state setup is reused when the
new ForgeRelay location does not yet exist. See
[Configuration Reference](configuration.md) for the compatibility rules.
