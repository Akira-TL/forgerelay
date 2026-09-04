# ForgeRelay managed worktree

当任务需要隔离/并行 Git 工作，或需要排查 managed worktree 的创建、复用、关闭与恢复时读取本指南。普通开发默认使用 checkout mode；只有用户明确要求隔离或并行工作时才使用 `mode="worktree"`。

## 基本模型

- `workspaceId` 是 Agent 的工作身份；managed worktree 是该 Workspace 的一种物理 Git backing mode，不是 Host 需要管理的第二套 lifecycle。
- managed worktree 使用 ForgeRelay 管理的 `forgerelay/*` 分支，不使用 detached HEAD。
- 创建时会记录 source checkout、base ref/base SHA、managed branch 和 target branch。
- 同一个物理 worktree 可以存在多个逻辑 workspace handle；finalize 一个 managed-worktree-backed Workspace 时，ForgeRelay 会统一处理同一物理 worktree 的 alias/session invalidation。

## 打开与复用

调用 `open_workspace` 时：

- 默认 `mode="checkout"`，直接使用用户已有 checkout；
- 只有明确需要隔离/并行 Git 工作时才选 `mode="worktree"`；
- `baseRef` 只用于 managed worktree，默认取 source checkout 当前分支；
- 已有 `workspaceId` 用于恢复同一个逻辑 workspace；
- `newWorkspace` 只创建新的逻辑 handle；
- `newWorktree` 才表示同一项目再创建一个独立物理 worktree。

不要为了“更安全”自动选择 worktree，也不要在用户没有要求时创建额外 Git 分支。

## `close_workspace`

`close_workspace` 是唯一公开关闭入口，行为由 Workspace backing mode 决定：

- checkout-backed Workspace：只释放逻辑 `workspaceId`，不会删除 checkout 文件；
- managed-worktree-backed Workspace：要求提供 `commitMessage`，并完成下面的安全 finalize lifecycle。

Managed worktree finalize：

1. 要求该 worktree 的工作已经完成并验证；
2. 若仍有未提交修改，ForgeRelay 使用 `close_workspace` 提供的 commit message 提交；
3. 只有 source checkout 干净、目标历史没有分叉且能够安全 fast-forward 时，才把 managed branch 集成到原 target branch；
4. 成功后移除 worktree 目录和 ForgeRelay 管理分支，并关闭该物理 worktree 的逻辑 aliases；
5. 若安全 fast-forward 不成立，不把 source checkout 留在 merge-conflict 状态，而是拒绝关闭并保留 worktree 供用户/Agent 处理。

如果因为缺少 `commitMessage`、dirty source、divergence、Hook blocking 或 busy process 关闭失败，修正对应条件后继续使用**原 workspaceId** 重试；不要另开一个 worktree 来逃避失败状态。

运行中的 process 或尚未消费的 process completion 也会阻止相关逻辑 workspace/worktree 被关闭。

## 外部变化与恢复

source checkout 可能被用户或其他 Agent 修改。关闭前不要假设 target branch 仍停留在创建 worktree 时的状态；让 ForgeRelay 的 close 检查决定是否可以安全集成。遇到 diverged target、dirty source、忙碌 workspace 或 cleanup warning 时，保留现有 worktree 状态并向用户说明真实失败点，不要自行强制 reset、merge 或删除 worktree。

如果 active managed-worktree Workspace 的物理 backing 丢失，先用 `open_workspace action="inspect"` 或 `workspace.recovery` 的 `status` 查看恢复分类。只有 Capability 返回 `recoverable` 时，才考虑 `workspace.recovery { operation: "repair" }`。

`workspace.recovery` 的 repair 规则：

- 只恢复当前 persistent `workspaceId`，不会创建新的 Workspace identity；
- 必须从持久化记录中的原 `forgerelay/*` managed branch 恢复，绝不从 target branch 重新创建替代工作；
- managed branch、target branch、source repository identity、worktree ownership 任一无法证明时返回 `manual-intervention`，不猜测；
- 若同一 managed branch 已出现另一个 worktree candidate，拒绝自动恢复；
- recovery backing 创建后必须重新验证 branch、HEAD、Git registration 和工作树健康状态，验证失败时仅回滚 ForgeRelay 本次创建的临时 backing；
- repair 不 merge、不 rebase、不 reset、不删除 managed branch，也不移动 target branch。

`workspace.recovery { operation: "cleanup" }` 只清理当前 persistent Workspace 能证明归属的 Git administrative residue：

- backing 已不存在且 stale registration 仍精确对应持久化 managed branch 时，可只移除该 registration；不执行 repository-wide `git worktree prune`；
- active Workspace 的 managed branch 始终保留，即使 stale registration 已被清掉，避免 cleanup 把仍需恢复的 Workspace 变成不可恢复状态；
- closed Workspace 的残留 `forgerelay/*` branch 只有在没有任何 worktree registration 或其他 persistent Workspace identity 持有它、source checkout 仍位于持久化 target branch、且 Git 证明该 branch 已完整并入 target 时才允许删除；
- unique/unmerged commits、branch ownership mismatch、active backing、缺失 target、source/target identity 不可证明等情况返回 `manual-intervention`，不强制删除；
- cleanup 返回 `cleaned`、`nothing-to-clean` 或 `manual-intervention` 分类；对 active Workspace 成功清理 registration 后同时返回更新后的 recovery projection；
- cleanup 不 reopen、close、delete Workspace，也不改变 persistent Workspace lifecycle state。

Relay Workspace 的 recovery 在 Execution ForgeRelay 上执行；Composite Workspace 必须显式指定实际拥有该 worktree 的 member。不要在 Gateway 或 Composite identity 上自行解释/修改成员 Git 状态。

如果需要继续工作，复用原 `workspaceId`；不要因为 backing 丢失、一次关闭失败或一次恢复失败就创建新的隔离副本来绕过原状态。