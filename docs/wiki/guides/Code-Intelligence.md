# 代码智能

ForgeRelay 通过 LSP 提供 definition、hover、references、symbols 和 diagnostics。对 Host 来说，这些能力都走 `code.intelligence` Capability，不会为每种语言增加一组顶层 MCP tools。

## 支持的操作

```text
definition
hover
references
documentSymbols
workspaceSymbols
diagnostics
```

ForgeRelay 会把不同 Language Server 的原始响应整理成稳定的 location、range、symbol、hover 和 diagnostic 结构。

## Language Server 从哪里来

Language Server 仍然是独立进程。

`forgerelay init` 可以把 TypeScript / JavaScript (`typescript-language-server` + TypeScript) 和 Pyright 安装到 ForgeRelay 私有配置目录，不会写进全局 npm。

`rust-analyzer`、`gopls` 和 `clangd` 继续由系统或对应 toolchain 提供，ForgeRelay 只负责发现。

Agent 按需安装默认关闭。用户显式授权后，可以调用：

```text
code.intelligence { operation: "managed.status" }
code.intelligence { operation: "managed.install", servers: ["typescript"] }
```

安装成功后不用重启 ForgeRelay。下一次 semantic request 会重新解析 executable；command / fingerprint 变化时，旧 idle service 会被替换。

## 什么时候该用

Code Intelligence 适合找真实定义、类型、语义引用、symbols 和 Language Server diagnostics，尤其是在大型代码库里减少纯文本搜索误报。

它不是全文搜索、Git history 查询或自动重构器。普通文本搜索仍然可以通过 `bash` 使用 `rg`、`find` 等本机工具。

## 配置优先级

Language Server definition 按以下顺序解析：

1. 项目 `.forgerelay/language-servers.json`；
2. `~/.forgerelay/config.json` 中的 `languageServers`；
3. ForgeRelay built-in discovery。

项目配置覆盖全局配置，两者都覆盖 built-in defaults。显式关闭某个 definition：

```json
{
  "typescript": {
    "enabled": false
  }
}
```

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

Language Server 使用结构化 process launch，不经过 Shell command string。

可复制的完整示例见 [`examples/language-servers.json`](https://github.com/Akira-TL/forgerelay/blob/main/examples/language-servers.json)。

## Language Project 不等于 Workspace

一个 ForgeRelay Workspace 可以包含多个 Language Project。

ForgeRelay 从当前 source path 向上查找最近的 `projectMarkers`，不会为了找项目边界递归扫描整个 Workspace。

例如：

```text
repo/
├── apps/web/tsconfig.json
└── packages/core/tsconfig.json
```

这两个目录可以各自拥有 Language Service，即使它们属于同一个 ForgeRelay Workspace。

Language Service 按物理 Language Project identity 复用。同一个实际 checkout / language project 不会因为换了 Host Turn 或 conversation 就重复启动服务器；不同 Managed Worktree 和真正不同的嵌套项目仍然分开。

## Position 约定

Code Intelligence 输入位置使用 1-based line 和 1-based Unicode code-point column。不要直接传 LSP 常见的 0-based position。

## Definition 和 Hover

`definition` 返回归一化 source location。结果可以指向 Workspace 外部，例如 dependency source、标准库或 toolchain declaration；这种 location 会标记为 external，只提供信息，不会扩大 `read` 权限或 allowed roots。

`hover` 会把 plaintext、Markdown 和兼容的 legacy payload 归一化为 `contents`，并按可用情况附带 language / range metadata。

## References 和 Symbols

`references` 默认最多返回 100 个 location，也可以用有界 `limit` 调整。

Document Symbols 针对单个文件。Language Server 提供 hierarchy 时保留层级，旧式 flat response 仍然保持 flat。

Workspace Symbols 需要先用 `path` 选定一个 Language Project / Service，再用 `query` 搜索。ForgeRelay 不会把多个嵌套 Language Service 的结果静默混在一起。

## Diagnostics

优先使用 pull diagnostics；服务器不支持时，ForgeRelay 读取最新的有界 `publishDiagnostics` snapshot。

返回结果包含 provider、数量、截断和 freshness metadata，方便 Agent 判断诊断是不是对应当前同步版本。

成功的 `write`、`edit`、`rename` 和 Codex `apply_patch` 会对受影响的代码文件触发 diagnostics，并把非空结果附加到同一次 mutation response。没有匹配 Language Server 的文件直接跳过；LSP 校验失败不会回滚已经成功的文件修改，只返回有界 warning。

Workspace filesystem 是 LSP v1 的 document source of truth。

## Timeout、取消和崩溃

Semantic request 有内部 deadline 和并发 / 排队预算，不提供任意放大的 per-call timeout。

Host cancellation 会继续传到 LSP request。Language Server 意外崩溃时，ForgeRelay 最多自动重试一次；重复崩溃会进入短暂 cooldown，避免无限重启。

Managed Worktree finalize 前，会先释放以该 worktree 为 root 的 Language Service。有 active semantic work 时 finalize 会拒绝继续。

## 实机互操作测试

ForgeRelay 开发者可以运行：

```bash
npm run lsp:interop
```

它只测试当前 `PATH` 上已经存在的支持 Language Server，缺失项会 skip，不会下载安装依赖。

## 常见问题

### `code.intelligence` 没出现

先看 `open_workspace` 的 Capability catalog / fingerprint。Server 已报告能力但 Host schema 仍旧时，刷新 MCP integration。

### Language Server 找不到

ForgeRelay 进程的 `PATH` 可能和交互式 Shell 不同。显式配置 `command` 可以避免依赖环境发现。

### Monorepo 查错项目

检查 `projectMarkers`，并确认调用传入的 `path` 位于目标 Language Project。

### Definition 指到 Workspace 外

这是允许的只读信息结果，不代表 `read` 获得了那个路径的访问权限。

完整配置见 [Configuration Reference — LSP code intelligence](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#lsp-code-intelligence)。
