# 配置指南

ForgeRelay v1.2 使用统一的 Config System v2。日常使用不需要理解内部实现，但有几条规则很重要：配置按明确 scope 合并，Project Local 与项目仓库分离，可热加载的配置使用 last-known-good 保护，启动不会偷偷改写旧配置。

主仓库的完整字段参考见 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md)。

## 先记住这几个命令

```bash
forgerelay doctor
forgerelay config check
forgerelay config sources
forgerelay config explain <logical-path>
```

指定作用域或机器可读输出：

```bash
forgerelay config check --global --json
forgerelay config check --project /path/to/project
forgerelay config sources --project /path/to/project --json
forgerelay config explain mcp.servers.renderer --project /path/to/project --json
```

`config check` 只解析配置，不会为了检查而启动 Hook、Language Server 或 stdio MCP，也不会主动连接 HTTP MCP。`config sources` 用来回答“这个值从哪里来”，`config explain` 用来回答“为什么最后是这个值”。敏感配置的解析后 secret 不会输出；`${ENV_NAME}` 这类安全的 configured reference 可以保留用于排障。

这些 CLI 是离线检查工具。它们不会假装知道另一个正在运行的 ForgeRelay 进程当前保留的内存 LKG 或已经 applied 的 restart-required 值。运行进程自己的 actionable config 状态会出现在 Activity Panel 的配置状态里。

## Canonical 配置域

默认 ForgeRelay config directory 是：

```text
~/.forgerelay
```

可用 `FORGERELAY_CONFIG_DIR` 改到其他位置。

v1.2 的 canonical 配置域如下：

| Domain | User | Project | Project Local |
| --- | --- | --- | --- |
| General | `~/.forgerelay/config.json` | `<project>/.forgerelay/config.json` | `~/.forgerelay/projects/<project-id>/config.json` |
| External MCP | `~/.forgerelay/mcp.json` | `<project>/.forgerelay/mcp.json` | `~/.forgerelay/projects/<project-id>/mcp.json` |
| Language Servers | `~/.forgerelay/language-servers.json` | `<project>/.forgerelay/language-servers.json` | `~/.forgerelay/projects/<project-id>/language-servers.json` |
| Lifecycle Hooks | `~/.forgerelay/hooks/*.json` | `<project>/.forgerelay/hooks/*.json` | `~/.forgerelay/projects/<project-id>/hooks/*.json` |
| Subagent Profiles | `~/.forgerelay/subagents/*.md` | `<project>/.forgerelay/subagents/*.md` | `~/.forgerelay/projects/<project-id>/subagents/*.md` |

上表中的 `~/.forgerelay` 表示当前 active config directory；如果设置了 `FORGERELAY_CONFIG_DIR`，User 和 Project Local 路径都会跟着变化。

Project Local 是 ForgeRelay 机器私有状态，绑定 canonical Project identity，不写进项目 checkout，也不应该提交到 Git。Workspace identity 与 Project identity 是不同概念：同一 Project 的持久私有配置不依赖某一次 conversation 或某一个 Workspace backing。

## Credentials 不属于普通 Config Resolver

Credential 使用独立存储，例如：

```text
~/.forgerelay/auth.json
~/.forgerelay/mcp-auth.json
```

它们不按普通 Config precedence 合并，也不应该写进 Project 配置。

External MCP 的静态 `headers` / stdio `env` 如果直接写在配置里，仍然是普通配置内容；推荐用受支持字段里的 `${ENV_NAME}` 引用环境变量，而不是把真实 token 提交进项目。

## Precedence

统一 precedence 是：

```text
runtime > project-local > project > user > built-in
```

其中 runtime CLI override 高于 runtime environment。只有某个字段允许的 scope 才参与解析；不是所有 General 字段都可以由 Project 覆盖。

对于 keyed domain（External MCP、Hooks、Language Servers、Subagent Profiles），同名 entry 由更高 scope 决定。支持 tombstone 的 canonical entry 使用：

```json
{
  "disabled": true
}
```

来屏蔽下层同名定义。删除高层 tombstone 后，下层定义可以重新显现。

用 `config explain` 查看实际 winner、shadow chain、reload policy 和 execution effect，而不是靠猜。

## `$schema`

v1.2 npm package 自带 versioned JSON Schemas：

```text
schemas/v1/config.user.schema.json
schemas/v1/config.project.schema.json
schemas/v1/config.project-local.schema.json
schemas/v1/mcp.*.schema.json
schemas/v1/language-servers.*.schema.json
schemas/v1/hooks.*.schema.json
```

Canonical JSON 可以带 `$schema`，便于编辑器补全和校验。`$schema` 是 editor metadata，不改变 Config precedence。一个过期或不符合当前 scope 的 `$schema` 会产生 warning，不会因为 URL 本身不同就直接阻止运行；真正的配置结构错误仍会报 error。

Subagent Profile 是 Markdown + YAML frontmatter，因此没有单独生成 JSON Schema 文件。

## 环境变量引用与 secrets

受支持的敏感字段可以写：

```json
{
  "headers": {
    "Authorization": "Bearer ${MCP_TOKEN}"
  }
}
```

插值只发生在 Config Definition 明确允许的字段，不是任意字符串模板系统。缺失环境变量会产生 diagnostic。

`config explain` 对敏感 effective value 做 redaction；它可以显示 `${MCP_TOKEN}` 这样的配置引用，但不会打印解析后的 token。不要依靠普通日志作为 secret manager。

## Hot reload、LKG 与 deletion

Canonical External MCP、Language Server、Hook 和 Subagent Profile sources 使用 demand-driven content refresh。ForgeRelay 比较内容 fingerprint，而不是依赖 mtime 作为正确性来源。

当一个已经成功加载的 source 被临时写坏：

1. 当前操作看到 diagnostic；
2. 运行中的 ForgeRelay 保留这个 source 上一次完整合法的 last-known-good；
3. 不会把“部分合法字段”与坏版本混合起来；
4. 修复文件后，后续安全操作边界自动切换到新版本；
5. 删除 source 会清除该 source 的 LKG contribution，而不是永久保留幽灵配置。

目录型 domain（Hooks、Subagent Profiles）按文件独立维护 LKG，所以一个坏文件不会让所有 sibling 文件一起失效。

长生命周期资源（例如 Language Service）在 effective config fingerprint 改变时使用 generation retirement：新工作进入新 generation，已有工作先完成，不会在一次语义操作中途被替换。

## Restart-required General 配置

某些 General 字段（例如 bind host/port）需要 restart 才能真正 applied。ForgeRelay 不会因为文件变化自动重启自己。

运行进程可以同时知道：

- configured value：配置现在写的是什么；
- applied value：当前进程实际用的是什么。

离线 `config check` 无法知道另一个进程已经 applied 的值，所以会明确标记 live state unknown，而不是伪造答案。

## 初始化

基础初始化：

```bash
forgerelay init
```

只询问首次使用真正需要的内容：

- allowed project roots；
- client 如何连接这个 ForgeRelay（local / SSH relay / LAN / HTTPS proxy，并按选择补必要连接信息）。

它会创建 `config.json` / `auth.json`，并在 setup handoff 时显示 MCP URL、bind/connection 信息、Owner password 和 credential 文件位置。

常用高级项使用：

```bash
forgerelay init --advanced
```

高级初始化只处理一小组常用设置：

- port；
- Command Shell Runtime；
- ForgeRelay Runtime Shell Instructions（默认不启用，用户显式 opt-in）；
- ForgeRelay-managed Language Servers；
- 是否允许 Agent 按需安装 managed Language Server。

`forgerelay init --force` 只更新 setup-owned 字段。它不会把所有默认值快照进配置，不会删除无关高级配置，也**不会执行 legacy migration**。

## 显式迁移

ForgeRelay 启动时不会自动重写旧配置。v1.2 支持旧 ForgeRelay-owned 格式作为 compatibility adapter，并给出 deprecation diagnostics。

先 dry-run：

```bash
forgerelay config migrate --dry-run --global
forgerelay config migrate --dry-run --project /path/to/project
```

确认后再迁移：

```bash
forgerelay config migrate --global
forgerelay config migrate --project /path/to/project
```

Migration 会：

- 只处理 ForgeRelay 自己拥有的旧格式；
- 在修改前创建 backup；
- 使用原子写入/替换；
- 把 legacy source 规范化到 canonical domain；
- 保留迁移前后的 effective behavior，包括已有 canonical shadowing；
- 不移动 ForgeRelay-owned `~/.forgerelay/skills` 到 `.agents/skills`。

Migration **不会**读取或导入 Claude、Codex、Cursor 等其他产品的私有配置目录。`.agents/skills` 是开放 Agent Skills 生态来源，不是 ForgeRelay 私有配置的迁移目标。

Legacy 计划：

```text
v1.2.x  继续读取，带 deprecation warning
v1.3.x  继续兼容，但给出更强 removal warning
v1.4.0  移除这些 legacy parser/path
```

因此升级到 v1.2 不要求立即 migrate，但建议在 v1.4 前显式迁移并清理 warning。

## Legacy compatibility 对照

| Legacy source | Canonical v1.2 source |
| --- | --- |
| `config.json -> mcpServers` | `mcp.json` |
| `config.json -> languageServers` | `language-servers.json` |
| `config.json -> hooks` | `hooks/*.json` |
| `~/.forgerelay/hooks.json` / `<project>/.forgerelay/hooks.json` | `hooks/*.json` |
| `~/.forgerelay/agents/*.md` / `<project>/.forgerelay/agents/*.md` | `subagents/*.md` |

Legacy adapters 只负责把旧输入规范化进同一个 Config Resolver；它们不是另一套 precedence/reload 架构。

## External MCP

Canonical：

```text
~/.forgerelay/mcp.json
<project>/.forgerelay/mcp.json
<project-local>/mcp.json
```

Project / Project Local 可以覆盖 User 同名 Server，`disabled:true` 可以屏蔽低层 entry。配置 hot reload，并带 source-level LKG。

日常命令：

```bash
forgerelay mcp list
forgerelay mcp test <server>
forgerelay mcp auth <server>
forgerelay mcp logout <server>
```

`mcp list` / `doctor` 是被动检查；`mcp test` 才会主动连接 upstream。OAuth credential 保存在机器私有 `mcp-auth.json`。

详见 [External MCP](External-MCP)。

## Language Servers

Canonical：

```text
~/.forgerelay/language-servers.json
<project>/.forgerelay/language-servers.json
<project-local>/language-servers.json
```

Project Local > Project > User > built-in discovery。Canonical disable 使用：

```json
{
  "typescript": {
    "disabled": true
  }
}
```

旧 `config.json.languageServers` 和其中历史 `enabled:false` 仍在 compatibility window 内规范化；新配置不要继续写旧形状。

Language Server config hot reload。effective executable/config fingerprint 变化时，旧 Language Service generation 会退休，新请求使用新配置。

详见 [代码智能](Code-Intelligence)。

## Lifecycle Hooks

Canonical：

```text
~/.forgerelay/hooks/<hook-name>.json
<project>/.forgerelay/hooks/<hook-name>.json
<project-local>/hooks/<hook-name>.json
```

Canonical Hook 文件全部按需刷新；User Hook 不再要求为了普通配置修改而重启 Server。一个文件损坏时，该文件保留自己的 LKG，其他 Hook 文件继续正常解析。

检查：

```bash
forgerelay hooks list
forgerelay hooks check
forgerelay hooks list --project /path/to/project
forgerelay hooks check --project /path/to/project
```

详见 [生命周期 Hooks](Lifecycle-Hooks)。

## Subagent Profiles

Canonical：

```text
~/.forgerelay/subagents/*.md
<project>/.forgerelay/subagents/*.md
<project-local>/subagents/*.md
```

旧 `agents/*.md` 是 v1.2 compatibility source，不是新 profile 的推荐路径。Profile 目录同样使用按文件 hot reload / LKG。

启用 Subagent Session：

```bash
FORGERELAY_SUBAGENTS=1
```

`forgerelay agents ls` 主要查看 Session，不等于列出所有 profile definition。Host 的 compact profile catalog 使用 Config v2 profile resolver。

## Instructions 与 Agent Skills ownership

通用 `AGENTS.md` / Agent Skills 遵循 Agent 生态约定，不被伪装成 ForgeRelay Config domain。

全局 Agent Instructions 默认：

```text
~/.agents/AGENTS.md
```

Skill discovery 常见来源：

```text
<project>/.agents/skills
~/.agents/skills
~/.forgerelay/skills
FORGERELAY_AGENT_DIR/skills
FORGERELAY_SKILL_PATHS
```

这些来源不是同一个 ownership domain：

- `.agents/skills` 是开放 Agent Skills 生态，可以包含其他工具安装或软链接的 Skill；
- ForgeRelay 自己管理的 Skill 保留在 active config directory 的 `skills/`，默认 `~/.forgerelay/skills`；
- ForgeRelay 不把自己的 Skill 安装或迁移到 `~/.agents/skills`。

ForgeRelay Runtime Shell Instructions 是另一项 ForgeRelay-owned runtime resource，和通用 Agent Skill 不同；v1.2 fresh init 默认关闭，只有显式 opt-in 才启用。

## 常用环境变量

| Variable | 用途 |
| --- | --- |
| `HOST` | bind host，默认 `127.0.0.1` |
| `PORT` | bind port，默认 `7676` |
| `FORGERELAY_ALLOWED_ROOTS` | 可打开的 Project roots |
| `FORGERELAY_PUBLIC_BASE_URL` | 一个或多个 public base URL |
| `FORGERELAY_ALLOWED_HOSTS` | Host-header allowlist override |
| `FORGERELAY_OAUTH_OWNER_TOKEN` | Owner password |
| `FORGERELAY_STATE_DIR` | durable SQLite state directory |
| `FORGERELAY_WORKTREE_ROOT` | managed worktree directory |
| `FORGERELAY_ACTIVITY_PANEL_EXPANDED` | Activity Panel 默认展开状态 |
| `FORGERELAY_TASK_REMINDER_INTERVAL` | Workspace Task reminder interval |
| `FORGERELAY_SUBAGENTS` | Subagent Session 开关 |
| `FORGERELAY_ARTIFACTS` | native Artifact capability 开关 |

环境变量属于 runtime scope，通常高于持久文件。要解释某个具体值为什么生效，使用 `config explain`。

## Public Base URL

`publicBaseUrl` 写到最终 `/mcp` 之前。例如：

```text
https://forge.example.com/forgerelay/main
```

Host 连接：

```text
https://forge.example.com/forgerelay/main/mcp
```

可以配置多个 public base URL；第一个是 canonical URL，各自 pathname 都是独立 route boundary。

完整网络/OAuth 初始化见 [快速开始](Getting-Started)。
