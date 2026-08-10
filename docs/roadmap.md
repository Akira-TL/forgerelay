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

Hooks v1 的目标是给用户和 Agent 一个很小、自动、可组合的生命周期规则层，而不是复制完整的 Agent 权限或插件系统。

当前契约包括：

- 全局 `hooks/<hook-name>.json` 与项目 `.forgerelay/hooks/<hook-name>.json` 自动组合；
- 一个独立文件就是一个 Hook，文件名就是 Hook 名，目录内按文件名稳定排序；
- `event + matcher + command` 规则，以及 timeout 与 `report`；
- 旧 inline/聚合 Hook 配置继续兼容；
- `BeforeTool` / `BeforeWorktreeClose` 阻断语义；
- observational after-events；
- Agent 可见 Hook report；
- `forgerelay hooks list` / `hooks check` 只读检查入口；
- `WorkspaceOpen`、tool、文件变更、worktree 与 subagent 生命周期；
- 项目 Hook 配置损坏时可见且可修复的 diagnostic；
- 7677 真实网络验收中的 release-tag-push 本地验证场景。

事件仍保持九个：`WorkspaceOpen`、`BeforeTool`、`AfterTool`、`AfterToolFailure`、`AfterFileChange`、`BeforeWorktreeClose`、`AfterWorktreeClose`、`SubagentStart`、`SubagentStop`。

典型用法是在 `BeforeTool` 中匹配稳定版本 tag 的 `git push`，先执行项目定义的本地 CI；成功后继续 push，失败时让 Agent 获得报告并修复。`BeforeWorktreeClose` 则适合在 managed branch 集成前执行测试、类型检查或其他项目验证。

0.2 不引入审批 UI、HTTP/prompt/agent handler、Git 字符串解析器或插件注册表。只有出现真实需求时再扩展 handler 类型。

### 0.2.5 — MCP App template reliability

0.2.5 收敛 ChatGPT/MCP App 模板身份与排障链路：

- 当前 UI resource URI 由实际构建出的 JavaScript/CSS 内容哈希生成，而不是仅依赖 npm 版本；
- `ui://forgerelay/workspace-app.html` 继续作为 legacy pointer；
- 历史 `workspace-app-*.html` URI 通过兼容 resource template 继续读取当前模板，避免旧 metadata snapshot 直接变成 missing resource；
- debug 日志区分 current / legacy / historical template read，并保留 asset request trace；
- 7677 acceptance 覆盖 tool metadata、resource list/template list、三类 template read 和静态 bundle HTTP fetch。

### 0.2.6 — identity and transport terminology

0.2.6 整理 ForgeRelay 中多个 `session` 含义，不改变 workspace-first 架构：

- `workspaceId` 是唯一持久的逻辑工作身份，跨请求和 transport 重连保持连续；
- `requestId` 只追踪单次 HTTP/JSON-RPC 请求，不持久化；
- MCP 协议层 session 在内部和 debug 输出中明确称为 `transportSessionId`，业务状态不得依赖它；
- 后台命令句柄以 `processId` / process handle 为 canonical 名称，旧 `sessionId` 在 0.2.x 保留 deprecated alias 兼容窗口；
- 为 stateless MCP transport 做准备，同时保留旧协议兼容 adapter，避免把 transport 生命周期重新提升成 ForgeRelay 会话模型。

## 0.3 — MCP loading 与渐进式能力披露

0.3 的目标是缩小 MCP 首次加载时注入给 Agent 的上下文，同时保持工具可调用性、安全边界和 Host 编排权不变。ForgeRelay 不再把所有低频能力说明都塞进 server instructions 或工具 description，而是把模型接口拆成三层：

- `tools/list` 继续暴露真实可调用 primitive，并只携带调用该工具所必需的简洁语义；
- `open_workspace` 返回紧凑的 server/capability 摘要与版本指纹，帮助 Agent 发现能力，并识别 Host 持有旧 tool schema snapshot 的情况；
- ForgeRelay-owned capability guide 提供低频能力的完整说明，由 Agent 在任务相关时显式 `read`，而不是首次连接时自动注入。

首版优先复用现有 Skill-style 的 advertised path / `read` 授权机制，而不是新增第二套文档加载协议。Capability guide 与 Skill 的语义所有权保持区分：Skill 描述用户、项目或生态工作流；capability guide 描述 ForgeRelay 自身、与版本绑定的产品能力。

Core Capability Contract 必须始终内联保留至少这些信息：

- `workspaceId` 生命周期与 workspace 复用规则；
- 常用文件读写改、`rename` 同时承担 move/rename、删除的核心语义；
- shell 以本地用户权限执行且不是 OS sandbox；
- `processId` / `write_stdin` 的基本长进程语义；
- Hook 阻断结果必须对 Agent 可见；
- 关键 mutation/safety invariant；
- `close_workspace` 与 `close_worktree` 的区别。

适合按需读取的首批领域包括：生命周期 Hooks、managed worktree 高级流程、subagents、artifact/review 工作流、debug/MCP App、OAuth/deployment，以及 shell/PTTY/process 的低频边界情况。首个实现切片优先迁移 Hooks 与 managed worktree 高级说明，同时保留其必要安全语义在 core contract 中。

Capability/version fingerprint 必须是轻量、语义化、稳定的摘要，不复制完整 `tools/list`。当 server 报告的能力与 Host 当前暴露的 tool snapshot 明显不一致时，Agent 应能判断为 Host metadata stale，并建议刷新 MCP 或开启新会话，而不是错误断言 ForgeRelay 缺少能力。

0.3 不隐藏 callable tool，不增加隐式 autonomous workflow，也不把 Host Refresh/session 行为归到 ForgeRelay。`rename` 继续作为文件和目录 move/rename 的统一 primitive。

## 0.4 — LSP code intelligence v1

LSP is moderate implementation complexity if ForgeRelay does not become a
language-server installer.

The first version should launch only language servers already available on the
user's machine or explicitly configured by the user/project.

During 0.4 development, MCP App UI hardening can land alongside the LSP work when
it does not distort the code-intelligence scope. In particular, evaluate a more
self-contained template/bootstrap bundle, reduce avoidable external chunk fetches,
and keep the current content-hash/compatibility-resource contract intact. This is
reliability work, not a requirement to move application state into the UI.

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

## 0.5 — First-class subagent MCP

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
