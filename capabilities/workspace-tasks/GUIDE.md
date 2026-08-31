# Workspace Tasks

`workspace.tasks` 维护当前 Workspace 自己的持久 Task Lists。它是轻量工作续接状态，不是执行队列、Subagent Session、Activity 或依赖图。

## 使用边界

- 只操作当前调用上下文中的 Workspace；参数中没有目标 `workspaceId`。
- Task state 由 ForgeRelay 保存在私有 state directory，不写入 checkout 或 managed worktree。
- 一个 Workspace 可以有多个 Task List；List 可为 `active` 或 `archived`。
- Task 状态只有 `pending`、`in_progress`、`completed`。`content` 保存继续工作真正需要的要求、阻塞点、结论或下一步，而不是日志或对话转录。
- Task/List ID 创建后保持稳定。完成 Task 不会删除它；删除必须显式执行。

## 操作

先用 `operation="get"` 读取当前 Task state。

List 操作：

- `list.create`：创建具名 List，可指定 `position`。
- `list.update`：修改 `name`、`state` 或 `position`；`state="archived"` 用于归档，改回 `active` 即重新激活。
- `list.delete`：显式删除 List 及其 Tasks。

Task 操作：

- `task.create`：在一个 List 中创建 Task；需要 `subject`，可提供 `content`、`status`、`position`。
- `task.update`：修改 `subject`、`content`、`status` 或 `position`；至少提供一个变更字段。
- `task.delete`：显式删除 Task。

Task 修改使用独立的 revision/fingerprint 域；它不改变 Workspace bootstrap `contextFingerprint`。
