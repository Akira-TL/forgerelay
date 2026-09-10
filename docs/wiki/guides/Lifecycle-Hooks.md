# 生命周期 Hooks

Lifecycle Hook 是 ForgeRelay 自动执行的本地规则。适合把测试、发布门禁、审计或项目约定挂到真实 tool lifecycle 上，而不是指望 Agent 每次都记得手动执行。

## 文件位置

推荐一个 Hook 一个 JSON 文件。

全局：

```text
~/.forgerelay/hooks/<hook-name>.json
```

项目：

```text
<workspace>/.forgerelay/hooks/<hook-name>.json
```

文件名去掉 `.json` 就是 Hook 名，也会出现在日志和 Agent-visible report 中。目录按文件名字典序执行，需要顺序时可以加数字前缀：

```text
.forgerelay/hooks/10-release-verify.json
.forgerelay/hooks/20-package-inspection.json
```

全局 Hook 在 Server 启动时读取，修改后需要重启。项目 Hook 在事件发生时重新读取，通常不用重启 ForgeRelay。

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

| 字段 | 说明 |
| --- | --- |
| `event` | 必填，生命周期事件 |
| `matcher` | 可选，匹配当前 request |
| `command` | 必填，本地 Shell 命令 |
| `timeoutSeconds` | 默认 `30`，范围 `1..300` |
| `report` | 默认 `true`，控制成功结果是否主动展示 |

独立文件不需要 `name`。

## Matcher

| 字段 | 匹配方式 |
| --- | --- |
| `tool` | 精确匹配 MCP tool 名称 |
| `commandRegex` | 对 request 中的 `command` 做 JavaScript 正则匹配 |
| `pathRegex` | 对 `path` / `paths` 做正则匹配 |
| `provider` | 精确匹配 Subagent provider |
| `workspaceMode` | 匹配 `checkout` 或 `worktree` |
| `capability` | 精确匹配 Capability 名；External MCP 使用 `mcp.external` |
| `externalServer` | 精确匹配当前已配置的 External MCP Server |
| `externalTool` | 精确匹配当前调用的 upstream MCP tool |

`capability` / `externalServer` / `externalTool` 只匹配 ForgeRelay 已经选择的 target。Transform Hook 不能借 stdout 改成另一台 Server、另一个 tool、任意 URL、command 或 credential。

Matcher 只看 ForgeRelay 收到的 tool request。

例如：

```text
bash(command="git push origin v0.8.4")
```

可以被 `commandRegex` 命中。但：

```text
bash(command="./release.sh")
```

即使 `release.sh` 内部又执行 `git push`，ForgeRelay 也不会把那个子进程重新解释成一条 MCP request。

## 事件

| Event | 发生时间 | Blocking |
| --- | --- | --- |
| `WorkspaceOpen` | 新 Workspace session 创建后 | 否 |
| `BeforeTool` | Workspace-scoped tool 执行前 | 是 |
| `AfterTool` | Tool 成功后 | 否 |
| `AfterToolFailure` | Tool 失败或被 `BeforeTool` 拒绝后 | 否 |
| `ExternalMcpBeforeForward` | 已选择 External MCP Server/tool、upstream 调用前 | 是 |
| `ExternalMcpAfterForward` | upstream 调用成功返回后、Host 交付前 | 是* |
| `AfterFileChange` | 明确文件变更成功后 | 否 |
| `BeforeWorktreeClose` | worktree commit / fast-forward / cleanup 前 | 是 |
| `AfterWorktreeClose` | managed worktree 成功关闭后 | 否 |
| `SubagentStart` | 本地 Subagent worker 开始执行 | 否 |
| `SubagentStop` | Subagent 完成或进入 error | 否 |

`AfterFileChange` 只覆盖 ForgeRelay 明确知道的文件修改，例如 `write`、`edit`、`rename`、`delete`、`apply_patch` 和 native artifact mutation。它不会猜测任意 Shell 命令改了哪些文件。

`ExternalMcpBeforeForward` / `ExternalMcpAfterForward` 是专门的 Transform Hook。ForgeRelay 把 versioned JSON envelope 写到 Hook stdin，并只接受对应的 structured JSON stdout：before-forward 可以替换当前 request `arguments`；after-forward 可以替换当前 MCP `result`。普通 lifecycle Hook stdout 仍只是命令输出，不会改写 tool data。转换后的 result 还会重新经过 MCP shape、media MIME/base64 和 size budget 校验。

## Blocking 和 observational

`BeforeTool`、`BeforeWorktreeClose` 和 `ExternalMcpBeforeForward` 都能阻止原操作开始。Hook exit code 非零、超时或被 Host cancellation 中断时，待执行的原操作不会继续。

`ExternalMcpAfterForward` 的失败会阻止变换后的结果继续交付给 Host，但它发生在 upstream MCP 已经成功返回之后；因此它**不能回滚 upstream 已经产生的副作用**。表格里的 `是*` 指这个交付阻断语义，而不是事务回滚。

这不是事务。Hook command 自己在失败前已经产生的外部副作用也不会自动回滚。

其他 After* 事件发生在事实已经成立之后，失败不会回滚已经写入的文件、Git 操作、网络请求或进程。因此它们更适合通知、审计和收尾。

## Agent-visible report

默认 `report:true`。成功结果可以附在 tool result：

```text
Hook results:
✓ release-tag-gate (BeforeTool, project) passed in 42ms
```

`report:false` 可以隐藏高频成功信息，但 blocking failure 始终可见。

重要 Hook result 应由 Agent 告诉用户，尤其是门禁是否通过、为什么被阻断。

## 只检查配置

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

`list` 显示实际加载的 scope、event、matcher、timeout、report 和 command。`check` 只解析 schema，不执行 Hook；坏配置会返回非零状态。

项目里某个 Hook 文件损坏时，ForgeRelay 会报告 diagnostic，并继续加载其他有效 Hook，让 Workspace 仍然可以修复这个文件。

## Hook 环境变量

Hook 继承 ForgeRelay Server 环境，并额外获得：

```text
FORGERELAY_HOOK_EVENT
FORGERELAY_HOOK_PAYLOAD
FORGERELAY_WORKSPACE_ROOT
FORGERELAY_WORKSPACE_ID
FORGERELAY_WORKSPACE_MODE
FORGERELAY_SOURCE_ROOT
FORGERELAY_TOOL_NAME
```

Payload 不携带文件正文、native-file credential 或 Subagent prompt。但 Shell command metadata 本身仍可能包含敏感参数，所以 Hook 日志也要按敏感输入处理。

## 安全边界

Hook command 和 ForgeRelay 使用同一个本地 OS user 权限。

项目 `.forgerelay/hooks/*.json` 不是无害 metadata，而是可执行的项目约定。允许某个 project root 后，也要把它的 Hook 视为该开发环境的一部分。

详见 [安全模型](Security)。

## 常见用途

`BeforeTool` 很适合做稳定 tag push 前的快速 release gate；`BeforeWorktreeClose` 可以在 fast-forward 集成前检查测试或生成文件；`AfterFileChange` 可以做轻量项目收尾；`SubagentStart` / `SubagentStop` 可以记录本地 worker 生命周期。

旧的 inline `config.json -> hooks`、全局 `hooks.json` 和项目 `.forgerelay/hooks.json` 聚合格式仍兼容，但新配置建议使用独立 `hooks/*.json` 文件。

完整字段见 [Configuration Reference — Lifecycle hooks](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#lifecycle-hooks)。
