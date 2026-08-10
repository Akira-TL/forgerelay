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

当前事件包括：`WorkspaceOpen`、`BeforeTool`、`AfterTool`、`AfterToolFailure`、`AfterFileChange`、`BeforeWorktreeClose`、`AfterWorktreeClose`、`SubagentStart`、`SubagentStop`。

## 阻断与报告

`BeforeTool` 和 `BeforeWorktreeClose` 是阻断事件。命中的 Hook 失败或超时后，原操作不会继续。其他 after-event 只观察已经发生的结果，失败不会伪装成能够回滚先前副作用。

Hook report 会随工具结果返回给 Host/Agent。`report: false` 只隐藏成功的高频报告；阻断失败始终可见。Agent 看到有意义的 Hook report 时必须告诉用户哪些 Hook 运行了、是否通过，以及操作是否被阻断；不能在 blocking Hook 阻止操作后声称原操作成功。

## 安全边界

项目 Hook 属于项目执行约定，不需要额外审批，但不能扩大 allowed roots、覆盖认证边界或替换机器级全局规则。Hook command 与 shell 一样以运行 ForgeRelay 的本地用户权限执行；工作区文件边界不等于 OS sandbox。

## 检查入口

Agent 打开工作区后会在 Capability catalog 中看到 `hooks.check`。已经熟悉 contract 时可直接通过 `capability` 执行；不熟悉时先 `capability(action="describe")` 查看参数与本指南路径，再按需读取本指南。`hooks.check` 是只读检查，只接受空参数对象，并返回当前生效的全局/项目 Hook 数量；无效项目 Hook 会作为稳定的 capability execution error 返回。

CLI 仍保留给人工终端或兼容工作流：使用 `forgerelay hooks list` 查看已发现规则，使用 `forgerelay hooks check` 做只读校验。排查 Hook 时优先确认配置来源、event/matcher 是否命中、handler 的实际退出状态，以及 tool result 中的 Hook report。