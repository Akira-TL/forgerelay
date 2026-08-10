# MCP 采用稳定核心工具面与统一 Capability Gateway

ForgeRelay 的 canonical MCP interface 采用一个小而稳定的 Core tool surface：`open_workspace`、`close_workspace`、`read`、`write`、`edit`、`rename`、`delete`、`bash`、`capability`。普通编码所需 primitive 始终直接可见；低频 ForgeRelay action 不再各自长期占用一个 MCP tool，而是注册为 Capability，由 `open_workspace` 返回轻量 Capability catalog，并通过单一 `capability` gateway 查询或执行。Capability guide 继续作为按需读取的详细说明，而不是把完整 schema、示例和规则重新塞回 bootstrap。

Managed worktree 是 Workspace 的 backing mode，而不是需要 Host 单独管理的第二生命周期对象，因此最终由 `close_workspace` 统一完成 checkout/worktree 的关闭语义；长进程也由 `bash` 统一负责启动和后续 process interaction，`write_stdin` 不再作为独立公开工具。这个设计用更深的 MCP interface 换取稳定的 Host schema、较小的首次上下文和未来能力扩展时更好的 locality；`capability` 只能调用 ForgeRelay registry 中显式注册、带描述、输入约束、可用性和 guide metadata 的能力，不能成为任意 RPC 或 shell 后门。

迁移在 0.3.x 内分阶段完成：先建立 registry/catalog/gateway，再迁移现有低频 action，随后合并 workspace/process lifecycle，最后收口 public surface 与兼容层。0.4 仍保持 LSP code intelligence 主题，不承担这次 MCP surface 重构。
