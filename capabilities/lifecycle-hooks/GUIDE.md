# ForgeRelay 生命周期 Hooks

当任务涉及新增、修改、排查或解释 ForgeRelay Hook 时读取本指南。Hook 是 ForgeRelay 自己的生命周期规则，不是权限审批系统，也不是 Git hook。

## 配置位置

- 全局 Hook：ForgeRelay 配置目录下的 `hooks/<hook-name>.json`。
- 项目 Hook：工作区根目录下的 `.forgerelay/hooks/<hook-name>.json`。
- 一个文件定义一个 Hook；文件名去掉 `.json` 后就是 Hook 名。
- 同一作用域内按文件名字典序执行；需要显式顺序时可使用数字前缀。
- 全局与项目 Hook 会组合执行，项目规则不会覆盖机器级全局规则。

旧的 inline `hooks`、全局 `hooks.json` 和项目 `.forgerelay/hooks.json` 聚合格式仍作为兼容入口读取。

## 规则模型

每个独立 Hook 文件包含：

- `event`：生命周期事件；
- 可选 `matcher`：只在匹配时执行；
- `command`：由 ForgeRelay 以本地用户权限执行的命令；
- 可选 timeout；
- 可选 `report`，默认 `true`。

当前事件包括：`WorkspaceOpen`、`BeforeTool`、`AfterTool`、`AfterToolFailure`、`ExternalMcpBeforeForward`、`ExternalMcpAfterForward`、`AfterFileChange`、`BeforeWorktreeClose`、`AfterWorktreeClose`、`SubagentStart`、`SubagentStop`。

External MCP transform 事件只用于 `mcp.external`。matcher 可额外使用 `capability`、`externalServer`、`externalTool`，从而绑定到已配置的 Capability/server/tool；这些字段只是现有目标的匹配条件，不能动态指定新的连接目标。

## 阻断与报告

`BeforeTool`、`BeforeWorktreeClose` 以及两个 External MCP transform 事件都会在失败时令当前操作失败。Before-forward transform 失败时 upstream MCP call 不会发生；After-forward transform 失败时 upstream call 已经发生，只会阻止变换后结果继续交付并把 Capability 标成失败，不能声称回滚 upstream 已产生的副作用。其他普通 after-event 只观察已经发生的结果，失败也不会伪装成能够回滚先前副作用。

Hook report 会随工具结果返回给 Host/Agent。`report: false` 只隐藏成功的高频报告；阻断失败始终可见。Agent 看到有意义的 Hook report 时必须告诉用户哪些 Hook 运行了、是否通过，以及操作是否被阻断；不能在 blocking Hook 阻止操作后声称原操作成功。

## External MCP transform 协议

普通 Hook 的 stdout 仍然只是命令输出，**不会**改写工具结果。只有 `ExternalMcpBeforeForward` / `ExternalMcpAfterForward` 使用显式 structured transform 协议：ForgeRelay 将 versioned JSON 写入 Hook stdin，并只接受 stdout 中一个合法 JSON envelope。

- request phase 输入包含当前 `server`、`tool` 与 `request.arguments`；输出必须是 `{"version":1,"request":{"arguments":{...}}}`。server/tool 不能被改写。
- result phase 输入包含当前 upstream MCP result；输出必须是 `{"version":1,"result":{...}}`。输出随后重新经过标准 MCP result、Media MIME/base64 与 `mediaMaxBytes` 校验。
- Hook 环境中的 `FORGERELAY_HOOK_PAYLOAD` 只包含 Capability/server/tool/phase 等有界匹配元数据；任意 arguments、upstream payload 和 image base64 只通过 transform stdin/stdout 瞬态传递。

## 安全边界

项目 Hook 属于项目执行约定，不需要额外审批，但不能扩大 allowed roots、覆盖认证边界或替换机器级全局规则。Hook command 与 shell 一样以运行 ForgeRelay 的本地用户权限执行；工作区文件边界不等于 OS sandbox。Transform Hook 如果主动读取文件或访问网络，那是该用户配置命令自身的 OS 权限，不代表 ForgeRelay 自动获得了新的 `read` 或网络权限。

## 检查入口

Agent 打开工作区后会在 Capability catalog 中看到 `hooks.check`。已经熟悉 contract 时可直接通过 `capability` 执行；不熟悉时先 `capability(action="describe")` 查看参数与本指南路径，再按需读取本指南。`hooks.check` 是只读检查，只接受空参数对象，并返回当前生效的全局/项目 Hook 数量；无效项目 Hook 会作为稳定的 capability execution error 返回。

CLI 仍保留给人工终端或兼容工作流：使用 `forgerelay hooks list` 查看已发现规则，使用 `forgerelay hooks check` 做只读校验。排查 Hook 时优先确认配置来源、event/matcher 是否命中、handler 的实际退出状态，以及 tool result 中的 Hook report。