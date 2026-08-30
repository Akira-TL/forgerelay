# Workspace 使用持久身份并将关闭与删除分离

ForgeRelay 将 Workspace 定义为持久工作身份，而不是 Host conversation 临时产生的 logical handle。Host conversation 只绑定并复用 Workspace；同一个 canonical checkout target 只能对应一个 checkout Workspace，不再通过 `newWorkspace` 为同一物理 checkout 创建多个并行身份。需要隔离或并行工作时，应创建独立 managed-worktree Workspace，而不是给同一目录制造 alias。

Workspace 生命周期统一复用现有 `open_workspace` 与 `close_workspace` Core tool。`open_workspace` 负责 create、reuse 与 reopen；`close_workspace` 区分普通 close 与显式 delete。Close 只把 Workspace 置为 closed，保留 Workspace identity、durable coordination state 和可检查的历史关系；之后可以通过正常 `open_workspace` 重新 active。Delete 才永久移除 ForgeRelay-owned Workspace identity 与其专属持久状态。删除 checkout Workspace 永远不得删除用户项目目录。

Managed-worktree Workspace 的物理 Git worktree 是 execution backing，而不是 Workspace identity 本身。普通 close 继续执行现有安全 finalize 生命周期，包括 Hook、commit、integrate 与 physical worktree cleanup，然后把 Workspace 保留为 closed。之后 reopen 可以基于持久记录重新创建新的 managed-worktree backing，同时沿用原 Workspace identity 与 durable coordination state。若 backing 无法安全重建，Workspace 保持 closed 并返回明确错误。

Composite Workspace 采用同一 active/closed/delete 语义。Close 保留 Composite identity、成员关系和 durable coordination state；delete 才真正解散 Composite 关系。这个决定明确取代 ADR-0008 中“`close_workspace` 对 Composite 表示 dissolve”的部分，但继续保留 ADR-0008 的其他边界：Composite 没有虚构 filesystem root，成员执行事实仍归各成员 Workspace，成员选择仍必须显式完成。

Workspace-owned 轻量协调状态存放在 ForgeRelay 自己的 state directory 下、按稳定 Workspace identity 隔离，而不是写入 checkout 或 managed worktree 的 Git working tree。Task List/Task 是第一种这样的状态，使用 Workspace 专属文件作为持久真源，使 checkout、managed-worktree 和 Composite Workspace 都能拥有独立 Task state，并避免 Task 被意外提交或随着 physical worktree 删除而丢失。

现有旧版本可能已经为同一 canonical target 持久化多个 logical Workspace 记录。迁移时应将它们折叠为一个 canonical Workspace identity，并保留旧 ID 到 canonical identity 的兼容解析，使既有 Host context 不会在升级后立即失效；新版本不再创建新的 aliases。

Workspace GC 不得再删除持久 Workspace identity 或 Workspace-owned durable coordination state。GC 只能清理 conversation binding、context-delivery cache、内存对象和其他明确可重建的临时状态。永久删除 Workspace state 必须来自显式 delete。

## Considered Options

- 没有继续把 `workspaceId` 当作 conversation-scoped logical handle，因为这会让同一 checkout 出现多个身份，并使 Task、inspection、close/reopen 和 Activity ownership 反复处理 alias。
- 没有把 Task 等轻量状态写进项目 `.forgerelay/` 或 managed worktree，因为这些目录属于项目/Git working tree，可能污染 `git status`、被误提交，或在 worktree finalize 时被同步到项目本体。
- 没有增加独立的 `reopen_workspace`、`delete_workspace` 或 Composite dissolve Core tool，因为 `open_workspace` / `close_workspace` 已经是稳定 Workspace lifecycle surface；新增生命周期工具会扩大长期 MCP schema。
- 没有让 ordinary close 隐式删除 durable state，因为 close 表示暂时停止使用，而不是忘记 Workspace。真正的数据销毁由显式 delete 表达。
