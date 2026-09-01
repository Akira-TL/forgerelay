# ChatGPT Coding Workflow

ForgeRelay gives ChatGPT and other MCP hosts a local coding workspace with an
explicit lifecycle instead of treating every request as a fresh temporary
checkout.

## Workspace identity

`open_workspace` returns a `workspaceId`. Continue using that ID for later tools
in the same directory.

`workspaceId` identifies a persistent ForgeRelay Workspace rather than a
conversation-scoped handle. A canonical checkout path maps to one checkout
Workspace, and a managed worktree path maps to one managed-worktree Workspace.
Different Host conversations may bind to and reuse the same `workspaceId`; pass a
known ID explicitly when the user wants to resume that Workspace. Historical
duplicate IDs created by older ForgeRelay versions are accepted during migration
and resolve to the canonical Workspace identity.

A Git worktree directory is a separate physical Workspace target from its source
checkout. Separate parallel identities require separate managed worktrees rather
than multiple logical handles pointing at one physical target.

### Bootstrap context and workspace inventory

Normal coding still starts with the shortest path:

```text
open_workspace(path="~/project")
```

The default `context="auto"` keeps the first useful bootstrap while avoiding
replay. ForgeRelay tracks delivered context by conversation plus canonical
Workspace target and a content fingerprint, independently from persistent
Workspace identity. Different conversations may reuse the same `workspaceId` while
each receives the current bootstrap once. If loaded instruction contents or
relevant Skill, Capability guide, profile, diagnostic, or nested-instruction
metadata changes, the next automatic open returns the refreshed bootstrap.

Two explicit controls are available for exceptional cases:

```text
open_workspace(workspaceId="ws_...", context="full")
open_workspace(workspaceId="ws_...", context="none")
```

`full` forces a bootstrap refresh. `none` opens/resumes the Workspace without
returning the full project context and does not record the current fingerprint as
already delivered. Context-delivery state remains conversation-scoped and does not
change the persistent Workspace identity.

Do not enumerate Workspace state on every normal open. Use the same Core tool in
inventory mode only when the user wants to discover known Workspaces, continue earlier
work, or organize accumulated state:

```text
open_workspace(action="list")
open_workspace(action="list", root="~/project")
open_workspace(action="list", staleOnly=true)
```

Inventory is paginated, defaults to 50 entries, and caps each page at 100. It can
filter by `workspaceId`, persisted `status`, derived `state`, `mode`, canonical
root/source root, or stale-only state. Entries include a compact label such as
`project/ws_...`, checkout/worktree backing metadata, timestamps, idle duration,
root validity, and whether that Workspace is currently selected by this
conversation. Listing is observational and does not refresh `lastUsedAt`.

When one known Workspace needs more bounded detail but must not be opened or resumed,
use `open_workspace(action="inspect", workspaceId="...")`. Inspection is a strict
allowlist projection: ordinary/worktree lifecycle metadata, Composite member
summaries, safe Relay presentation metadata, and an existing Task List summary may be
returned. It does not return bootstrap instructions, Skills, Capability guides,
Subagent bodies, files, process/Activity output, credentials, routes, or Task bodies;
it does not bind the conversation, mark bootstrap delivered, refresh `lastUsedAt`, or
grant execution authority. Explicitly open the target Workspace before mutating or
executing against it.

Treat persisted status and derived state separately. `status="active"` means the
record has not been explicitly closed. A valid recent record has `state="active"`;
a valid active record idle for more than two days has `state="stale"`; an active
record whose root is missing or unusable has `state="invalid"`; and an explicitly
finalized persisted record has `state="closed"`. Ask the user before cleanup, then
use the existing `close_workspace` lifecycle on the selected `workspaceId`.

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

A successful managed close now preserves the Workspace identity as `closed` even
though the physical worktree and managed branch are removed. Reopen that Workspace
with `open_workspace(workspaceId="ws_...")`; ForgeRelay creates fresh worktree
backing from the recorded source/target relationship and returns the same Workspace
ID. If the source checkout or target branch can no longer provide valid backing, the
open fails and the durable Workspace record remains closed.

`close_workspace(action="delete")` is never an implicit discard for active isolated
work. An active managed worktree still requires `commitMessage` and completes the
same safe finalize/integrate/cleanup lifecycle before ForgeRelay deletes its identity.
For an already-closed managed-worktree Workspace, delete removes only ForgeRelay-owned
state and does not recreate the physical backing.

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

To keep broad workspaces such as `~` fast, initial nested-instruction discovery is
bounded to direct child directories instead of recursively walking the whole tree.
Deeper `AGENTS.md` / `CLAUDE.md` files are discovered lazily along a path the first
time the Agent accesses it, and already-scanned directories are cached for the life
of that workspace handle. A `read` result carries any newly discovered local
instructions before the requested file content. Side-effecting file tools and shell
commands discover instructions before execution; if new local instructions are
found, ForgeRelay returns them and requires the Agent to retry, so the side effect
does not occur before the relevant instructions are known. `FORGERELAY_AGENT_DIR`
is not an instruction source; it remains only a compatibility skill-discovery path.

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
context. Bootstrap replay follows the conversation/canonical-target context
fingerprint described above, so changing logical `workspaceId` alone does not
repeat unchanged descriptors; previously advertised guides remain valid.

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

With `FORGERELAY_SUBAGENTS=1`, profiles are discovered from the active ForgeRelay
global config directory plus:

```text
.forgerelay/agents/*.md
```

Rename-era `.devspace/agents` discovery has ended.

The workspace result exposes only compact profile metadata so the host can
choose a provider/profile without loading full provider launch details. Read the
ForgeRelay-owned `subagents` capability guide when delegation is actually needed;
0.3 no longer auto-loads the historical bundled `subagent-delegation` Skill for
new setups. Existing user-authored or previously seeded Skills remain normal
user configuration and are not deleted.

Host 正常委派通过现有 `capability` Gateway 中的 `subagent.session` 完成，不增加新的 Core MCP tool。支持的生命周期操作包括 `start`、`resume`、`status`、`list`、`stop` 和 `delete`；具体参数与 provider continuation 能力以 `subagents` capability guide 为准。

`forgerelay agents` CLI 继续保留给本地诊断和兼容场景，但 first-class MCP 路径不会通过 `bash -> forgerelay agents ...` 间接执行。Subagent Session 绑定实际 Execution Workspace，provider 原生 session/thread 保存 conversation history，ForgeRelay 只持久化必要的 ownership、continuation 和当前执行协调元数据。

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
`bash`, since `run` is the default) separates feedback from execution lifetime:
`yieldTimeMs` controls how long to wait before returning a canonical `processId`
(default 10 seconds; use `0` when intentionally starting background work), while
optional `timeoutMs` independently caps total process runtime. A routine command can
use a longer feedback window such as 60 seconds when that remains below the Host
request deadline. Reuse `bash(action="process", processId=...)` to poll incremental
output/wait, send input, resize a PTY, or interrupt the existing process; or continue
other work and consume the one-shot completion notice from a later result in the same
workspace. Full completed output is retained for five minutes and then compacted to a
bounded completion record that remains deliverable for up to 24 hours.

`FORGERELAY_TOOL_MODE=full` is retained as a compatibility value and exposes the
same canonical 9-tool surface as `minimal`; use `bash` for search and directory
inspection.

Experimental `FORGERELAY_TOOL_MODE=codex` keeps its Codex-shaped compatibility
surface, including direct `rename`/`delete` path mutations alongside `apply_patch`,
`exec_command`, and a compatibility `write_stdin` process adapter. `rename` is the
unified move/rename primitive for both files and directories; ForgeRelay does not
expose a separate `move` tool.

Workspace IDs are persistent ForgeRelay identities. The same canonical checkout
or managed worktree is reused across conversations; older duplicate IDs remain
compatibility aliases that resolve to the canonical Workspace. `newWorkspace` is
deprecated and no longer allocates a second identity for the same physical target;
use `newWorktree=true` when genuinely separate Git isolation is required. The
normal open path may still include `staleWorkspaces` for an idle persistent
Workspace; use `open_workspace(action="list")` for complete, filtered inventory
when continuation or cleanup actually requires it.

For checkout-backed Workspaces, `close_workspace` defaults to `action="close"` and
preserves the Workspace identity for later reopen. A closed Workspace stays visible
through `open_workspace(action="list")`, while ordinary execution tools reject it
until `open_workspace` reactivates the same ID by path or by `workspaceId`.
`close_workspace(action="delete")` is the explicit permanent checkout cleanup path:
it removes ForgeRelay-owned Workspace state but never deletes or mutates project
files. Managed-worktree close still requires `commitMessage` and runs the safe commit /
fast-forward-only integration / cleanup lifecycle. Composite close preserves the same
`cws_...` identity and member topology; Composite `action="delete"` dissolves only
Composite-owned state without touching member Workspaces. Relayed delete remains a later
lifecycle stage.

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

`FORGERELAY_*` is the canonical environment-variable prefix. Rename-era
`DEVSPACE_*` fallbacks and automatic `~/.devspace` reuse have ended. Migrate
older installations explicitly; persisted internal identifiers that would
otherwise orphan state remain compatible. See
[Configuration Reference](configuration.md) for the current rules.
