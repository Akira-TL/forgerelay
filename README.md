# ForgeRelay

**Give MCP coding agents a real local workspace.**

[![npm](https://img.shields.io/npm/v/%40akira-tl%2Fforgerelay?style=flat-square)](https://www.npmjs.com/package/@akira-tl/forgerelay)
[![Release](https://img.shields.io/github/actions/workflow/status/Akira-TL/forgerelay/release.yml?style=flat-square&label=release)](https://github.com/Akira-TL/forgerelay/actions/workflows/release.yml)
[![License](https://img.shields.io/npm/l/%40akira-tl%2Fforgerelay?style=flat-square)](LICENSE)

ForgeRelay is a self-hosted MCP server that lets ChatGPT and other MCP-capable
hosts work on the repositories already on your machine. The host gets explicit
tools for files, shell commands, Git, managed worktrees, change review, and
optional local-agent delegation. Your project stays in your normal development
environment, with the same compilers, package managers, credentials, and Git
installation you already use.

It is not a model and it is not another coding-agent UI. ForgeRelay sits between
the host and your local development tools and handles the parts that need to run
on your machine.

> [!NOTE]
> ForgeRelay is an independently maintained derivative of the MIT-licensed
> [Waishnav/devspace](https://github.com/Waishnav/devspace) project. It is not an
> official DevSpace release. The original copyright notice and license are kept
> in [LICENSE](LICENSE), with additional provenance in [NOTICE.md](NOTICE.md).

## Quick start

ForgeRelay requires Node `>=22.19 <27`, npm, Git, and a Bash-compatible shell.

Install it globally:

```bash
npm install -g @akira-tl/forgerelay
```

Then configure and start it:

```bash
forgerelay init
forgerelay serve
```

Or run it directly with `npx`:

```bash
npx @akira-tl/forgerelay init
npx @akira-tl/forgerelay serve
```

The default local MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

If the MCP host cannot reach localhost, put ForgeRelay behind a public HTTPS
tunnel or reverse proxy such as Cloudflare Tunnel, ngrok, Pinggy, Tailscale
Funnel, or your own proxy. During setup, enter the public origin without `/mcp`:

```text
https://your-tunnel-host.example.com
```

The client then connects to:

```text
https://your-tunnel-host.example.com/mcp
```

ForgeRelay uses an Owner-password OAuth approval flow. `forgerelay init` prints
the password and stores it in the active config directory. New installations use:

```text
~/.forgerelay/config.json
~/.forgerelay/auth.json
```

Keep `auth.json` private.

## What it gives an MCP host

Once a workspace is open, the host can:

- read, create, edit, and search files inside that workspace;
- run your local tests, builds, package scripts, Git commands, and shell tools;
- reuse the same workspace when the same checkout is opened again;
- follow repository instructions from `AGENTS.md` and `CLAUDE.md`;
- discover Agent Skills and configured local subagent profiles;
- create a branch-backed Git worktree when you explicitly ask for isolated or
  parallel work;
- close a managed worktree by committing its remaining changes and
  fast-forwarding the target branch when that can be done safely;
- show aggregate changes through optional ChatGPT Apps-compatible UI cards;
- run user-configured lifecycle hooks around tool calls, file changes, managed
  worktree close, and local subagent execution.

Normal work happens in your existing checkout. ForgeRelay does not silently move
every task into a worktree.

### Progressive MCP context

ForgeRelay keeps the callable MCP surface and its low-frequency operating manuals
separate. `tools/list` remains the source of truth for tools the current server
actually exposes. `open_workspace` returns a compact version/capability fingerprint
and, on bootstrap, short descriptors for relevant ForgeRelay capability guides.
The Agent can load a task-specific guide with `read` instead of receiving every
Hook, worktree, subagent, artifact, OAuth, MCP App, PTY, and process edge case on
every connection.

The fingerprint also helps diagnose stale MCP Host metadata: if the running server
reports a semantic capability but the Host still shows an older tool snapshot,
refresh or reconnect the integration rather than assuming the capability is
missing from ForgeRelay.

## LSP code intelligence

ForgeRelay 0.4 LSP v1 exposes semantic code navigation through the
`code.intelligence` Capability without adding language-specific top-level MCP tools.
The v1 operations are definition, hover/type information, references, document
symbols, workspace symbols, and diagnostics. Results use ForgeRelay-owned normalized
locations, ranges, symbols, hover content, and diagnostic shapes rather than raw LSP
wire unions.

Language servers remain external dependencies. ForgeRelay can discover
`typescript-language-server`, `pyright-langserver`, `rust-analyzer`, `gopls`, and
`clangd` when they already exist on `PATH`, or use structured project/global
configuration, but it never installs a server automatically. See
[Configuration Reference](docs/configuration.md#lsp-code-intelligence) and
[`examples/language-servers.json`](examples/language-servers.json).

## Worktrees without the usual cleanup mess

A new managed worktree gets its own `forgerelay/*` branch instead of a detached
HEAD. It remains visible from the source repository with ordinary Git commands:

```bash
git worktree list
git branch
```

When `close_workspace` succeeds for a managed-worktree-backed workspace, ForgeRelay:

1. checks that the source checkout is clean and still on the expected target branch;
2. commits any remaining worktree changes;
3. checks that the target can advance without a merge commit or conflict;
4. fast-forwards the target branch;
5. removes the worktree and the already-merged managed branch.

If the histories have diverged, the close is refused and the worktree is left in
place. ForgeRelay does not put the source checkout into a merge-conflict state.
You can rebase and verify inside the worktree, then retry the close.

## Lifecycle hooks

Hook 是 ForgeRelay 的自动生命周期规则。首选方式是一个 Hook 一个文件：全局放在 `~/.forgerelay/hooks/<hook-name>.json`，项目放在 `<repo>/.forgerelay/hooks/<hook-name>.json`。文件名就是 Hook 名，方便直接从目录看出每条规则的用途；全局与项目规则组合执行，不需要额外批准。

例如项目里的 `.forgerelay/hooks/release-tag-local-ci.json` 可以要求稳定版本 tag push 前先完成本地发布检查：

```json
{
  "event": "BeforeTool",
  "matcher": {
    "tool": "bash",
    "commandRegex": "git\\s+push\\s+origin\\s+v\\d+\\.\\d+\\.\\d+"
  },
  "command": "npm run release:verify",
  "timeoutSeconds": 300,
  "report": true
}
```

命中 `BeforeTool` 后，Hook 先执行；成功才继续原始 `git push`，失败则直接阻断。Hook 结果会回到 Agent，Agent 应向用户说明重要 Hook 是否通过或阻断了操作。`report:false` 可以隐藏不重要的成功报告，但阻断失败始终可见。

旧的 inline `hooks` 和聚合 `hooks.json` 仍兼容；新配置建议都用独立 `hooks/*.json` 文件。

可以直接检查当前全局与项目规则，而不会执行 Hook：

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
```

`list` 展示实际加载的规则、matcher、timeout、report 与 command；`check` 只校验配置并在发现坏文件时返回非零状态。完整 matcher、事件与环境变量见 [Configuration Reference](docs/configuration.md#lifecycle-hooks)。

## Local coding agents

ForgeRelay can delegate work to local coding runtimes through user-defined
profiles. The current adapter layer supports Codex, Claude, OpenCode, Pi,
Cursor, and Copilot where the corresponding local integration is available.

Profiles can live in:

```text
~/.forgerelay/agents/*.md
.forgerelay/agents/*.md
```

The current CLI workflow is:

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

A first-class MCP subagent interface is planned so a parent agent can use the
same runtime without going through the CLI.

See [Agent Profile Schema](docs/agent-profile-schema.md) for the profile format.

## Configuration and upgrades from DevSpace

New configuration uses the `FORGERELAY_*` prefix. For example:

```bash
FORGERELAY_ALLOWED_ROOTS="$HOME/projects" \
FORGERELAY_PUBLIC_BASE_URL="https://forge.example.com" \
forgerelay serve
```

Existing `DEVSPACE_*` variables are still accepted as fallbacks during the
rename transition. When both names are present, `FORGERELAY_*` wins.

The same rule applies to persisted configuration. ForgeRelay prefers
`~/.forgerelay`, but if that directory does not exist and an existing
`~/.devspace` setup does, ForgeRelay keeps using the legacy directory rather
than orphaning OAuth credentials, workspace state, or managed worktrees.

Project-level `.devspace/agents` profiles are also still readable for migration
compatibility. New project configuration should use `.forgerelay`.

See [Configuration Reference](docs/configuration.md) for all supported options.

## Security model

A connected MCP host can make real changes to local projects through ForgeRelay,
using the same local account that runs the server. That trust boundary matters.

Filesystem tools enforce configured workspace and allowed-root boundaries. Shell
commands are different: they run with the authority of your local user and are
**not** contained by an operating-system sandbox added by ForgeRelay.

Only connect hosts you trust, keep the Owner password private, and expose only
the project roots you actually want the host to use.

See [Security Model](docs/security.md) for the full boundary and threat model.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| Linux | Supported | Requires Node, npm, Git, and Bash. |
| macOS | Supported | Requires Node, npm, Git, and Bash. |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only | Not supported yet | Install Git Bash or use WSL. |

You can check the local runtime with:

```bash
forgerelay doctor
```

## Where ForgeRelay is going

With LSP code intelligence established in the 0.4 line, the next additions remain
focused on making the local execution layer more useful, not on turning ForgeRelay
into another all-in-one agent framework:

1. first-class MCP subagent delegation;
2. stronger worktree verification and recovery;
3. checkpoint/rewind and retention improvements.

ForgeRelay does not plan to add its own shell sandbox, long-term memory system,
or plugin marketplace. Conversation, planning, web access, and other host-native
capabilities stay with the MCP host. Long-term context can be provided by a
separate service instead of being mixed into the workspace runtime.

See [Roadmap](docs/roadmap.md) for the current plan.

## Releases

ForgeRelay uses standard SemVer, starting at `0.1.0`.

Prepare a release with:

```bash
npm run release:check
npm run release:patch
npm run release:minor
npm run release:major
npm run release:verify
```

Daily branch pushes do not run cloud CI. When preparing a release, run the full
local release verification first. `release:verify` includes a focused parity pass
in an isolated Node 22.19.0 environment with its own `npm ci`, matching the cloud
CI runtime for native addons and high-risk LSP lifecycle tests. Pushing a matching
`vX.Y.Z` tag to `Akira-TL/forgerelay` is the only cloud CI and publish trigger:
GitHub Actions runs the reusable multi-platform CI, then publishes
`@akira-tl/forgerelay` and creates the matching GitHub Release only after CI
succeeds.

See [Versioning and Release Management](docs/versioning.md) for the bootstrap and
Trusted Publishing setup.

## Documentation

- [Setup Guide](docs/setup.md)
- [Local Debugging and 7677 Acceptance](docs/debugging.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Agent Profile Schema](docs/agent-profile-schema.md)
- [Native File Download](docs/artifact-exchange.md)
- [Security Model](docs/security.md)
- [Troubleshooting](docs/gotchas.md)
- [Roadmap](docs/roadmap.md)
- [Versioning and Release Management](docs/versioning.md)
- [Changelog](CHANGELOG.md)
- [Attribution Notice](NOTICE.md)

## Upstream and attribution

ForgeRelay is based on the original
[Waishnav/devspace](https://github.com/Waishnav/devspace) project by Waishnav,
released under the MIT License. ForgeRelay has its own name, package, release
stream, runtime changes, and roadmap, but the upstream provenance remains part of
the project.

The original copyright notice remains in [LICENSE](LICENSE). See
[NOTICE.md](NOTICE.md) for the attribution and modification notice.

## Local development

```bash
npm install --include=dev
npm run dev
npm run debug:accept
npm run typecheck
npm test
npm run build
```

`npm run dev` uses the checked-in local debug configuration and binds ForgeRelay
to `127.0.0.1:7677`, keeping the normal `7676` product port free. The
`debug:accept` command starts a temporary 7677 server and sends real
HTTP/OAuth/MCP requests through it, including workspace tools, managed worktree
close, and Hooks v1 lifecycle recording. Debug state stays under the gitignored
`.forgerelay-debug/` directory.

See [Local Debugging](docs/debugging.md) for the exact configuration and scripts.
