# Workspace 生命周期

ForgeRelay 把 Workspace 当成持久工作身份，而不是一次对话里的临时 session。这个设计影响打开、恢复、关闭、删除、Task List 和 Managed Worktree 的全部行为。

## 普通打开

默认直接使用现有 checkout：

```text
open_workspace(path="~/project")
```

ForgeRelay 会为 canonical checkout 找到或创建稳定的 `workspaceId`。以后同一项目被其他 Host conversation 再次打开时，可以继续复用这个 Workspace。

正常情况下不要为了“新会话”创建新的 Workspace 身份。需要真正隔离时，应使用 Managed Worktree。

## Bootstrap context

`open_workspace` 的 `context` 控制这次打开是否返回完整 Agent bootstrap，而不改变 Workspace 本身的身份。

### `context="auto"`

默认模式。第一次需要时返回当前 AGENTS/CLAUDE 指令、Skill、Capability guide、profile 等完整 bootstrap。之后 ForgeRelay 按 bootstrap component 分别记录 delivery fingerprint；如果只有某个 component 变化，下一次 `auto` 只返回该 component，其他未变内容不重复发送。

如果某个已交付 component 的内容被删除，`auto` 会返回该 component 的当前空数组，使 Host 能明确清除旧状态，而不是继续保留已经失效的上下文。

### `context="full"`

强制刷新全部 bootstrap component。适合接手工作、怀疑 Host 上下文过旧，或明确需要重新检查全部项目规则时。

### `context="none"`

只打开/恢复 Workspace，不返回 bootstrap component，也不会确认尚未交付的新 component fingerprint。适合只需要 Workspace handle 或轻量元数据的场景；之后再使用 `auto` 时，期间发生的变更仍会正常返回。

## 查看已知 Workspace

需要找回旧工作、整理状态或查看 stale Workspace 时，再使用 inventory：

```text
open_workspace(action="list")
open_workspace(action="list", root="~/project")
open_workspace(action="list", staleOnly=true)
```

Inventory 是观察操作，不会因为“看了一眼”而刷新 `lastUsedAt`。

Workspace 的持久 `status` 与派生 `state` 是两个概念：

- `active`：当前记录未被显式关闭且 backing 正常；
- `stale`：仍处于 active 状态，但长时间没有使用；
- `invalid`：记录存在，但根目录或 backing 已经不可用；
- `closed`：被显式关闭，身份仍保留。

不要把 stale 当作可自动删除的数据。清理前应先确认用户意图。

## 检查单个 Workspace

如果只想读取一个已知 Workspace 的安全摘要，而不激活它，可以使用 inspect 生命周期。

Inspection 只返回显式 allowlist 中的生命周期、Composite member、Relay 展示信息和已有 Task List 摘要；它不会读取项目文件、AGENTS 内容、进程输出、凭据、SSH route 或完整 Task body，也不会授予执行权限。

需要真正操作目标 Workspace 时，仍然必须显式 open/reopen。

## Close 与 Delete 的区别

这是 ForgeRelay 0.8 之后最重要的生命周期边界之一。

### Close

普通 close 表示“现在不使用”，而不是“忘记它”。

关闭 checkout Workspace 后：

- `workspaceId` 仍然存在；
- ForgeRelay-owned durable coordination state 保留；
- Workspace 仍可在 inventory 中看到；
- 普通文件和进程操作会被拒绝；
- 以后再次 `open_workspace` 会重新激活同一个身份。

### Delete

Delete 才永久移除 ForgeRelay-owned Workspace identity 和专属持久状态。

对于 checkout Workspace，delete **永远不会删除用户项目目录**。它删除的是 ForgeRelay 自己保存的 Workspace 记录。

Managed Worktree 与 Composite Workspace 的 delete 语义更严格，见后文和对应专题页。

## Managed Worktree 关闭

Managed Worktree 的物理目录只是 Workspace 的 execution backing。

关闭时 ForgeRelay 会执行安全 finalize 生命周期：Hook、提交剩余修改、fast-forward-only 集成、清理物理 worktree 和已合并 managed branch。成功后 Workspace 本身进入 `closed`，而不是被忘记。

以后按 ID reopen 时，可以根据记录的 source/target branch 关系重新创建新的 backing，同时继续使用原 `workspaceId`。

详见 [Managed Worktree](Managed-Worktrees)。

## Composite Workspace 关闭

关闭 Composite 只把 Composite 本身置为 closed，并保留：

- Composite identity；
- 名称；
- member topology；
- Composite-owned durable coordination state。

它不会关闭 member Workspace、finalize member worktree、停止 member 进程或删除 Relay route。

只有显式 delete 才真正 dissolve Composite-owned 关系，而且仍然不会顺带修改 member Workspace。

详见 [远端与复合工作区](Remote-and-Composite-Workspaces)。

## Workspace Task Lists

`workspace.tasks` Capability 为每个 Workspace 保存轻量 Task List。Task 数据属于 ForgeRelay 私有 Workspace state，而不是项目文件。

因此 Task List：

- 不会出现在 `git status`；
- 不会被误提交进仓库；
- 可以跨 Host Turn 和 conversation 保留；
- checkout Workspace close 后仍然保留；
- Managed Worktree backing 被 finalize/重建后仍然保留；
- Composite Workspace 也可以拥有自己的 Task List。

常见操作分为：

```text
get
list.create
list.update
list.delete
task.create
task.update
task.delete
```

读取采用 progressive disclosure：

- 默认 `get`：List summary 和 unfinished count；
- `level="headers"`：增加 Task ID、status 和 subject；
- `level="detail"`：只读取一个显式选中的 Task 完整内容。

Task List 是“需要继续记住的工作清单”，不是队列、计划执行器或 Subagent session。创建 Task 不会自动启动 Agent、Shell、worktree 或定时任务。

## Task reminder

当 active Task List 长时间没有更新、但 Agent 仍持续进行语义工作时，ForgeRelay 可以附加轻量 reminder，提醒 Agent 更新进度。

默认间隔是 30 次成功的语义 Workspace 操作；Task mutation 会重置计数。单纯查看 inventory、读取 Task、查询 Activity 或对同一个 Bash 进程做 poll/input 不会被当成新的工作步骤。

可以通过 `FORGERELAY_TASK_REMINDER_INTERVAL=0` 关闭 reminder。

## 长时间 Bash 与 Workspace 关闭

`bash` 把“当前请求等待多久”和“进程最多运行多久”分开：

- `yieldTimeMs`：当前 MCP 请求的反馈窗口；
- `timeoutMs`：可选的总执行截止时间。

如果反馈窗口到期但进程仍在运行，ForgeRelay 返回稳定 `processId`，后续使用同一个进程 ID 等待、输入、调整 PTY 或中断。

已经完成的后台进程不会阻止 Workspace close；仍在运行的进程会阻止关闭，直到结束或被明确中断。

## 何时用哪种生命周期

| 需求 | 推荐动作 |
| --- | --- |
| 第一次进入项目 | `open_workspace(path=...)` |
| 接着以前的 Workspace 做 | 按 path 或 `workspaceId` reopen |
| 只想找旧 Workspace | `open_workspace(action="list")` |
| 只想检查一个 Workspace 摘要 | inspect，不激活 |
| 暂时不用，但未来还会回来 | close |
| 永久移除 ForgeRelay-owned Workspace state | delete |
| 同项目并行开发 | 新建 Managed Worktree |

完整版本化行为见主仓库 [ChatGPT Coding Workflow](https://github.com/Akira-TL/forgerelay/blob/main/docs/chatgpt-coding-workflow.md) 和 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#workspace-tasks)。
