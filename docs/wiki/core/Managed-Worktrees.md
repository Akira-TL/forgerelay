# Managed Worktree

Managed Worktree 用于**明确需要隔离或并行开发**的任务。普通任务仍然默认直接在现有 checkout 中工作。

## 什么时候使用

适合：

- 主 checkout 正在进行另一条迭代；
- 两个 Agent 需要并行修改同一仓库但不能互相污染；
- 希望把一次实验保持在独立 Git branch/worktree 中；
- 需要完成后由 ForgeRelay 按固定安全流程集成回目标分支。

不适合：

- 只是换了一个 ChatGPT conversation；
- 只是希望“更安全”；
- 普通 checkout 已经是当前任务唯一工作区。

Managed Worktree 不是 OS sandbox。Shell 仍然拥有启动 ForgeRelay 的本地用户权限。

## 创建

显式请求 worktree mode：

```text
open_workspace(path="~/project", mode="worktree")
```

ForgeRelay 会创建 branch-backed worktree，而不是 detached HEAD。新 managed branch 类似：

```text
forgerelay/project-<id>
```

默认 worktree root 为：

```text
~/.forgerelay/worktrees
```

已有迁移配置可能继续使用旧位置。

## Target branch

Managed Worktree 会记录最终应该接收结果的本地 target branch。

如果显式提供 `baseRef`，它必须指向本地 branch。ForgeRelay 不把任意 commit/tag 当成一个未来可以安全 fast-forward 的目标分支。

默认情况下，对相同 source/target 再次请求 worktree 可以复用已有 managed worktree。只有明确需要另一个平行隔离单元时，才创建新的 worktree。

## Source checkout 的未提交修改

创建 worktree 时，主 checkout 里的 uncommitted changes **不会自动复制**过去。

因此在一个 dirty checkout 上开隔离工作树时，要清楚新 worktree 是从 Git commit 历史建立的，而不是当前 working tree 的镜像。

## 在 worktree 中工作

进入 worktree 后，它就是一个普通文件系统和 Git 工作目录。Agent 可以在里面读取、编辑、运行测试和提交。

从源仓库仍然可以使用标准 Git 命令观察它：

```bash
git worktree list
git branch
```

ForgeRelay 不隐藏 branch，也不维护一套脱离 Git 的私有版本历史。

## 安全关闭与集成

任务完成后，对 managed-worktree-backed Workspace 调用 `close_workspace`，并提供 `commitMessage`。

ForgeRelay 会依次检查：

1. source checkout 是否仍在记录的 target branch；
2. source checkout 是否 clean；
3. managed worktree 是否仍在记录的 managed branch；
4. 是否需要提交 worktree 中的剩余修改；
5. source 状态在提交后是否仍然安全；
6. source HEAD 是否仍是 worktree 最终提交的 ancestor；
7. target 是否可以 fast-forward；
8. 集成成功后再移除物理 worktree；
9. 删除已经合并的 managed branch。

整个集成策略是 **fast-forward-only**。

## 如果分支已经分叉

ForgeRelay 会拒绝 close，并保留 worktree，而不是把 source checkout 强行拉进 merge conflict。

典型处理方式：

1. 在 managed worktree 中获取最新 target；
2. rebase 到最新 target；
3. 重新运行必要验证；
4. 再次调用 `close_workspace`。

如果主 checkout 正在由另一个工作流持续更新，这个拒绝是预期的并发保护，不应该绕过。

## Close 后为什么 Workspace 还在

ForgeRelay 把 Workspace identity 和物理 worktree backing 分开。

成功 close 后：

- 原 managed worktree 目录可以被删除；
- managed branch 可以被删除；
- Workspace identity 进入 `closed`；
- Task List 等 Workspace-owned durable state 仍保留。

以后：

```text
open_workspace(workspaceId="ws_...")
```

ForgeRelay 可以从记录的 source/target 关系创建新的物理 backing，并继续使用原来的 `workspaceId`。

## Delete 不是 discard

对**仍然 active 的 Managed Worktree** 执行 delete，不是“丢弃这批代码”的捷径。

它仍然要求 `commitMessage`，并先完成同一套安全 finalize/integrate/cleanup 流程；成功后才删除 ForgeRelay-owned Workspace identity。

如果 Workspace 已经 closed，那么 delete 只删除 ForgeRelay-owned 状态，不需要重新创建 worktree backing。

## Lifecycle Hooks

Managed Worktree close 会经过 `BeforeWorktreeClose` / `AfterWorktreeClose` 等生命周期点。阻断型 Hook 可以在 finalize 前检查项目特定条件。

例如可以要求：

- 某组测试必须通过；
- 生成文件必须已更新；
- 禁止在特定分支状态下 finalize。

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## 常见失败

### Source checkout dirty

ForgeRelay 无法安全 fast-forward 一个正在被其他修改占用的 source checkout，因此会拒绝 close。

### Source checkout 离开 target branch

如果用户或另一个工作流切换了主 checkout branch，原来的集成目标已经不再成立。

### Managed worktree branch 被手动切换

ForgeRelay 只会 finalize 自己记录的 branch-backed 工作单元。

### Histories diverged

需要先在 worktree 内 rebase/处理历史，然后重试；不要强迫 ForgeRelay 自动制造 merge commit。

## 推荐实践

- 普通开发保持 checkout-first；
- 只有明确隔离需求才创建 worktree；
- 并行任务使用不同 worktree，不共享同一修改目录；
- finalize 前完成与改动风险匹配的测试；
- 主 checkout 正在高速推进时，预期最终可能需要 rebase；
- 不要把 worktree 当成 sandbox 或临时目录。

更精确的边界见 [Workspace 生命周期](Workspace-Lifecycle) 和主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md)。
