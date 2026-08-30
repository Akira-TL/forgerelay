# ForgeRelay Subagent

当任务需要委派给另一个本地 coding agent、获取第二意见、并行调查，或用户明确点名 Subagent/provider 时读取本指南。

## 当前接口

启用 Subagent 后，`open_workspace` 会在 `capabilityCatalog` 中公开 `subagent.session`，同时返回紧凑的 provider/profile 元数据。不要为 Subagent 寻找或假设额外的 Core MCP tool；长期可见 Core tool surface 保持不变。

通过统一 `capability` gateway 调用：

```text
name = subagent.session
action = run
```

当前支持六个 operation：

- `start`：创建 Subagent Session，并立即启动第一个 Subagent Run；
- `resume`：在支持真实 continuation 的 provider 上继续现有 Session；
- `status`：读取当前 Workspace 中一个 Session 的协调状态；
- `list`：列出当前 Workspace 拥有的 Session 摘要；
- `stop`：取消当前 active Run，但保留 Session；
- `delete`：显式删除 idle Session 的 ForgeRelay coordination state。

`subagent.session` 不支持 `batch.execute`。

## start

使用 profile：

```json
{
  "operation": "start",
  "target": "reviewer",
  "prompt": "检查当前改动的并发与错误处理。"
}
```

也可以把 ForgeRelay 支持的 provider 名直接作为 `target`。创建新 Session 时可以显式给出 `model` / `thinking`；profile 已有默认值时通常无需重复覆盖。

返回值包含：

- `session.id`：ForgeRelay 的 Subagent Session identity；
- `session.status`：`running` 或 `idle`；
- `run.id`：本次 delegated execution 的 Subagent Run identity；
- provider/profile/model 等紧凑协调元数据。

首次 `start` 使用当时有效的 profile body 作为 provider-native conversation 的初始 instructions。ForgeRelay 不把 profile body 复制进自己的 Session SQLite。

## resume

已有 Session 完成一次 Run 后，可发送新的 delegated prompt：

```json
{
  "operation": "resume",
  "sessionId": "agt_...",
  "prompt": "继续检查测试覆盖。"
}
```

`resume` 只接受 `sessionId + prompt`，不能改变 model/thinking。Session 创建时确定的 provider/profile/model/thinking 在整个 Session 生命周期中保持固定；resume 不重新读取或注入当前 profile body，而是使用 provider-native continuation history。

同一个 Session 最多只有一个 active Run；Session 正在执行时再次 resume 会返回 `subagent.busy`，不会排队或并发执行。Codex、Claude、OpenCode、Pi 支持真实 continuation；Cursor/Copilot 当前明确标记为 start-only，resume 返回 `subagent.continuation_unsupported`，不会伪装成新 provider session。

## status / list

查询一个 Session：

```json
{
  "operation": "status",
  "sessionId": "agt_..."
}
```

列出当前 Workspace 的 Session：

```json
{
  "operation": "list"
}
```

Session 受实际 Execution Workspace 所有权约束；Session ID 不是跨 Workspace 的访问凭证。`status` / `resume` 都只能访问当前实际 Execution Workspace 拥有的 Session，`list` 也只返回当前 Workspace 的紧凑摘要。

Session 返回中会给出 `continuationSupported` 与 `resumable`；`open_workspace` 的 provider metadata 也会明确给出 `continuationSupported`。不要用新的 Core MCP tool 绕过 Capability Gateway。

## stop / delete

`stop` 只取消当前 active Run，并等待 provider execution 真正观察取消后才返回。取消完成后 Run 状态为 `cancelled`，Session 回到 `idle`；如果已有 provider continuation identity，之后仍可 `resume`。对 idle Session 调用 `stop` 是幂等的。

`delete` 只允许 idle Session。它只删除 ForgeRelay 的 Session mapping 和尚未领取的 delivery mailbox，不删除或修改 Claude Code、Codex、OpenCode、Pi、Cursor/Copilot 等 provider-native conversation/session history。ForgeRelay 不自动清理 Subagent Session；只有显式 `delete` 才删除协调状态。

## 后台完成与结果交付

`start` 接受执行后会尽快把 Session/Run identity 返回给 Host，Subagent Run 在后台继续执行。

Run 完成后：

- ForgeRelay 创建一个 linked `subagent_result` Activity，只记录 Session/Run/provider/status 等有界元数据；
- final response 放入有界 delivery mailbox，等待同一 Workspace 的后续 ForgeRelay 调用领取；
- 成功领取后 mailbox 条目立即删除，同一个 completion 不重复交付；
- 未领取 completion 可以跨正常 ForgeRelay 进程重启保留。

ForgeRelay 只为 active Run 持久化最小 execution-owner 元数据（owner identity / PID），不保存 delegated prompt。后续 Session 操作会先做 restart reconciliation：能够证明 owner 仍存活的 Run 保持 `running`；无法证明仍有执行 owner 的 Run 一次性转为 `interrupted`，Session 回到 `idle`。ForgeRelay 绝不自动 replay 被中断 Run 的旧 prompt；如果 provider continuation 仍有效，由 Host 显式 `resume` 新 prompt。

如果需要等待结果，使用 `status` 进行有节制的后续查询；不要高频短轮询。

## 数据所有权

Claude Code、Codex、OpenCode、Pi 等 provider 自己的 session store 是 conversation history 的真源。ForgeRelay 只保存恢复、Workspace ownership 和执行协调所需的小型元数据。

ForgeRelay 不把以下内容保存进 Subagent Session SQLite 或 Activity Audit：

- delegated prompt；
- profile body；
- provider transcript/messages/events/items；
- final response 正文；
- 完整 Hook report 历史；
- 完整 Subagent Run 历史。

Activity 只保留操作摘要；delivery mailbox 只用于尚未交付的 bounded completion，不是 conversation/history store。

## Hooks

`SubagentStart` / `SubagentStop` 在每一次 Subagent Run 生命周期中触发。Hook payload 使用 Session/Run/profile/provider/model/thinking/status 等协调元数据，不包含 delegated prompt 或 final response。

## CLI 兼容

`forgerelay agents` 仍可用于本地诊断和兼容性操作，但 Host 正常委派优先使用 `subagent.session` Capability，不要通过 `bash -> forgerelay agents ...` 实现 first-class Subagent。

## 验证责任

Subagent 返回不是自动验证过的最终结论。收到结果后仍应按照任务类型验证：

- 写入型任务检查真实 diff，并运行相关测试；
- 只读调查核对关键结论对应的仓库事实；
- 向用户说明使用的 profile/provider、核心结论、已做验证与剩余风险。
