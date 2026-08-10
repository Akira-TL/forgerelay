# 通过 Headless LSP Language Service 提供只读代码智能

ForgeRelay 0.4 通过现有 `code.intelligence` Capability Gateway 接入外部 Language Server，而不新增 Core MCP tool，也不自动安装或管理语言服务器。ForgeRelay 作为一个窄而正规的 headless LSP client：负责发现、启动、初始化、同步、取消、重启与资源回收，并把不同 LSP wire shape 归一成稳定的 Agent-facing code-intelligence contract；第一版只提供 definition、references、hover/type、diagnostics、document symbols 和 workspace symbols，拒绝 language server 反向修改 workspace、执行命令或要求 Host UI 决策。

Language service 绑定 canonical Language project root、Language-server definition 与其 effective configuration fingerprint，而不是绑定 logical `workspaceId`；因此指向同一物理语言项目的 logical workspaces 共享服务，managed worktree 或 nested language project 自然获得独立服务。服务按第一次 code-intelligence 请求惰性启动、受容量和空闲回收约束；项目根由访问路径向上按 server definition 的 marker 规则发现，显式项目配置覆盖全局配置，全局配置覆盖 built-in discovery，并允许显式禁用自动发现。

ForgeRelay Workspace 的磁盘内容是 v1 唯一文件真源，不引入 unsaved-buffer 系统或整仓 recursive watcher。Agent-facing 位置使用 ForgeRelay 自己的稳定行列语义并在内部转换为协商后的 LSP position encoding；结果路径可以指出只读 External code location，但不会扩大 allowed-root 或文件读取权限；references、symbols、diagnostics、stderr 与内部缓存均保持 bounded。协议通信复用 Microsoft `vscode-jsonrpc` 与 `vscode-languageserver-protocol` 这一底层 substrate，而不自行实现 framing，也不引入面向 VS Code extension runtime 的完整 `vscode-languageclient`。

## Consequences

- ForgeRelay 只把本机或项目已经存在的语言语义能力变成 Host 无关的代码智能层，不演化成 IDE、语言服务器安装器或第二套文件编辑通道。
- Language-server capability negotiation 决定一次具体 Language service 实际支持哪些 operation；Capability 存在不代表所有 server 都支持全部方法。
- 自动化测试使用真正走 stdio JSON-RPC 的 deterministic fake LSP server 覆盖 lifecycle、同步、取消、崩溃、capability negotiation 与结果归一化；真实 language server interoperability 作为可选验收，缺失时明确 skip，不能成为 CI 的隐式外部依赖。
