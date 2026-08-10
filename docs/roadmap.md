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

0.3 的目标是把 ForgeRelay 的 MCP interface 做成一个深而稳定的模型接口：普通编码 primitive 始终直接可见，低频知识与低频 action 都按需披露，新增 ForgeRelay 能力不再线性扩大 Host 首次加载的 `tools/list` 与 instructions。

0.3.0 已完成第一阶段：压缩 server instructions、由 `open_workspace` 返回 version/capability fingerprint、通过 advertised path + `read` 按需加载 ForgeRelay-owned capability guide，并用 fingerprint 与 Host `tools/list` 的差异诊断 stale Host metadata。Capability guide 与 Skill 的语义所有权保持区分：Skill 描述用户、项目或生态工作流；Capability guide 描述 ForgeRelay 自身、与版本绑定的产品能力。

0.3 后续阶段采用 ADR-0002 的接口形状。Canonical Core tool surface 最终固定为：

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

其中 `open_workspace` 负责 Workspace 生命周期入口与轻量 Capability catalog；`capability` 是唯一低频 Capability gateway；`bash` 同时承担命令启动与后续 process interaction；Managed worktree 是 Workspace 的 backing mode，由 `close_workspace` 统一完成关闭/finalize lifecycle。Capability registry 只能暴露显式注册、带输入约束、可用性和 guide metadata 的 ForgeRelay capability，不能退化成任意 RPC、URL dispatcher 或 shell 后门。

### 0.3.1 — MCP App 与诊断补丁

在不改变主 tool surface 的前提下先修 0.3.0 发布后真实 Host 暴露的问题：

- 为 MCP App resource 补齐 Host submission 所需的 widget/app domain metadata，并保持现有 CSP、content-hash URI 与 compatibility resource contract；
- `forgerelay doctor` 显示解析后的 MCP 运行形态，例如 tool mode、widgets、public URL、proxy trust 与可选 capability 开关，避免“功能代码存在但当前实例未启用”只能靠源码排查；
- 补齐 release/Host integration 的诊断与验收用例，但不在这一版重塑 tool schema。

### 0.3.2 — Capability Registry 与 Gateway

建立新的低频 action seam，但保留现有公开工具作为迁移兼容：

- 新建 ForgeRelay-owned Capability registry，每项至少声明稳定 name、简短 description、availability、input contract、guide metadata 与 handler；
- 新增唯一 MCP tool `capability`，提供紧凑的 `describe` / `run` 语义；
- `open_workspace` 返回轻量 Capability catalog，只做发现，不复制完整 schema、示例或 guide 正文；
- Agent 已熟悉某项 capability 时可以直接执行；不熟悉时先 `describe`，再按返回的 guide path 使用 `read` 获取详细说明；
- 选择一组低风险、当前主要依赖 CLI 的检查型能力作为 tracer bullet，验证 registry、Hooks、日志、错误和 Host card contract，而不是一开始迁移所有功能。

### 0.3.3 — 低频 Action 迁入 Gateway

用真实现有能力验证 Gateway 能承载持续扩展，而不是只做一层转发：

- 将 change review 收口为如 `review.changes` 的 registered capability；
- 将 native artifact ingress 收口为如 `artifact.download` 的 registered capability；
- 适合 Agent 主动调用的 Hook inspection/check 等低频操作进入同一 namespace model；
- Capability guide 与 catalog/registry 建立一一可追踪关系，availability 由运行时条件决定；
- `show_changes`、`download_artifact` 等旧 dedicated MCP tools 在迁移窗口内只作为兼容入口，不再作为长期接口设计。

### 0.3.4 — Workspace 与 Process 生命周期收敛

移除两个泄漏内部实现的 public lifecycle tool：

- `bash` 成为 Process Manager 的唯一公开 interface；`action="run"` 启动命令，`action="process"` 使用 `processId` 查看、等待、输入、调整 PTY 或中断已有进程；内部 ProcessManager 可以继续保留更细的方法，但 Host 不再需要学习 `write_stdin`；
- `close_workspace` 成为唯一 workspace 关闭入口；checkout 直接释放，managed-worktree-backed Workspace 在同一接口内执行 BeforeWorktreeClose、commit/integrate/cleanup、AfterWorktreeClose 并关闭 Workspace；
- 从 canonical MCP surface 删除 `write_stdin` 与 `close_worktree`，同时清理对应 server instructions、fingerprint 和 capability guide 中的旧心智模型；
- 保留 `processId` 作为运行中进程的 opaque handle，保留 worktree 作为 Workspace 的可观察 backing metadata，而不是第二套 Host lifecycle。

### 0.3.5 — Canonical MCP Surface 收口

完成 0.3 的接口稳定化与真实 Host 验收：

- regular ForgeRelay MCP surface 收口为 9 个 canonical tools；`minimal/full` 不再通过增减 `grep/glob/ls` 改变主产品心智模型，搜索与目录检查可由 `bash` 承担；
- 评估并隔离 `codex` compatibility surface，使其作为明确 adapter 存在，而不是反向定义 ForgeRelay canonical interface；
- 删除已经完成迁移的 dedicated low-frequency tool aliases，确保新增 Capability 不再扩大常驻 tool count；
- 简化 fingerprint，使其用于版本/运行时能力摘要与 stale-Host 诊断，而不是重新枚举 tool implementation；
- 对 `open_workspace → catalog → capability describe/read/run`、managed worktree close、长进程 interaction、review/artifact capability、MCP App 与 stale-schema 情况做 7677 acceptance 和新 Host 会话验收；
- 0.3.5 通过后，0.3 的 MCP progressive-disclosure 主题视为完成，0.4 回到原定 LSP code intelligence v1。

必要安全语义始终留在 Core tool interface、Capability contract 或自动 Hook report 中；渐进式披露不能成为隐藏权限、隐式 autonomous workflow 或绕过 allowed roots/auth 的机制。`rename` 继续作为文件和目录 move/rename 的统一 primitive。

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

Expose code intelligence through the Capability Gateway established in 0.3 rather than adding another top-level MCP tool. A representative registered capability may look like `code.intelligence`, with its language-server operation/path/position/query fields carried inside the capability arguments. The exact LSP contract remains 0.4 work; the stable Core tool surface does not change per language or language-server method.

Candidate servers include `typescript-language-server`/tsserver, Pyright,
`rust-analyzer`, `gopls`, and `clangd`, but ForgeRelay should treat server
commands/configuration as external dependencies.

## 0.5 — First-class subagent MCP

ForgeRelay already owns provider adapters and resumable local agent sessions.
The next step is to remove the current `bash -> forgerelay agents ...` indirection
for MCP hosts.

First-class subagent operations should reuse the Capability Gateway established in 0.3 rather than add another top-level MCP tool. The exact registered names, action semantics and provider/session contract remain 0.5 design work. The parent agent will continue choosing from available provider/profile metadata while ForgeRelay owns provider-backed worker lifecycle state.

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
