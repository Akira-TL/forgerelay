# 生命周期 Hooks

Lifecycle Hook 是 ForgeRelay 自动执行的本地生命周期规则。它适合把项目已有的检查、发布门禁、审计和环境约定挂到真实工具生命周期上，而不是依赖 Agent 每次都“记得手动运行”。

## Hook 放在哪里

推荐格式是 **一个 Hook 一个 JSON 文件**。

全局 Hook：

```text
~/.forgerelay/hooks/<hook-name>.json
```

项目 Hook：

```text
<workspace>/.forgerelay/hooks/<hook-name>.json
```

文件名去掉 `.json` 后就是 Hook 名，同时用于日志和 Agent-visible report。

例如：

```text
.forgerelay/hooks/10-release-verify.json
.forgerelay/hooks/20-package-inspection.json
```

目录按文件名字典序执行，所以数字前缀可以表达显式顺序。

全局 Hook 在 Server 启动时读取，修改后需要重启 ForgeRelay；项目 Hook 在事件发生时重新读取，修改项目规则通常不需要重启。

## 最小规则

```json
{
  "event": "BeforeTool",
  "matcher": {
    "tool": "bash",
    "commandRegex": "git\\s+push\\s+origin\\s+v\\d+\\.\\d+\\.\\d+"
  },
  "command": "node scripts/release-proof.mjs check-hook",
  "timeoutSeconds": 30,
  "report": true
}
```

一个独立 Hook 文件支持：

| 字段 | 说明 |
| --- | --- |
| `event` | 必填，生命周期事件 |
| `matcher` | 可选，只在当前上下文匹配时运行 |
| `command` | 必填，本地 Shell 命令 |
| `timeoutSeconds` | 默认 `30`，范围 `1..300` |
| `report` | 默认 `true`，控制成功结果是否主动展示给 Agent |

独立文件不需要 `name`，因为文件名就是 Hook 名。

## Matcher

当前可用 matcher：

| 字段 | 匹配方式 |
| --- | --- |
| `tool` | 精确匹配 MCP tool 名称 |
| `commandRegex` | 对 tool request 中的 `command` 做 JavaScript 正则匹配 |
| `pathRegex` | 对 `path` / `paths` 做正则匹配 |
| `provider` | 精确匹配 Subagent provider |
| `workspaceMode` | 匹配 `checkout` 或 `worktree` |

Matcher 只观察 ForgeRelay 收到的 tool request，不会追踪命令内部后续启动的子进程。

例如：

```text
bash(command="git push origin v0.8.4")
```

可以被 `commandRegex` 命中。

但：

```text
bash(command="./release.sh")
```

即使 `release.sh` 内部再执行 `git push`，ForgeRelay 也不会把那个子进程重新解释成一条 MCP tool request。

## 九个事件

| Event | 语义 | Blocking |
| --- | --- | --- |
| `WorkspaceOpen` | 新 Workspace session 创建后 | 否 |
| `BeforeTool` | Workspace-scoped tool 执行前 | **是** |
| `AfterTool` | Tool 成功后 | 否 |
| `AfterToolFailure` | Tool 失败或被 `BeforeTool` 拒绝后 | 否 |
| `AfterFileChange` | 明确文件变更成功后 | 否 |
| `BeforeWorktreeClose` | worktree commit / fast-forward / cleanup 前 | **是** |
| `AfterWorktreeClose` | managed worktree 成功关闭后 | 否 |
| `SubagentStart` | 本地 Subagent worker 开始执行 | 否 |
| `SubagentStop` | Subagent 完成或进入 error | 否 |

### `AfterFileChange` 的边界

它覆盖 ForgeRelay 明确知道的文件修改，例如 `write`、`edit`、`rename`、`delete`、`apply_patch` 和 native artifact 变更。

它**不会推断 Shell 命令产生了哪些文件副作用**。这是刻意的边界，避免 ForgeRelay 假装理解任意命令内部发生的一切。

## Blocking Hook

`BeforeTool` 和 `BeforeWorktreeClose` 是阻断点。

如果 Hook：

- exit code 非零；
- 超时；
- 被 Host cancellation 中断；

原始操作不会继续开始。

但 Blocking Hook 不是数据库事务。Hook command 自己在失败前已经造成的外部副作用不会自动回滚。

## Observational Hook

其他事件发生在事实已经成立之后。即使 observational Hook 失败，ForgeRelay 也不会回滚：

- 已写入的文件；
- 已完成的 Git 操作；
- 已发生的网络操作；
- 已运行的进程。

因此 After* Hook 更适合通知、审计、收尾和非事务性检查。

## Agent-visible report

默认 `report:true`。成功结果可以出现在 tool result：

```text
Hook results:
✓ release-tag-gate (BeforeTool, project) passed in 42ms
```

`report:false` 可以隐藏高频成功信息，但 **blocking failure 永远可见**。

Agent 收到重要 Hook result 后，应明确告诉用户规则是通过还是阻断了操作，而不是把门禁悄悄吞掉。

## 检查配置而不执行 Hook

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

`list` 显示实际加载的：

- scope；
- event；
- matcher；
- timeout；
- report；
- command。

`check` 只解析和验证 schema，不执行 Hook。发现坏配置时返回非零状态。

如果某个项目 Hook 文件无效，ForgeRelay 会报告 diagnostic，但继续加载其他有效 Hook 并保持 Workspace 可操作，以便修复问题文件。

## Hook 环境变量

Hook command 继承 ForgeRelay Server 环境，并额外获得常用 lifecycle metadata：

```text
FORGERELAY_HOOK_EVENT
FORGERELAY_HOOK_PAYLOAD
FORGERELAY_WORKSPACE_ROOT
FORGERELAY_WORKSPACE_ID
FORGERELAY_WORKSPACE_MODE
FORGERELAY_SOURCE_ROOT
FORGERELAY_TOOL_NAME
```

Payload 用于策略和自动化，不会携带文件正文、native-file credential 或 Subagent prompt。

Shell tool 的 command metadata 本身仍可能包含敏感参数，因此 Hook 自己的日志也需要按敏感输入处理。

## Hook 的安全边界

Hook command 使用和 ForgeRelay 相同的本地 OS user 权限执行。

项目 `.forgerelay/hooks/*.json` 是**可执行项目约定**。允许某个 project root 后，不应该把里面的 Hook 当成单纯无害配置文件；它们属于这个本地开发环境的执行边界。

详见 [安全模型](Security)。

## 典型用途

### 发布门禁

在 `BeforeTool` 匹配稳定版 tag push，只做快速、确定性的 repository state validation；权威多平台验证继续交给云端 CI。

### Worktree finalize 门禁

用 `BeforeWorktreeClose` 确认生成文件、测试或项目规则已经满足，再允许 fast-forward 集成。

### 文件变更后的自动动作

用 `AfterFileChange` 做轻量 metadata 更新、日志或项目特定收尾。

### Subagent 审计

通过 `SubagentStart` / `SubagentStop` 记录本地 worker 生命周期，而不把 provider 内部执行伪装成 Host 自己的过程。

## 兼容旧格式

旧的 inline `config.json -> hooks`、全局 `hooks.json` 和项目 `.forgerelay/hooks.json` 聚合格式仍然兼容，但新配置建议使用独立 `hooks/*.json` 文件。

完整字段与事件定义见主仓库 [Configuration Reference — Lifecycle hooks](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#lifecycle-hooks)。
