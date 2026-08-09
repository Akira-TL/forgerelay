# ForgeRelay Roadmap

ForgeRelay is the local development control plane between an MCP host and the
user's real development environment. The project intentionally stays focused on
workspace, filesystem, process, Git, code-intelligence, hook, and delegated
local-agent capabilities rather than rebuilding the host model runtime.

## Architecture boundary

The MCP host owns capabilities such as:

- reasoning and conversation;
- planning and asking the user questions;
- web and multimodal tools;
- top-level conversation lifecycle and compaction.

ForgeRelay owns capabilities such as:

- workspace identity and persistence;
- filesystem operations;
- local process execution;
- Git and managed worktrees;
- review/checkpoint primitives;
- code intelligence;
- lifecycle hooks;
- provider-backed local subagents.

Long-term memory is intentionally outside ForgeRelay. A separate context system
can be integrated later without coupling memory policy to the local coding
runtime.

## Explicit non-goals

ForgeRelay does not plan to add:

- an operating-system shell sandbox;
- a project memory/autonomous memory system;
- a plugin marketplace/runtime;
- a second conversation/session runtime;
- host-owned commands such as plan mode, context inspection, or model selection;
- automatic installation and management of language servers.

Shell execution remains a trusted local-user capability. Workspace filesystem
containment must not be described as a shell sandbox.

## 0.1 — ForgeRelay foundation

The initial independent release establishes:

- ForgeRelay product/package/CLI identity;
- standard SemVer and tag-triggered GitHub/npm releases;
- preserved upstream MIT attribution and provenance checks;
- directory-based workspace reuse;
- checkout-first behavior;
- branch-backed managed worktrees using `forgerelay/*` branches;
- safe `close_worktree` fast-forward lifecycle;
- persisted worktree branch/target metadata;
- existing local coding-agent profile/provider integration;
- compatibility with legacy DevSpace configuration/state identifiers.

## 0.2 — Hooks v1

Hooks provide a general policy extension point without hardcoding
project-specific commands into Git/workspace logic. Hooks v1 is configured from
user-controlled ForgeRelay configuration; repository contents are not treated as
an implicit command-execution source.

Events:

- `WorkspaceOpen`
- `BeforeTool`
- `AfterTool`
- `AfterToolFailure`
- `AfterFileChange`
- `BeforeWorktreeClose`
- `AfterWorktreeClose`
- `SubagentStart`
- `SubagentStop`

Handler type:

- local command, sequentially executed with bounded timeouts and lifecycle
  context supplied through environment variables.

The implementation keeps the hook engine contract separate from MCP tool
handlers. `BeforeTool` and `BeforeWorktreeClose` are blocking enforcement points;
after-events are observational and never pretend to roll back completed work.
HTTP/prompt/agent-style handlers can be evaluated later if there is a concrete
need.

`BeforeWorktreeClose` is the natural place for user-configured test, typecheck,
formatting, or security verification before a managed branch is integrated.

## 0.3 — LSP code intelligence v1

LSP is moderate implementation complexity if ForgeRelay does not become a
language-server installer.

The first version should launch only language servers already available on the
user's machine or explicitly configured by the user/project.

Initial operations:

- diagnostics;
- definition;
- references;
- document symbols;
- workspace symbols;
- hover/type information.

Prefer one deep MCP capability such as:

```text
code_intelligence({
  workspaceId,
  operation,
  path,
  line,
  column,
  query
})
```

rather than one MCP tool per language or language-server method.

Candidate servers include `typescript-language-server`/tsserver, Pyright,
`rust-analyzer`, `gopls`, and `clangd`, but ForgeRelay should treat server
commands/configuration as external dependencies.

## 0.4 — First-class subagent MCP

ForgeRelay already owns provider adapters and resumable local agent sessions.
The next step is to remove the current `bash -> forgerelay agents ...` indirection
for MCP hosts.

A compact interface should reuse the existing provider adapter registry:

```text
subagent({
  action: "run" | "list" | "show" | "cancel",
  workspaceId,
  profile,
  provider,
  prompt,
  agentId
})
```

The parent agent chooses an available provider/profile such as Codex or Claude.
ForgeRelay launches, tracks, resumes, and cancels the provider-backed worker when
the underlying provider supports those operations.

This is intentionally provider-backed delegation, not an attempt to emulate a
host-native subagent implementation.

## Worktree and history refinements

These can land alongside the main release lines when the underlying interfaces
are ready:

- `.worktreeinclude`-style explicit copying of selected gitignored files;
- hook-backed worktree close verification;
- stale managed-worktree recovery and cleanup;
- checkpoint/list/restore primitives based on the existing Git snapshot engine;
- retention/GC for stale workspace sessions, conversation bindings, and review
  refs.

Checkpoint restore must protect concurrent/external user edits rather than
blindly overwriting a working tree.

## Later: task orchestration

After first-class subagents are stable, ForgeRelay may add a small persistent
task graph for parent/worker coordination:

- task identity/title/status;
- dependencies;
- assigned local-agent session;
- workspace/worktree association;
- structured result/error state.

Start with DAG-style parent/child orchestration. Peer-to-peer agent-team messaging
should only be added if real workflows demonstrate that the simpler task model is
insufficient.

## Compatibility policy

New public names use ForgeRelay:

- `@akira-tl/forgerelay`
- `forgerelay`
- `FORGERELAY_*`
- `~/.forgerelay`
- `.forgerelay`
- `forgerelay/*` managed branches

Legacy `DEVSPACE_*`, `~/.devspace`, `.devspace`, old managed branch names, and
selected persisted internal identifiers remain readable during migration where
removing compatibility would orphan real user state.
