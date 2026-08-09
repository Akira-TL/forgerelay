# 生命周期 Hook 采用自动规则与独立文件

ForgeRelay Hooks v1 把 Hook 定义为用户或 Agent 主动写入的生命周期规则。规则在对应事件发生前后自动执行，不引入额外批准步骤，也不复制 Claude Code 的权限或交互审批体系。

Hook 有两个作用域。全局 Hook 首选放在当前 ForgeRelay 配置目录的 `hooks/<hook-name>.json`，项目 Hook 首选放在工作区根目录的 `.forgerelay/hooks/<hook-name>.json`。一个文件就是一个 Hook；文件名去掉 `.json` 后就是 Hook 名，并直接用于日志和 Agent-visible report。目录内按文件名字典序执行，因此需要显式顺序时可以使用数字前缀。全局与项目规则组合执行，项目规则不会覆盖全局规则。

每个独立 Hook 文件只包含一个 event、可选 matcher 和一个 command，以及 timeout/report 选项。这个约束刻意避免在一个大配置文件里堆积互不相关的规则，也避免文件名与内部 `name` 重复维护。需要多个步骤时拆成多个文件，使每一步可以独立重命名、排序、审查或删除。旧的 inline `hooks`、全局 `hooks.json` 和项目 `.forgerelay/hooks.json` 聚合格式继续作为兼容入口。

`BeforeTool` 与 `BeforeWorktreeClose` 属于阻断事件：命中的 Hook 失败或超时后，原操作不继续。其余事件用于观察已发生的生命周期结果，失败会被记录，但不会伪装成可以回滚已经完成的文件、Git 或进程副作用。

Hook 的执行结果对 Agent 可见。`report` 默认为 `true`；设为 `false` 可以隐藏成功的高频 Hook 报告，但阻断失败始终可见。ForgeRelay 的模型指令要求 Agent 在结果中出现 Hook report 时，向用户说明有意义的 Hook 是否通过或阻断了操作。

项目 Hook 是 allowed root 内项目执行约定的一部分，不需要额外批准。Hook 文件只能声明生命周期规则，不能借此扩大 allowed roots、修改认证边界或覆盖机器级全局规则。项目 Hook 命令仍以运行 ForgeRelay 的本地用户权限执行，因此 allowed roots 仍是重要的执行边界。
