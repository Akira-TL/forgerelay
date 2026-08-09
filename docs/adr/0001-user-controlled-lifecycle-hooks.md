# 生命周期 Hook 采用自动规则而不是审批流

ForgeRelay Hooks v1 把 Hook 定义为用户或 Agent 主动写入的生命周期规则。规则在对应事件发生前后自动执行，不引入额外批准步骤，也不复制 Claude Code 的权限或交互审批体系。

Hook 有两个作用域：全局规则来自当前 ForgeRelay 配置目录，项目规则来自工作区根目录的 `.forgerelay/hooks.json`。两类规则组合执行，项目规则不会覆盖全局规则。项目 Hook 是项目执行约定的一部分；ForgeRelay 打开允许根目录中的工作区后会直接使用这些规则，包括 `WorkspaceOpen`。

每条规则由可选 matcher 和有序 handlers 组成。`BeforeTool` 与 `BeforeWorktreeClose` 属于阻断事件：命中的 handler 失败或超时后，原操作不继续。其余事件用于观察已发生的生命周期结果，失败会被记录，但不会伪装成可以回滚已经完成的文件、Git 或进程副作用。

handler 的执行结果对 Agent 可见。`report` 默认为 `true`；设为 `false` 可以隐藏成功的高频 Hook 报告，但阻断失败始终可见。ForgeRelay 的模型指令要求 Agent 在结果中出现 Hook report 时，向用户说明有意义的 Hook 是否通过或阻断了操作。

这个设计选择自动、可组合的项目规则，是因为 ForgeRelay 本身位于用户选定的本地开发环境中，没有依赖实时批准 UI 的产品前提。Hook 文件只能声明 Hook 规则，不能借此扩大 allowed roots、修改认证边界或覆盖机器级全局规则。项目 Hook 命令仍以运行 ForgeRelay 的本地用户权限执行，因此允许根目录本身仍是重要的执行边界。
