# ForgeRelay managed worktree

当任务需要隔离/并行 Git 工作，或需要排查 managed worktree 的创建、复用、关闭与恢复时读取本指南。普通开发默认使用 checkout mode；只有用户明确要求隔离或并行工作时才使用 `mode="worktree"`。

## 基本模型

- `workspaceId` 是逻辑工作身份；managed worktree 是物理 Git worktree。二者不要混用。
- managed worktree 使用 ForgeRelay 管理的 `forgerelay/*` 分支，不使用 detached HEAD。
- 创建时会记录 source checkout、base ref/base SHA、managed branch 和 target branch。
- 同一个物理 worktree 可以存在多个逻辑 workspace handle；关闭逻辑 handle 与删除物理 worktree 是不同操作。

## 打开与复用

调用 `open_workspace` 时：

- 默认 `mode="checkout"`，直接使用用户已有 checkout；
- 只有明确需要隔离/并行 Git 工作时才选 `mode="worktree"`；
- `baseRef` 只用于 managed worktree，默认取 source checkout 当前分支；
- 已有 `workspaceId` 用于恢复同一个逻辑 workspace；
- `newWorkspace` 只创建新的逻辑 handle；
- `newWorktree` 才表示同一项目再创建一个独立物理 worktree。

不要为了“更安全”自动选择 worktree，也不要在用户没有要求时创建额外 Git 分支。

## `close_workspace` 与 `close_worktree`

`close_workspace` 只释放一个逻辑 `workspaceId`，不会删除 checkout 文件，也不会完成 managed branch 集成。若某个 managed worktree 仍有其他逻辑 handle，释放其中一个 handle 不会移除物理 worktree。

`close_worktree` 用于完成一个 managed worktree：

1. 要求该 worktree 的工作已经完成并验证；
2. 若仍有未提交修改，ForgeRelay 使用调用时提供的 commit message 提交；
3. 只有 source checkout 干净、目标历史没有分叉且能够安全 fast-forward 时，才把 managed branch 集成到原 target branch；
4. 成功后移除 worktree 目录和 ForgeRelay 管理分支；
5. 若安全 fast-forward 不成立，不把 source checkout 留在 merge-conflict 状态，而是拒绝关闭并保留 worktree 供用户/Agent 处理。

运行中的 process 或尚未消费的 process completion 也会阻止相关逻辑 workspace/worktree 被关闭。

## 外部变化与恢复

source checkout 可能被用户或其他 Agent 修改。关闭前不要假设 target branch 仍停留在创建 worktree 时的状态；让 ForgeRelay 的 close 检查决定是否可以安全集成。遇到 diverged target、dirty source、忙碌 workspace 或 cleanup warning 时，保留现有 worktree 状态并向用户说明真实失败点，不要自行强制 reset、merge 或删除 worktree。

如果需要继续工作，复用原 `workspaceId` 或已知 worktree path；不要因为一次关闭失败就创建新的隔离副本。