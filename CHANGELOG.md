# Changelog

All notable ForgeRelay changes are documented here.

## [Unreleased]

### Added

- `subagent.session stop/delete` 提供真实 Run 取消和显式 ForgeRelay Session 清理；取消后可继续 resume，active Session 不能直接 delete。

### Changed

- `SubagentStart` / `SubagentStop` 按 Run 触发，只携带有界身份与状态元数据；不传 prompt、response 或 provider session ID。
- `delete` 只清理 ForgeRelay coordination/mailbox，provider-native conversation history 保持不变。

## [0.7.1] - 2026-08-30

### Added

- `subagent.session resume` 现在基于 provider-native continuation 继续已有 Session；Codex、Claude、OpenCode、Pi 支持真实 continuation，Cursor/Copilot 明确保持 start-only。

### Changed

- Session 固定创建时的 provider/profile/model/thinking，并严格限制在所属 Execution Workspace；busy resume、跨 Workspace 访问和不受支持的 continuation 都返回明确错误。

### Fixed

- Windows restart mailbox 测试在清理临时 SQLite state 前显式关闭 restored server，避免 `EBUSY`。

## [0.7.0] - 2026-08-30

### Added

- 新增 first-class `subagent.session` Capability tracer：Host 可通过现有 Capability Gateway 发现并启动 provider-backed Subagent Session、查询 `status`、列出当前 Execution Workspace 拥有的 Session，并通过有界单次 delivery mailbox 接收后台 Run 的最终结果；canonical Core MCP tool 仍保持九个。
- 为 ForgeRelay Subagent 引入稳定的 Session / Run identity 和 workspace-scoped coordination，使每次 delegated execution 都有明确的 Run 生命周期、Activity 关联和 provider continuation 映射，而无需经由 `bash -> forgerelay agents ...` CLI 间接执行。

### Changed

- 将 Claude Code、Codex、OpenCode、Pi 等 provider 的原生 session store 作为 conversation history 真源；ForgeRelay SQLite 停止写入 delegated prompt、profile body、final response、Hook report history 和 provider event/items，仅保留轻量 ownership、provider/profile/model/thinking 与 active/latest Run 协调元数据。
- Provider adapter contract 收敛为 continuation identity、final response 与必要执行元数据，provider streaming/messages/events 只瞬时消费；profile body 仅在 Session 首次启动时交给 provider，ForgeRelay 不保存正文副本。

## [0.6.2] - 2026-08-29

### Added

- Added Composite Workspace as a first-class Workspace kind on the existing `open_workspace` surface. A Composite Workspace has its own persistent `cws_...` identity, may start with zero members, and can mount named local, managed-worktree, or relayed Workspaces with Agent-facing purpose descriptions.
- Added explicit member routing across filesystem, capability, Bash/process, and Codex-compatible `apply_patch` / `exec_command` / `write_stdin` surfaces. The Composite Workspace ID remains Host-facing while each operation must name its execution member; ForgeRelay never selects or falls back to another member automatically.
- Added one Composite Host Turn / Activity presentation that aggregates local and remote member activity with member labels while keeping audit, process, filesystem, and remote execution facts owned by the actual member Workspace/Execution ForgeRelay.

### Changed

- `close_workspace` now dissolves a Composite Workspace without closing member Workspaces, finalizing managed worktrees, interrupting member processes, deleting files, or removing Workspace Relay routes.
- Interactive debug launchers now derive their displayed local endpoints from the selected `FORGERELAY_DEBUG_CONFIG_DIR/config.json`, allowing multiple isolated debug instances to use separate config/state/worktree directories and different ports such as 7677 and 6768.

### Fixed

- Routed Codex-compatible process and patch tools through the same Workspace Relay and Composite member resolution path as the canonical tool surface, including explicit no-fallback behavior for remote members.

## [0.6.1] - 2026-08-28

### Added

- Added Workspace Relay: register a remote ForgeRelay with `forgerelay auth`, then open a remote Workspace through the existing MCP surface with `open_workspace(..., relay="<alias>")`; direct targets and system-SSH-routed targets share the same authentication and MCP protocol.
- Added CLI remote authentication with hidden owner-token input, explicit `--token`, and SSH-assisted `--ssh-auth`; `-J` accepts one final SSH target or a full comma-separated jump route while the remote service target remains one independent `host:port`/URL value.
- Added remote routing for Workspace reads and mutations, Bash/process lifecycle and durable output, optional capabilities, Skills, Hooks, and Host Activity snapshot/detail/output queries while keeping execution facts owned by the execution ForgeRelay.
- Added restart-safe remote identity and Workspace routing: stable remote instance IDs survive alias/target changes, access tokens refresh through the existing token store, SSH tunnels are rebuilt on fresh random loopback ports, and relayed Workspace IDs remain stable across Gateway restarts.

### Changed

- Activity Panel bootstrap can reconstruct Workspace presentation from the execution instance across independent MCP connections, allowing relayed Host Turns and App-only Activity queries to follow the execution Workspace without requiring one long-lived transport session.
- ForgeRelay authentication and relayed-Workspace route files now use lock-protected read/modify/write updates with atomic replacement so concurrent CLI/server sessions do not overwrite each other.

### Security

- Remote targets, SSH routes, temporary tunnel ports, owner tokens, access tokens, refresh tokens, and execution-side Workspace IDs stay out of the model-facing relay contract; the Host sees the configured relay alias and Gateway `rws_...` identity instead.
- SSH-assisted authentication retrieves the remote owner token only into the initiating process, then reuses the normal CLI token exchange; runtime forwarding binds loopback only, and failed direct/SSH/remote operations never silently fall back to a local or different remote Workspace.

## [0.6.0] - 2026-08-27

### Added

- Added the unified ForgeRelay Panel for ChatGPT MCP App hosts: one Host Turn now keeps the Workspace Summary above a collapsible Activity Panel, groups live Activities, lazily loads detailed operation data, and streams durable Bash output without turning follow-up process control into duplicate top-level Activities.
- Added a local MCP Inspector debug host on the dedicated `127.0.0.1:7677` path so the real HTTP/OAuth/MCP App lifecycle can be inspected without touching the normal product port.
- Added release-candidate publication support: `vX.Y.Z-rc.N` tags run the normal release gate, publish npm packages on the `next` dist-tag, and create GitHub prereleases while stable releases continue to use `latest`.

### Changed

- Promoted the validated `0.6.0-rc.1` build to the stable 0.6 line without additional runtime changes.
- Skills are now advertised by name and loaded through the virtual `skills://<name>` namespace; real local Skill paths stay out of normal Agent-facing metadata, and files inside an activated Skill use `skills://<name>/<relative-path>`.
- `publicBaseUrl` may now be either one routed URL or an ordered list of routed public URLs. The first remains canonical, every configured hostname joins the Host allowlist, and the complete ordered list participates in MCP App resource identity and CSP metadata.
- Host Turn scoping now prefers Host conversation metadata, then the MCP transport session, then the current connection, preserving one Workspace-specific panel even on Hosts such as Inspector that do not provide OpenAI conversation metadata.
- When an Agent only needs to wait for an already running Bash process, `bash(action="process", processId=..., yieldTimeMs=...)` now acts as one bounded wait and reuses the same process ID if the window expires, reducing repeated short polling.

### Fixed

- Preserved routed public base paths through OAuth endpoints and local debug configuration instead of collapsing deployment URLs back to the origin.
- Preserved complete Workspace IDs in diagnostic logging and kept Activity Panel state attached across successive tool results.
- Explicit Bash process waits now honor `yieldTimeMs` even when the process has already produced buffered output, so continuously logging commands can still be efficiently awaited to completion.

## [0.6.0-rc.1] - 2026-08-27

### Added

- Added the unified ForgeRelay Panel for ChatGPT MCP App hosts: one Host Turn now keeps the Workspace Summary above a collapsible Activity Panel, groups live Activities, lazily loads detailed operation data, and streams durable Bash output without turning follow-up process control into duplicate top-level Activities.
- Added a local MCP Inspector debug host on the dedicated `127.0.0.1:7677` path so the real HTTP/OAuth/MCP App lifecycle can be inspected without touching the normal product port.
- Added release-candidate publication support: `vX.Y.Z-rc.N` tags run the normal release gate, publish npm packages on the `next` dist-tag, and create GitHub prereleases while stable releases continue to use `latest`.

### Changed

- Skills are now advertised by name and loaded through the virtual `skills://<name>` namespace; real local Skill paths stay out of normal Agent-facing metadata, and files inside an activated Skill use `skills://<name>/<relative-path>`.
- `publicBaseUrl` may now be either one routed URL or an ordered list of routed public URLs. The first remains canonical, every configured hostname joins the Host allowlist, and the complete ordered list participates in MCP App resource identity and CSP metadata.
- Host Turn scoping now prefers Host conversation metadata, then the MCP transport session, then the current connection, preserving one Workspace-specific panel even on Hosts such as Inspector that do not provide OpenAI conversation metadata.
- When an Agent only needs to wait for an already running Bash process, `bash(action="process", processId=..., yieldTimeMs=...)` now acts as one bounded wait and reuses the same process ID if the window expires, reducing repeated short polling.

### Fixed

- Preserved routed public base paths through OAuth endpoints and local debug configuration instead of collapsing deployment URLs back to the origin.
- Preserved complete Workspace IDs in diagnostic logging and kept Activity Panel state attached across successive tool results.
- Explicit Bash process waits now honor `yieldTimeMs` even when the process has already produced buffered output, so continuously logging commands can still be efficiently awaited to completion.

## [0.5.6] - 2026-08-17

### Fixed

- Repaired historical `bash_output_streams` SQLite schemas that had already recorded the Bash audit migration before later audit columns were added, preventing Bash completion from crashing ForgeRelay with `no such column: error` and avoiding ambiguous Host timeouts after commands had already executed.
- Made the background-completion retention regression wait for the process to actually finish before crossing its retention window, removing a Windows-only timing race from the release suite.

### Changed

- The `release-tag-local-ci` Hook now runs the full cloud-equivalent verification surface on an isolated Node 22.19 / npm 10.9.3 checkout before allowing a stable tag push, instead of only checking a previously recorded proof whose parity suite could omit server-level tests.

## [0.5.5] - 2026-08-15

### Added

- Added native multi-target `read`, `edit`, and `delete` operations so Agents can read several files or apply one validated edit/delete intent across multiple paths in a single interaction; bulk mutations preflight every target before the first filesystem change and report mutation-phase partial failures without claiming transactional rollback.
- Added the `batch.execute` capability for 1–100 heterogeneous Read/Write/Edit/Rename/Delete/Bash/Capability tasks with caller-controlled concurrency from 1–10, stable input-order results, continue-on-error execution, conflict-aware scheduling, conservative Bash/serial-Capability exclusivity, and Host cancellation that never invents Activities for queued work that did not start.
- Added durable parent/child Activity relationships and aggregate summaries for native bulk and Batch execution, while preserving lazy child detail, compact Bash responses plus stable `outputId`, and restart-safe local audit/query behavior.

### Changed

- Capability definitions now declare and advertise an explicit Batch policy (`parallel`, `serial`, or `unsupported`); `hooks.check` and `code.intelligence` are parallel, `review.changes` is serial, while Host-native artifact download and recursive `batch.execute` use are unsupported inside a Batch.
- Core work operations now share one internal execution seam so single MCP calls and Batch children use the same path validation, Hooks, Activity lifecycle, logging, cancellation, and result semantics instead of duplicating tool handlers.

## [0.5.4] - 2026-08-15

### Fixed

- Closed all Activity query SQLite handles before temporary-state cleanup so the backend acceptance suite also passes on Windows, where open database files cannot be unlinked.

## [0.5.3] - 2026-08-15

### Added

- Added durable Host Turn records and a stable Activity query projection backed by ForgeRelay's local SQLite audit history, with revision-based lightweight snapshots that remain queryable after ForgeRelay restarts.
- Added the production backend query contract for future MCP App UI: model-visible `activity_panel` establishes a Host Turn, while app-only `activity_snapshot`, `activity_detail`, and `activity_output` data sources expose summaries, selected lazy detail, and complete Bash output separately.

### Changed

- Activity snapshots now use an explicit summary whitelist: read bodies, write/edit patches, full Bash commands/output, and capability-heavy payloads stay out of normal snapshots; rename/delete include complete path targets and are summary-complete without detail requests.
- Late Bash completion records use the current Host Turn for delivery while preserving the original Bash Activity's immutable returned history and Workspace audit snapshot.

## [0.5.2] - 2026-08-15

### Added

- Added durable Bash output audit streams in ForgeRelay's local SQLite state: complete commands and original stdout/stderr/PTY output are retained under a stable `outputId`, can be retrieved after restart through regular Bash or Codex-compatible process tooling, and remain independent of the bounded in-memory process buffer.
- Background commands that were previously returned to the Host now produce a separate durable `bash_result` Activity exactly once when their completion is delivered, while the original Bash Activity remains historical `returned` state.

### Changed

- Normal Bash, `exec_command`, and process-control responses now keep Agent context compact by returning only the final 10 output lines plus the stable full-output identifier; explicit output lookup returns the complete persisted process output.

## [0.5.1] - 2026-08-14

### Added

- Routed ForgeRelay's top-level work operations through one persistent Activity lifecycle: read, write, edit, rename, delete, capability, Bash, and Codex-compatible execution/patch operations now record durable started/succeeded/failed/blocked/returned facts without relying on UI inference. Bash/exec process-control follow-ups remain part of the existing semantic operation instead of creating duplicate top-level Activities.

### Fixed

- Activity auditing now treats a shell process as `returned` only after its `processId` can actually be delivered to the Host; Host cancellation during post-tool delivery protection records a failed Activity and discards the undelivered process instead of leaving a false returned history entry.

## [0.5.0] - 2026-08-14

### Added

- Added the production local Activity audit foundation: append-only Audit Events persist in ForgeRelay's existing SQLite state, queryable Activity Records survive server restarts and Workspace cleanup, and success, failure, and Hook-blocked outcomes retain immutable Workspace/Host Turn execution context for later lifecycle and UI releases.

## [0.4.7] - 2026-08-11

### Added

- Added independent `bash` execution deadlines with optional `timeoutMs`; `yieldTimeMs` now remains purely a feedback window, including `yieldTimeMs: 0` for immediate background handoff to a canonical `processId`.

### Changed

- Regular `bash` now defaults to a 10-second feedback window instead of occupying a full 300-second Host request; Agent-selected waits can still be up to 300 seconds, while execution can continue without a ForgeRelay deadline when `timeoutMs` is omitted.
- Completed background processes keep full buffered output for five minutes, then compact to a bounded completion record deliverable for up to 24 hours. Completed results no longer block workspace close and are delivered with the close response when available.
- Local `release:verify` now records a proof for the committed release HEAD, while the stable-tag `BeforeTool` Hook performs only a fast proof/HEAD/version/tag check before the push instead of rerunning the multi-minute release gate inside one MCP request.

### Fixed

- Propagated Host request cancellation through lifecycle Hooks and shell process waits. If a Host cancels while a blocking `BeforeTool` Hook is still running, ForgeRelay terminates the Hook and does not execute the original tool side effect; cancellation of an initial shell run also terminates a process whose `processId` has not yet been delivered.
- Corrected `ProcessManager` yield bounding so a configured maximum also caps the default feedback window rather than only explicit `yieldTimeMs` values.
- Made the new release-proof and Hook-cancellation test harnesses use cross-platform Node path and shell invocation forms, covering Windows drive-letter paths and `cmd.exe` Hook execution as well as POSIX hosts.

## [0.4.6] - 2026-08-11

### Added

- Added published `npm run lsp:interop` acceptance for `typescript-language-server`, Pyright, `rust-analyzer`, `gopls`, and `clangd`: detected executables run through built-in discovery and real stdio LSP, while missing external servers are reported as explicit skips without automatic installation.
- Extended the real 7677 HTTP/OAuth/MCP acceptance path to execute all six `code.intelligence` v1 operations, normalized results, a stable error path, and Language-service `shutdown -> exit` behavior while keeping exactly nine Core MCP tools.

### Changed

- Cloud release CI now runs optional real-server interoperability after the normal deterministic fake-LSP test/build gate on Linux, macOS, and Windows. Executable preflight now distinguishes a runnable Language server from PATH shims/proxies that exist but fail to launch, so incomplete rustup components are skipped rather than misreported as installed servers.
- Local `release:verify` now includes an isolated Node 22.19.0 parity sandbox with its own `npm ci` and focused LSP/release regression suite; cloud CI and publication use the same Node 22.19.0 runtime to reduce local/cloud drift, while Windows test cleanup retries transient locked-directory removal.
- Completed the 0.4 LSP v1 user, configuration, roadmap, contributor, and explicit Language-server example documentation, and hardened cross-platform/concurrency acceptance timing exposed during final release validation.

## [0.4.5] - 2026-08-11

### Added

- Added Host-to-LSP cancellation propagation, bounded per-service semantic concurrency/queueing, and stable request timeout/cancellation/capacity errors without exposing arbitrary Agent-controlled timeout values.
- Added aggregate Language-service runtime telemetry for service/process/request/document/diagnostic/stderr retention without logging source contents or paths.

### Changed

- Language services now retry one unexpected server crash, enter a bounded cooldown after repeated crashes, and invalidate only affected services when the effective server-definition fingerprint changes.
- Language-service lifecycle now distinguishes truly idle services from cancellation-ignoring requests, evicts only the least-recently-used safe idle service at capacity, shares one service across logical workspaces on the same physical project, and releases managed-worktree services before finalization.
- Idle shutdown and repeated open/query/config/crash cycles now explicitly release and bound server processes, synchronized documents, diagnostic snapshots, request state, stderr tails, and service counts.

## [0.4.4] - 2026-08-11

### Added

- Added `code.intelligence` `diagnostics` with one normalized Agent-facing contract for traditional push diagnostics and LSP 3.17 pull diagnostics.
- Added bounded latest Diagnostic snapshots with per-document freshness/version metadata, replacement/clear semantics, and no historical accumulation.

### Changed

- Pull diagnostics are preferred when a Language server advertises `diagnosticProvider`; ForgeRelay sends the previous `resultId`, handles `unchanged` reports, and keeps pull state independent from asynchronous push snapshots on mixed-capability servers.
- Diagnostic collections reuse the 100 default / 1000 hard request limit while runtime caches independently bound document count and retained diagnostics per document. Filesystem synchronization makes stale push snapshots explicit and pull reports fresh against the synchronized document version.

## [0.4.3] - 2026-08-11

### Added

- Added `documentSymbols` code intelligence with hierarchy-preserving normalization for LSP `DocumentSymbol` trees and flat handling for legacy `SymbolInformation` responses.
- Added bounded `workspaceSymbols` semantic search over one selected Language service, with normalized flat symbol metadata and External location handling.

### Changed

- Symbol collection limits reuse the 100 default / 1000 hard maximum budget. Document-symbol limits count tree nodes while preserving required ancestors; workspace-symbol results expose `returned`, `truncated`, and known `total` like references.
- Workspace-symbol requests use a workspace-relative `path` to select and synchronize the Language project/service before applying the project-wide `query`; ForgeRelay does not silently merge nested Language services.

## [0.4.2] - 2026-08-11

### Added

- Added bounded `code.intelligence` `references` support through the shared Language-service path, using the same normalized location contract as definition results.

### Changed

- References default to 100 returned locations, accept an explicit limit up to 1000, and report `returned`, `truncated`, and the real `total` when the complete Language-server response is known.
- Shared semantic-location normalization now preserves External code location metadata for both definition and references without expanding ForgeRelay file authority.
- Split Language-service management from the protocol runtime so later code-intelligence operations can grow without concentrating lifecycle and request logic in one module.

## [0.4.1] - 2026-08-11

### Added

- Added `code.intelligence` `hover` support through the same shared Language-service and filesystem synchronization path as definition lookup.

### Changed

- Hover responses now normalize Markdown/plaintext `MarkupContent` and supported legacy `MarkedString` payloads into a stable Agent-facing `contents` value with optional language and normalized range metadata.
- Language Servers that do not advertise hover return `code.operation_unsupported` without invalidating the shared Language service.

## [0.4.0] - 2026-08-11

### Added

- Added `code.intelligence` as a Capability Gateway-only LSP code-intelligence surface. ForgeRelay 0.4.0 ships the first complete `definition` tracer bullet without changing the canonical nine Core MCP tools.
- Added Language-server definitions with project (`.forgerelay/language-servers.json`), global (`~/.forgerelay/config.json`), and built-in discovery precedence. Common built-ins cover TypeScript/JavaScript, Pyright, rust-analyzer, gopls, and clangd when those executables are already installed.
- Added a deterministic child-process fake LSP server and MCP-level regression seam covering initialize/shutdown, document synchronization, definition normalization, shared Language-service identity, capacity limits, and server-initiated edit rejection.

### Changed

- Code-intelligence positions use ForgeRelay's 1-based line and Unicode code-point column contract and are converted internally to the position encoding negotiated with the Language Server.
- Language services are shared by canonical Language project root plus effective server-definition fingerprint rather than logical workspace ID, remain capacity/idle bounded, and use structured no-shell process launch over Microsoft's `vscode-jsonrpc` / `vscode-languageserver-protocol` substrate.
- Language-server configuration can explicitly disable built-in discovery; nested Language projects resolve by walking ancestors of the requested source path instead of recursively scanning the Workspace.

### Fixed

- External LSP definition targets are marked as informational external locations without expanding ForgeRelay file-read authority, including symlink-escape protection and canonical Workspace-root handling.
- Language-server startup failure/timeout, unsupported operations, invalid positions, configuration ambiguity, capacity exhaustion, and other policy failures now use stable ForgeRelay `code.*` errors instead of leaking raw JSON-RPC failures.

## [0.3.7] - 2026-08-10

### Added

- Added debug-only runtime resource telemetry for RSS/V8 heap, MCP transport count, running/completed process counts, cached workspaces, and review checkpoint state so long-running deployments can identify which resource class is growing.

### Changed

- Background `bash` completion state is now retained for at most five minutes, completed process handles are released immediately, completed notices are globally bounded, active processes have a global concurrency budget, and per-process retained output is smaller. High-output head/tail truncation no longer materializes whole strings as Unicode code-point arrays, sharply reducing transient heap growth and GC pressure.
- Abandoned MCP transport sessions and in-memory review checkpoint states now have hard capacity limits. Review state is also released when its logical workspace closes, while persisted Git checkpoint refs remain available for reconstruction.
- Workspace instruction discovery is now bounded and demand-driven: `open_workspace` scans only the workspace root and direct child directories, while deeper `AGENTS.md` / `CLAUDE.md` files are discovered along paths as the Agent first accesses them. Reads surface newly discovered instructions inline; mutation and shell calls stop before side effects and require a retry after newly discovered local instructions are applied.
- Workspace/session activity timestamps now use a small in-process write-behind cache. Hot `lastUsedAt` touches are coalesced and flushed to SQLite in one transaction at most every five minutes, with an explicit final flush during normal shutdown; semantic create/close/status writes remain immediate.

### Fixed

- Expired, never-redeemed OAuth authorization codes are opportunistically evicted and cleared on provider shutdown instead of remaining in memory for the lifetime of the server.

## [0.3.6] - 2026-08-10

### Added

- `open_workspace(action="list")` now provides paginated logical-workspace inventory without adding a tenth Core tool. Inventory entries include a compact `project/workspaceId` label, persisted status, derived lifecycle state, checkout/worktree backing metadata, creation/last-used timestamps, idle duration, root validity, current-conversation selection, and filters for workspace ID, status, state, mode, root, and stale-only views.

### Changed

- Workspace bootstrap context is now deduplicated by conversation scope, canonical workspace target, and a content fingerprint instead of by logical `workspaceId`. `context="auto"` remains the default, `context="full"` forces a refresh, and `context="none"` opens or resumes a workspace without returning the full AGENTS/Skills/guide/profile bootstrap.
- Context-delivery state is persisted independently from logical-workspace selection, so switching or closing one logical handle does not make the same conversation forget already-delivered project context. Changes to loaded instruction contents or relevant Skill, guide, profile, diagnostic, or nested-instruction metadata change the fingerprint and cause `auto` to deliver the refreshed context again.
- Workspace inventory is read-only with respect to workspace activity timestamps and runs the existing idle-session GC before listing. Persisted `status="active"` continues to mean the session has not been explicitly closed, while the derived `state` distinguishes currently active, stale-but-valid, invalid/missing-root, and closed records.

## [0.3.5] - 2026-08-10

### Changed

- Regular `minimal` and `full` MCP modes now expose the same canonical 9-tool surface: `open_workspace`, `capability`, `close_workspace`, `read`, `write`, `edit`, `rename`, `delete`, and `bash`. Search and directory inspection use shell commands through `bash`; `full` remains only as a configuration-compatibility value.
- `review.changes` and `artifact.download` are now Capability Gateway-only workflows. Their dedicated top-level compatibility aliases have been removed, while review cards identify themselves as `capability` results with `capabilityName="review.changes"`.
- Capability fingerprints now report semantic runtime capabilities such as `review.changes` instead of implementation-shaped search/review tool names, and current Guides/docs/bootstrap instructions use the final Core Surface + Capability Gateway model.

### Removed

- Removed the regular dedicated `grep`, `glob`, `ls`, aggregate-review, and native-artifact MCP adapters after their canonical workflows moved to `bash` or the Capability Gateway.

### Fixed

- Successful `report: true` lifecycle Hook reports are now mirrored into the model-readable structured result as well as MCP text content, so Hosts that surface only structured tool results still expose the Hook outcome to the Agent.

## [0.3.4] - 2026-08-10

### Changed

- Regular MCP tool modes now use one `bash` interface for both command start and long-process interaction. `action="run"` preserves normal shell execution while `action="process"` polls/waits, writes input, resizes PTYs, or interrupts an existing workspace-owned `processId`; top-level `write_stdin` is no longer exposed in regular modes.
- `close_workspace` is now the single public Workspace close operation. Checkout-backed workspaces release their logical handle, while managed-worktree-backed workspaces require `commitMessage` and run the existing Hook/commit/fast-forward/cleanup lifecycle; top-level `close_worktree` is no longer exposed.
- Shell/process and managed-worktree Capability Guides, Host instructions, configuration docs, debugging acceptance, and workflow docs now use the unified process and Workspace lifecycle model.

## [0.3.3] - 2026-08-10

### Added

- Added `review.changes` and `artifact.download` as registered Capability Gateway actions. Review preserves the existing Git-backed checkpoint and diff-card metadata; native artifact ingress preserves Host-native file transport, workspace-relative no-overwrite publication, size limits, and `AfterFileChange` lifecycle reporting.

### Changed

- The Capability catalog now advertises only capabilities that are actually available in the current runtime. Explicit calls to known-but-disabled capabilities still return stable `capability_unavailable` diagnostics.
- `show_changes` and `download_artifact` remain compatibility aliases for the 0.3.3 migration window, but the artifacts/review guide now treats the Capability Gateway as the canonical Agent workflow.

## [0.3.2] - 2026-08-10

### Added

- Added a ForgeRelay-owned Capability Registry and the single `capability` MCP gateway with `describe` / `run`, stable dotted names, runtime availability, validated input contracts, guide metadata, and stable diagnostic error codes.
- `open_workspace` now returns a lightweight Capability catalog on every open. The first tracer capability, `hooks.check`, validates active global/project Hook configuration without requiring Agents to route through shell or the CLI.

### Changed

- Server instructions now direct Agents to use the Capability catalog for low-frequency actions, describing and reading only an unfamiliar capability's advertised guide before first use instead of preloading all low-frequency instructions.

## [0.3.1] - 2026-08-10

### Changed

- Release-tag Hooks now treat `commandRegex` as a command extractor as well as a filter: a matching substring becomes Hook `payload.command`, while a different full shell request is preserved as `payload.originalCommand`. This lets stable tag pushes trigger local release gates even when an Agent wraps them in a compound shell command.
- GitHub Release pages now use the matching `CHANGELOG.md` version section as their release notes instead of relying only on generated compare notes.

### Fixed

- MCP App resources now advertise a unique `_meta.ui.domain` derived from the resolved public deployment origin while preserving existing CSP, content-hashed template identity, and legacy/historical compatibility resources.
- `forgerelay doctor` now reports the resolved MCP runtime shape, including public base URL, tool/widget modes, proxy trust, and optional artifact/subagent/Skill capability switches.

## [0.3.0] - 2026-08-10

### Added

- `open_workspace` now reports a lightweight ForgeRelay version/capability fingerprint on every open, allowing Agents to distinguish a stale Host tool-schema snapshot from a missing server capability.
- ForgeRelay-owned capability guides can be loaded explicitly with the normal `read` tool. Built-in guides cover lifecycle Hooks, managed worktrees, subagents, artifact/change review, Host/OAuth/MCP App integration, and long-running shell/PTY/process behavior; optional guides are advertised only when their feature is enabled.

### Changed

- MCP bootstrap context now keeps low-frequency operational detail out of server instructions while `tools/list` remains the source of truth for the real callable tool surface. Artifact/review feature flags no longer inflate the core instruction payload.
- New setups no longer auto-seed or auto-inject the historical bundled `subagent-delegation` Skill; ForgeRelay's own subagent workflow is documented by the on-demand `subagents` capability guide. Existing user-authored or previously seeded Skills remain supported.
- Shell capability instructions now explicitly permit persistent external device or hardware mutations only when the user's current request asks for the actual device-changing operation; checks, audits, probes, backups, verification, dry-runs, and build-only requests do not implicitly authorize a later hardware write.

### Fixed

- Loopback deployments behind a public tunnel/reverse proxy now trust exactly one upstream proxy hop by default, preventing MCP SDK OAuth rate limiting from emitting `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`; explicit proxy trust also no longer maps to Express's unsafe blanket `trust proxy = true` mode.
- Local checkout builds now restore the executable bit on `dist/cli.js`, so `npm run build && npm install -g .` produces a runnable `forgerelay` command on POSIX systems.

## [0.2.6] - 2026-08-10

### Changed

- Running shell commands now expose canonical `processId` handles; `write_stdin` accepts `processId`, while the former process `sessionId` remains a deprecated compatibility alias throughout 0.2.x.
- ForgeRelay now names protocol-level MCP state as a transport session in internal/debug terminology. Workspace identity remains `workspaceId`, one-request tracing remains `requestId`, and third-party provider session identifiers are unchanged.
- Process elapsed time now uses a monotonic clock, preventing negative `wallTimeMs` values when the operating-system wall clock is adjusted while a long-running command or release Hook is executing.

## [0.2.5] - 2026-08-10

### Changed

- Human-facing `pretty` logs are workspace-first: normal tool and hook lines no longer show transient MCP transport session IDs, MCP session create/close lifecycle events are debug-only, and project names receive stable per-project terminal colors while the logical `ws_...` identifier remains visible.
- MCP App tool metadata now uses a content-hashed UI resource URI derived from the built JavaScript/CSS, advertises both `model` and `app` visibility, and includes the ChatGPT `openai/outputTemplate` compatibility alias. Legacy `ui://forgerelay/workspace-app.html` and historical `workspace-app-*.html` pointers continue to resolve to the current template so stale ChatGPT metadata snapshots do not fail with a missing resource. Debug logs now distinguish current, legacy, and historical template reads, and real acceptance exercises current/compatibility resources plus the referenced JavaScript asset.
- `~/...` paths are expanded before allowed-root resolution, so advertised skills rendered with home-relative paths can be read directly instead of being interpreted as a literal `~` directory under the workspace.
- Successful MCP session shutdown and idle-cleanup lifecycle logs moved to `debug`; individual session close failures remain visible as warnings.

## [0.2.4] - 2026-08-09

### Added

- Conversation-scoped logical workspace handles: the same conversation keeps a stable `workspaceId`, different conversations normally receive separate IDs for the same physical checkout/worktree, `open_workspace` can explicitly resume a known ID or allocate a user-requested fresh logical handle, and workspaces idle for more than two days are reported for user-directed resumption or cleanup.
- `close_workspace` releases a logical workspace handle without deleting checkout files; the last handle anchoring a physical worktree remains protected for `close_worktree`.

### Changed

- `bash` now uses ForgeRelay's process-session runtime instead of the Pi bash executor. It waits in the foreground for at most 300 seconds and, if still running, returns a `sessionId` without killing the process. `write_stdin` is available in regular tool modes to poll, wait, interact, or interrupt, and asynchronous completion is delivered once on a later tool result for the same workspace ID.

### Security

- Background-process ownership and completion delivery are scoped to the logical `workspaceId`; logical workspace cleanup is refused while that ID owns a running or unconsumed process completion, and idle-session scanning does not refresh stale activity timestamps.

## [0.2.3] - 2026-08-09

### Changed

- Shell tools no longer carry a blanket prohibition against commands that modify files. `bash` and Codex `exec_command` may update ordinary project files when that is a natural part of the user's requested development task, including package managers, generators, and formatters.

### Security

- The Agent shell contract continues to prohibit mutation of security- or privilege-sensitive operating-system files and credential material such as `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`, authentication policy, and SSH private keys; configuration-file changes through shell require an explicit user request.

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
