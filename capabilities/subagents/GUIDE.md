# ForgeRelay Subagents

当任务涉及委派给另一个本地 coding agent、获取第二意见、并行调查，或用户明确点名 subagent 时读取本指南。

## 当前接口边界

0.3 仍然使用 ForgeRelay CLI 协调 provider-backed local subagent；当前没有 first-class MCP subagent tool。不要把 Host 自己的 subagent 功能与 ForgeRelay subagent 混为一谈。

启用方式：

```bash
FORGERELAY_SUBAGENTS=1 forgerelay serve
```

启用后，`open_workspace` 会返回紧凑的 `agentProviders` 和 `agents` 元数据。配置 profile 通常来自全局 ForgeRelay 配置目录以及项目内：

```text
.forgerelay/agents/*.md
.devspace/agents/*.md
```

旧 `.devspace` 路径仅用于迁移兼容。

## 何时使用

不要因为存在 profile 就自动委派普通开发工作。只有在用户要求委派、第二意见、并行工作或指定 subagent/provider 时才使用，并明确告诉用户正在使用另一个 subagent。

选择 profile 时以 `open_workspace` 返回的 compact profile catalog 为准。`forgerelay agents ls` 显示的是当前 workspace 的已有 subagent sessions，不是 profile 定义列表。

## 常用命令

正常委派只需要：

```bash
forgerelay agents ls
forgerelay agents run <profile-or-provider-or-id> "<prompt>"
forgerelay agents show <id>
```

语义：

- `run <profile>`：启动配置好的 profile；
- `run <provider>`：没有合适 profile 时直接启动 ForgeRelay 内建 provider；
- `run <id>`：向现有 agent session 发送 follow-up；
- `show <id>`：查看状态和最新响应；仍在运行时可稍后再次调用；
- shell workspace 环境会把 CLI 操作自动限定到当前 ForgeRelay workspace。

如确实需要覆盖 profile/provider 默认值，可使用：

```bash
forgerelay agents run <profile-or-provider> --model <model> "<prompt>"
forgerelay agents run <profile-or-provider> --thinking <level> "<prompt>"
```

`thinking` 是 provider-specific passthrough；ForgeRelay 不在 provider 之间翻译 reasoning level。

除非正在明确调试 ForgeRelay provider integration，不要绕过 ForgeRelay 直接运行 `codex`、`claude`、`opencode`、`pi`、`cursor-agent`、`copilot` 等 provider CLI。

## Prompt 与验证

Subagent 只收到你发送的 prompt 和它自己的 profile instructions，因此 prompt 必须自包含：目标、相关模块/文件、约束、验收标准，以及它能否修改文件。

Subagent 的结果不是自动验证过的最终答案。收到响应后：

- 写入型任务：检查实际改动并运行相关测试；
- 只读调查：核对关键结论是否有仓库证据；
- 向用户说明使用了哪个 profile/provider、它给出的结论、你做了哪些验证，以及剩余风险。

`SubagentStart` / `SubagentStop` lifecycle Hooks 会在 worker 生命周期中触发；异步报告会随 ForgeRelay session 持久化并可由 `forgerelay agents show` 查看。
