# Managed Worktree

Managed Worktree 只用于确实需要隔离或并行开发的任务。普通工作默认直接使用现有 checkout。

## 什么时候用

适合的场景包括：主 checkout 正在进行另一条迭代、两个 Agent 需要并行修改同一仓库，或者你想把实验放在独立 branch/worktree 中再安全集成回来。

如果只是换了一个 conversation，或者当前 checkout 本来就是唯一工作区，就没有必要再开 worktree。

Managed Worktree 也不是 OS sandbox。Shell 仍然拥有启动 ForgeRelay 的本地用户权限。

## 创建

显式请求 worktree mode：

```text
open_workspace(path="~/project", mode="worktree")
```

ForgeRelay 创建 branch-backed worktree，而不是 detached HEAD。managed branch 类似：

```text
forgerelay/project-<id>
```

默认 worktree root：

```text
~/.forgerelay/worktrees
```

旧安装可能因为迁移配置继续使用其他位置。

## Target branch

Managed Worktree 会记录最终接收结果的本地 target branch。

如果显式传 `baseRef`，它必须指向本地 branch。任意 commit 或 tag 不能作为未来 finalize 的 target branch。

对相同 source/target 再次请求 worktree 时，ForgeRelay 可以复用已有 managed worktree。只有确实需要另一个并行隔离单元时，才创建新的 worktree。

## 主 checkout 的未提交修改

创建 worktree 不会把 source checkout 的 uncommitted changes 复制过去。

新 worktree 从 Git commit 历史建立，不是当前 working tree 的镜像。dirty checkout 中有本地文件或修改时，要自己决定是否需要显式复制。

## 在 worktree 中工作

进入 managed worktree 后，它就是普通 Git 工作目录。Agent 可以读取、编辑、运行测试和提交。

在 source repository 中仍然可以直接看到它：

```bash
git worktree list
git branch
```

ForgeRelay 不隐藏 branch，也不维护一套脱离 Git 的私有代码历史。

## Close 与集成

任务完成后，对 managed-worktree-backed Workspace 调用 `close_workspace`，并提供 `commitMessage`。

ForgeRelay 会确认：

1. source checkout 仍在记录的 target branch，并且 working tree clean；
2. managed worktree 仍在记录的 managed branch；
3. worktree 剩余修改可以提交；
4. source HEAD 仍是 worktree 最终提交的 ancestor；
5. target 可以 fast-forward。

这些条件通过后，ForgeRelay 才会推进 target branch，移除物理 worktree，并删除已经合并的 managed branch。整个流程是 fast-forward-only。

## 分支已经分叉

如果 source 和 managed branch 已经 diverge，ForgeRelay 会拒绝 close，并保留 worktree。

通常在 managed worktree 里处理：

1. 获取最新 target；
2. rebase 到最新 target；
3. 重新跑需要的验证；
4. 再次调用 `close_workspace`。

主 checkout 如果还在持续前进，finalize 前需要 rebase 很正常。这是并发保护，不应该绕过。

## Close 后 Workspace 为什么还在

Workspace identity 和物理 worktree backing 是分开的。

成功 close 后，worktree 目录和已经合并的 managed branch 可以被删除，但 Workspace 会进入 `closed`，Task List 等 durable state 继续保留。

以后可以按原 ID reopen：

```text
open_workspace(workspaceId="ws_...")
```

ForgeRelay 会根据记录的 source/target 关系重新创建 backing，并继续使用原来的 `workspaceId`。

## Delete 不是 discard

对仍然 active 的 Managed Worktree 执行 delete，不是“直接丢弃代码”。

它仍然要求 `commitMessage`，先完成同一套安全 finalize / integrate / cleanup，成功后才删除 ForgeRelay-owned Workspace identity。

如果 Workspace 已经 closed，delete 只删除 ForgeRelay-owned state，不需要重新创建 worktree。

## Lifecycle Hooks

Managed Worktree close 会经过 `BeforeWorktreeClose` 和 `AfterWorktreeClose` 等生命周期事件。项目可以用 blocking Hook 在 finalize 前跑测试、检查生成文件或拒绝某些分支状态。

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## 常见失败

### Source checkout dirty

Source checkout 正在被其他修改占用时，ForgeRelay 无法安全 fast-forward，因此会拒绝 close。

### Source checkout 离开 target branch

用户或其他工作流切换了 source branch 后，原来的集成目标已经不成立。

### Managed worktree branch 被切换

ForgeRelay 只 finalize 自己记录的 branch-backed 工作单元。

### Histories diverged

先在 worktree 里 rebase / 处理历史，再重试。ForgeRelay 不会自动制造 merge commit。

## 使用建议

普通开发保持 checkout-first。并行任务用不同 worktree，不要共享同一个修改目录；finalize 前跑和风险匹配的测试；主 checkout 变化很快时，提前预期最后可能需要 rebase。

不要把 Managed Worktree 当成 sandbox 或随时可以扔掉的临时目录。

相关边界见 [Workspace 生命周期](Workspace-Lifecycle) 和主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md)。
