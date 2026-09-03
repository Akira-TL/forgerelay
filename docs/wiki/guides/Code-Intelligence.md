# 代码智能

ForgeRelay 的代码智能（Code Intelligence）通过语言服务器协议（Language Server Protocol, LSP）提供定义、类型/悬停、引用、符号和诊断等语义信息。

它通过 `code.intelligence` Capability 暴露，不为每种语言增加一组顶层 MCP tool。

## 支持的操作

LSP v1 支持：

```text
definition
hover
references
documentSymbols
workspaceSymbols
diagnostics
```

这些结果由 ForgeRelay 归一化成稳定的 location、range、symbol、hover 和 diagnostic 结构，而不是把各语言服务器原始 wire format 直接交给 Agent。

## Language Server 安装与发现

Language Server 仍然是独立运行的外部进程，但 ForgeRelay 可以托管一部分安装。

`forgerelay init` 可以把下面两组 npm Language Server 安装到 ForgeRelay 自己的配置目录，而不是全局 npm：

- TypeScript / JavaScript：`typescript-language-server` + TypeScript；
- Python：Pyright。

`rust-analyzer`、`gopls` 和 `clangd` 仍由各自 toolchain / 系统包提供，ForgeRelay 只负责发现。

Agent 按需安装默认关闭。用户在 init 中显式允许后，Agent 可以调用：

```text
code.intelligence { operation: "managed.status" }
code.intelligence { operation: "managed.install", servers: ["typescript"] }
```

安装成功后不需要重启 ForgeRelay。下一次 semantic request 会重新解析可执行文件；如果 Language Service 的 command/fingerprint 变化，旧 idle service 会被替换。

## 什么时候用 Code Intelligence

适合：

- 找符号定义；
- 判断变量/函数的类型；
- 查找真实语义引用；
- 获取 document/workspace symbols；
- 获取 Language Server diagnostics；
- 在大型代码库中减少纯文本搜索的误报。

不适合把它当作：

- 通用全文搜索；
- Git history 查询；
- 自动重构器。

普通文本检索仍可以通过 `bash` 使用 `rg`、`find` 等本机工具。

## 配置优先级

Effective Language Server definition 按下面顺序解析：

1. 项目 `.forgerelay/language-servers.json`；
2. 全局 `~/.forgerelay/config.json` 中的 `languageServers`；
3. ForgeRelay built-in discovery。

项目配置覆盖全局配置，两者都覆盖 built-in defaults。

显式配置可以通过：

```json
{
  "typescript": {
    "enabled": false
  }
}
```

关闭对应 built-in definition。

## 项目配置示例

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "env": {},
    "languages": [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact"
    ],
    "extensions": [".ts", ".tsx", ".js", ".jsx"],
    "languageIdByExtension": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    },
    "projectMarkers": ["tsconfig.json", "jsconfig.json"]
  }
}
```

Language Server 通过结构化 process launch 启动，不经过 Shell command string。

主仓库提供可复制示例：[`examples/language-servers.json`](https://github.com/Akira-TL/forgerelay/blob/main/examples/language-servers.json)。

## Language Project 与 Workspace 不一定相同

一个 ForgeRelay Workspace 可以包含多个嵌套 Language Project。

ForgeRelay 根据 definition 的 `projectMarkers` 从当前 source path 向祖先目录寻找最近项目边界，而不是递归扫描整个 Workspace。

例如 monorepo 中：

```text
repo/
├── apps/web/tsconfig.json
└── packages/core/tsconfig.json
```

两个目录可以对应不同 Language Project / Language Service，即使它们属于同一个 ForgeRelay Workspace。

## Language Service 复用

Language Service 按物理 Language Project identity 管理。

多个逻辑工作上下文如果指向同一个实际 checkout / language project，可以共享同一个语言服务器进程；真正不同的 Managed Worktree 或嵌套项目自然得到不同 service。

这样可以避免每次 Host Turn 或 conversation 都重复启动完整语言服务器。

## Position 约定

Code Intelligence 输入位置使用：

- 1-based line；
- 1-based Unicode code-point column。

不要把 LSP 原生常见的 0-based position 直接塞进 ForgeRelay Capability。

## Definition

`definition` 返回归一化 source location。

结果可能指向 Workspace 外部，例如 dependency source、标准库或 toolchain declaration。这种结果会标记为 external，只用于信息展示，**不会扩大 ForgeRelay 的 allowed roots 或文件读取权限**。

## Hover

`hover` 会把 plaintext、Markdown 和支持的 legacy LSP payload 归一化为一个 `contents` 字符串，并可附带 language 与 range metadata。

适合快速确认类型、签名和 Language Server 提供的文档。

## References

`references` 使用与 definition 相同的 normalized location shape。

默认最多返回 100 个 location，可通过有界 `limit` 调整。大项目里应合理限制返回量，而不是一次请求无限结果。

## Symbols

### Document Symbols

针对一个文件返回 symbol hierarchy。Language Server 提供层级结构时 ForgeRelay 会保留层级；旧式 flat response 仍保持 flat。

### Workspace Symbols

先通过 `path` 选择一个具体 Language Project / Service，再按 `query` 搜索 symbol。

ForgeRelay 不会静默把多个嵌套 Language Service 的 workspace-symbol 结果混成一锅，因此调用者要明确查询的项目上下文。

## Diagnostics

ForgeRelay 优先使用 Language Server 的 pull diagnostics；如果服务器不支持，则读取最新有界 `publishDiagnostics` snapshot。

结果会包含 provider、返回数量、是否截断以及 freshness metadata，帮助 Agent 判断当前诊断是否对应已同步的文件版本。

成功的 `write`、`edit`、`rename` 和 Codex `apply_patch` 会自动对受影响的代码文件执行 diagnostics，并把非空诊断直接追加到**同一次 mutation response**。这不会额外创建一个 Activity；没有匹配 Language Server 的文件会静默跳过，LSP 自身校验失败也不会回滚已经成功的文件修改，而是返回有界 warning 让 Agent 继续处理。

Code Intelligence 的 Workspace filesystem 是 v1 的 document source of truth。

## Timeout、取消与崩溃恢复

ForgeRelay 为 semantic request 设置内部有界 deadline 和并发/排队预算，这些不是让 Agent随意调大的 per-call timeout 参数。

Host cancellation 会向 LSP request 传播 cancellation。

如果 Language Server 意外崩溃，ForgeRelay 最多自动重试一次；重复崩溃会进入短暂 cooldown，避免无限重启循环。

## Managed Worktree 与 Language Service

Managed Worktree finalize 前，ForgeRelay 会释放以该 worktree 为 root 的语言服务。

如果仍有 active semantic work，finalize 会被拒绝，而不是一边删除 worktree 一边让 Language Server 继续读已经消失的目录。

## 实机互操作验证

ForgeRelay 仓库开发者可以运行：

```bash
npm run lsp:interop
```

它只测试当前机器 `PATH` 上真实存在的支持语言服务器，缺失项会明确 skip，不会安装额外依赖。

## 常见问题

### `code.intelligence` 没出现

先检查 `open_workspace` 返回的 Capability catalog/fingerprint。如果 Server 报告该能力但 Host tool metadata 过旧，刷新 MCP integration。

### Language Server 找不到

运行 ForgeRelay 的环境和你的交互式 Shell 可能不是同一个 `PATH`。显式配置 `command` 可以避免依赖模糊发现。

### Monorepo 查错项目

检查 `projectMarkers`，并确认调用所给 `path` 位于期望的 Language Project 中。

### Definition 指到 Workspace 外

这是允许的信息结果，不代表 `read` 自动获得该外部路径权限。

完整参考见主仓库 [Configuration Reference — LSP code intelligence](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#lsp-code-intelligence)。
