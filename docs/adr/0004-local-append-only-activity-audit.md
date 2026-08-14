# Activity 审计以本地 append-only 事实为权威

ForgeRelay 将 Activity 的执行历史作为本地审计数据保存，而不是把 Activity Panel 或云端 Host 当作权威状态。每个执行事实以不可变 Audit Event 追加记录，Activity Record 由这些事实投影得到；因此已经 `returned` 的 Bash Activity 不会在后台完成后被改写，后续完成会形成新的审计事实和独立的 Bash result Activity。Host/MCP App 只按需读取 summary/detail，不建立 ForgeRelay 管理的云端审计副本。

第一版复用 ForgeRelay 现有本地状态数据库和操作系统文件权限边界，不增加静态加密或独立密钥管理。审计记录默认保留，直到用户显式清理；后续 retention/prune 可以作为独立策略演进，但不能让 UI 生命周期或内存回收隐式删除审计事实。
