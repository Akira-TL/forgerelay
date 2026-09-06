# Workspace 生命周期

ForgeRelay 把 Workspace 当成持久工作身份，而不是一次 conversation 里的临时 session。打开、关闭、删除、Task List 和 Managed Worktree 都建立在这个前提上。

## 打开 Workspace

普通项目直接打开现有 checkout：

```text
open_workspace(path="~/project")
```

ForgeRelay 会为 canonical checkout 找到或创建稳定的 `workspaceId`。以后其他 Host conversation 再打开同一目录时，可以继续复用这个 Workspace。

不要因为“换了新会话”就创建新的 Workspace identity。需要真正隔离时，用 Managed Worktree。

## Bootstrap context

`open_workspace` 的 `context` 只控制这次要返回多少 Agent bootstrap，不改变 Workspace identity。

### `context="auto"`

默认模式。第一次需要时返回当前项目上下文；之后按 component 记录 delivery fingerprint。

如果只改了 AGENTS / CLAUDE instructions、Skills、Capability guides、profiles 或 diagnostics 中的一部分，下一次 `auto` 只返回有变化的 component。已经交付的内容后来被删除时，也会返回对应空值，让 Host 清掉旧状态。

### `context="full"`

强制重新返回全部 bootstrap。适合明确需要重新加载完整项目规则，或者怀疑 Host 上下文已经过旧的情况。

### `context="none"`

只打开或恢复 Workspace，不返回 bootstrap，也不会把尚未交付的新 fingerprint 标记为已发送。之后再用 `auto`，期间发生的变化仍会正常返回。

## 查看已有 Workspace

找旧工作、看 stale 状态或整理 Workspace 时，可以用 inventory：

```text
open_workspace(action="list")
open_workspace(action="list", root="~/project")
open_workspace(action="list", staleOnly=true)
```

Inventory 是只读观察，不会因为查看而刷新 `lastUsedAt`。

常见 `state`：

- `active`：记录未关闭，backing 正常；
- `stale`：仍是 active，但很久没有使用；
- `invalid`：记录存在，但 root 或 backing 不可用；
- `closed`：显式关闭，identity 仍保留。

`stale` 不是“可以自动删除”的意思。清理前仍应确认用户意图。

## Inspect

如果只想看一个已知 Workspace 的安全摘要，不需要重新激活它，可以使用 `open_workspace(action="inspect", ...)`。

Inspect 只返回 allowlist 中的生命周期、Composite / Relay 展示信息和 Task List 摘要。它不读取项目文件、AGENTS 正文、进程输出、凭据、SSH route 或完整 Task body，也不会授予执行权限。

要真正操作这个 Workspace，仍然要显式 open / reopen。

## Close 和 Delete

### Close

Close 表示“现在不用”，不是“忘掉它”。

checkout Workspace 关闭后，`workspaceId` 和 ForgeRelay-owned durable state 继续存在，inventory 里仍然可以看到。普通文件和进程操作会被拒绝，直到下一次 `open_workspace` 重新激活。

### Delete

Delete 永久移除 ForgeRelay 保存的 Workspace identity 和专属持久状态。

对普通 checkout 来说，delete 不会删除用户项目目录，只删除 ForgeRelay 自己的记录。

Managed Worktree 和 Composite Workspace 的 delete 还有额外生命周期约束，见对应专题页。

## Managed Worktree close

Managed Worktree 的物理目录只是 execution backing。

关闭时 ForgeRelay 会跑 Hook、提交剩余修改，并执行 fast-forward-only 集成。成功后清理物理 worktree 和已经合并的 managed branch，Workspace 本身进入 `closed`。

以后按原 ID reopen 时，可以根据保存的 source/target branch 关系重新创建 backing。

详见 [Managed Worktree](Managed-Worktrees)。

## Composite Workspace close

关闭 Composite 只关闭 Composite identity，并保留 member topology 和 Composite-owned durable state。

它不会关闭 member Workspace、finalize member worktree、停止 member 进程或删除 Relay route。

显式 delete 才会 dissolve Composite-owned 关系，但仍然不会顺带修改 member Workspace。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Workspace Task Lists

`workspace.tasks` 把 Task List 保存在 ForgeRelay 私有 Workspace state 中，不写进项目文件。

所以 Task 不会出现在 `git status`，也不会因为 checkout close 或 Managed Worktree backing 被重建而消失。Composite Workspace 也可以有自己的 Task List。

常用操作：

```text
get
list.create
list.update
list.delete
task.create
task.update
task.delete
```

读取采用 progressive disclosure：默认 `get` 只给 List summary 和 unfinished count；`level="headers"` 增加 Task ID、status、subject；`level="detail"` 只返回一个显式选中的 Task body。

Task List 是续接清单，不是执行队列。创建 Task 不会自动启动 Agent、Shell、worktree 或定时任务。

## Task reminder

如果 active Task List 里还有未完成项，而 Agent 长时间持续工作却没有更新 Task，ForgeRelay 可以附加一条轻量 reminder。

默认间隔是 30 次成功的语义 Workspace 操作。Task mutation 会重置计数；查看 inventory、读取 Task、查询 Activity 或继续操作同一个 Bash 进程不算新的工作步骤。

关闭 reminder：

```text
FORGERELAY_TASK_REMINDER_INTERVAL=0
```

## 长时间 Bash 和 close

`bash` 把“当前 MCP 请求愿意等多久”和“进程最多允许运行多久”分开：

- `yieldTimeMs`：本次请求的反馈窗口；
- `timeoutMs`：可选的总执行截止时间。

反馈窗口结束时如果进程还在跑，ForgeRelay 返回稳定 `processId`。后续继续用这个 ID 等待、输入、调整 PTY 或中断。

已经结束的后台进程不会阻止 Workspace close；仍在运行的进程会阻止关闭，直到结束或被明确中断。

## 常见动作

| 需求 | 动作 |
| --- | --- |
| 第一次打开项目 | `open_workspace(path=...)` |
| 继续以前的 Workspace | 按 path 或 `workspaceId` reopen |
| 找旧 Workspace | `open_workspace(action="list")` |
| 只看一个 Workspace 摘要 | inspect，不激活 |
| 暂时不用 | close |
| 永久删除 ForgeRelay-owned Workspace state | delete |
| 同项目并行开发 | 新建 Managed Worktree |

完整版本化行为见主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md) 和 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#workspace-tasks)。
