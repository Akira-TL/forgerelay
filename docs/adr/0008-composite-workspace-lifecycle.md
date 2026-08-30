# 复合工作区复用现有 Workspace 生命周期

> **Partially superseded by ADR-0009.** Composite Workspace 仍复用统一 Workspace 生命周期且保持无虚构 root、显式 member routing 等边界；但 `close_workspace` 不再表示永久 dissolve。ADR-0009 将 close 与 delete 分离，只有 delete 才解散 Composite 关系。

复合工作区（Composite Workspace）作为一种与普通 Workspace 并列的 Workspace 类型，复用现有 `open_workspace` 与 `close_workspace` 入口，而不增加独立的 open/dissolve 生命周期。它自身没有虚构的文件系统根目录；成员继续拥有各自的文件、Git、进程、Hook、Skill、语言服务与 Activity 事实，复合工作区只持久化成员关系、用途定义和统一 Host-facing 身份。成员选择必须由 Agent 显式给出，ForgeRelay 不根据工具类型、用途、可用性或失败情况自动切换执行位置；`close_workspace` 对复合工作区表示解散关系，并且不得关闭成员、清理 worktree、终止进程或移除远端记录。

## Considered Options

- 没有采用独立的 `open_composite_workspace` / `dissolve_workspace`，因为这会制造第二套 Host 生命周期并迫使 Agent 事先知道工作区类型。
- 没有把复合工作区伪装成带虚拟 root 的普通目录 Workspace，因为这会模糊文件和执行权限边界。
- 没有维护隐式“当前成员”或自动按用途路由，因为并发、后台进程和远端失败时会使真实执行位置变得不可预测。
