# External MCP

ForgeRelay 可以把你已经配置好的其他 MCP Server 通过现有 `mcp.external` Capability 暴露给 Agent。它不会为每个外部 Server 新增顶层 MCP tool，也不会把返回的路径或 URL 自动打开。

这页只讲日常配置、认证和排障路径。完整 schema 见主仓库 [Configuration Reference](https://github.com/Akira-TL/forgerelay/blob/main/docs/configuration.md#media-content-and-external-mcp)。

## 配置放在哪里

机器级配置：

```text
~/.forgerelay/mcp.json
```

项目级配置：

```text
<workspace>/.forgerelay/mcp.json
```

如果使用了 `FORGERELAY_CONFIG_DIR`，机器级 `mcp.json` 和 OAuth credential store 也跟随那个目录。

优先级按 server name 计算：

```text
Project mcp.json > global mcp.json > legacy config.json.mcpServers
```

旧的 `config.json.mcpServers` 仍兼容读取，但新配置应该写到独立 `mcp.json`。

## 最小配置

stdio MCP：

```json
{
  "servers": {
    "renderer": {
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/renderer/server.mjs"]
    }
  }
}
```

Streamable HTTP MCP：

```json
{
  "servers": {
    "remote": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

Server name 使用稳定的小写名称，例如 `github`、`renderer`、`my-mcp`。

## Project override 和 `disabled`

Project 可以覆盖机器级同名 Server。只想在某个 Project 屏蔽机器级 Server 时：

```json
{
  "servers": {
    "github": {
      "disabled": true
    }
  }
}
```

默认就是启用，不需要写 `disabled: false`。删掉 Project 里的这个 entry 后，下层 global/legacy 配置会重新生效。

## 热加载

修改 `mcp.json` 后不需要重启 ForgeRelay。下一次 `mcp.external` 操作会读取新的有效配置。

如果一个已经成功加载过的 `mcp.json` 被临时写坏，正在运行的 ForgeRelay 会继续使用该文件上一次完整合法的版本，而不是只加载其中一部分。修好 JSON 后，后续操作自动切到新版本。

查看当前解析结果：

```bash
forgerelay mcp list
```

在项目子目录执行时，CLI 会向上寻找最近的 `.forgerelay/mcp.json`。也可以明确指定：

```bash
forgerelay mcp list --project /path/to/project
forgerelay mcp list --global
```

`--global` 不加载 Project 配置。

## 认证方式

External MCP 不要求统一使用 OAuth。

| 情况 | 怎么做 |
| --- | --- |
| 无认证 | 直接配置 Server |
| HTTP 静态 token/header | 写到 `headers`，由用户自己维护 |
| stdio secret/env | 写到 `env`，由用户自己维护 |
| OAuth | 人工执行 `forgerelay mcp auth <server>` |

静态 secret 如果写进 Project `mcp.json`，就是项目文件的一部分。不要把真实 token 提交到 Git。

## OAuth

先确认 Server 和作用域：

```bash
forgerelay mcp list
```

然后人工授权：

```bash
forgerelay mcp auth github
```

也可以明确作用域：

```bash
forgerelay mcp auth github --project /path/to/project
forgerelay mcp auth github --global
```

桌面环境下，CLI 会打印授权地址并尝试打开浏览器，然后在临时 localhost callback 上等待返回。

SSH / headless 环境下，CLI 会打印授权地址。浏览器完成授权后，把最终 callback URL 粘回终端；输入只显示 `*`，不会明文回显 authorization code。

OAuth credential 保存在机器私有文件：

```text
~/.forgerelay/mcp-auth.json
```

Project Server 的 credential 也保存在这里，但 identity 包含 Project root。把同一份 `mcp.json` 复制到另一个 Project，不会自动复用 OAuth token。

运行中的 ForgeRelay 不负责打开浏览器，也不需要重启等待认证。CLI 成功写入 credential 后，下一次 External MCP 调用会直接读取它。正常 refresh 可以自动完成；需要新 consent、scope 或重新登录时，ForgeRelay 会要求你再次运行 `mcp auth`。

退出：

```bash
forgerelay mcp logout github
```

本地 credential 会删除。远端 token revocation 如果不支持或失败，CLI 会单独说明，但不会因此把本地 credential 留下来。

### CIMD-only OAuth Server

普通兼容 Server 不需要额外配置。若 OAuth Server 只接受 Client ID Metadata Document，可以提供自己的稳定公网 HTTPS metadata URL 和它声明的固定 localhost callback port：

```json
{
  "servers": {
    "modern": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientMetadataUrl": "https://client.example.com/forgerelay.json",
        "callbackPort": 49152
      }
    }
  }
}
```

ForgeRelay 当前不提供托管 CIMD 公网服务，因此这是高级 operator 配置，不是普通用户必须配置的字段。

## 测试连接

主动连接并执行 `tools/list`：

```bash
forgerelay mcp test github
```

它会报告 source、transport、auth 状态、实际协商的 MCP protocol、tool 数量，以及认证、网络或 tool discovery 的具体失败类型。

`forgerelay doctor` 不做这种主动测试。它只读取配置和 credential metadata，因此不会启动配置中的 stdio MCP，也不会向 HTTP MCP 发请求。

## MCP 协议兼容

ForgeRelay 可以连接现代 MCP 2026-07-28 Server，并继续兼容已支持的旧 MCP Server。协议选择由 External MCP client 自动协商，不需要为新旧 Server 分开写配置。

Host-facing ForgeRelay 同样保留 legacy sessionful MCP，并支持 modern stateless MCP。

## Relay Workspace

对于 Relay Workspace，External MCP 的配置、credential、stdio process、OAuth refresh 和实际 upstream 调用都属于 **Execution ForgeRelay**。

Gateway ForgeRelay 不会替你复制 External MCP credential。远端 Workspace 需要 OAuth 时，应在拥有实际执行环境的那台 ForgeRelay 上执行对应的 `forgerelay mcp auth`。

## 安全边界

Project `.forgerelay/mcp.json` 可以定义 stdio command，因此它和 Project Hook 一样属于可执行项目配置。允许并打开一个 Project root 后，不会再为每个 stdio Server弹第二次信任确认。

External MCP 返回的 path、URL、`resource_link` 等仍只是引用。ForgeRelay 不会因为它看起来像图片或文件就自动下载、`read` 或创建 Artifact。

如果确实需要对某个 Server/tool 的 request 或 result 做显式转换，可以使用 `ExternalMcpBeforeForward` / `ExternalMcpAfterForward` Transform Hook。详见 [生命周期 Hooks](Lifecycle-Hooks)。
