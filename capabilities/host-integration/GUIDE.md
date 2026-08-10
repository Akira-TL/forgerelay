# ForgeRelay Host Integration

当任务涉及 MCP Host 连接、OAuth、public URL / tunnel、Host tool metadata 不同步，或 MCP App UI/template 排障时读取本指南。

## Public endpoint

ForgeRelay 本地监听一个 HTTP origin，MCP endpoint 是 `/mcp`。当 Host 无法直接访问 localhost 时，需要用户自己提供 public HTTPS tunnel/reverse proxy；ForgeRelay 不创建 tunnel。

持久化的 `publicBaseUrl` 必须是 origin，不要包含 `/mcp`：

```text
publicBaseUrl: https://forge.example.com
Host MCP URL:  https://forge.example.com/mcp
```

临时覆盖可使用 `FORGERELAY_PUBLIC_BASE_URL`。Host-header/403 问题先运行 `forgerelay doctor` 检查 resolved public URL 与 allowed hosts；`FORGERELAY_ALLOWED_HOSTS="*"` 只适合明确的本地调试。

当 ForgeRelay 绑定 loopback、但 `publicBaseUrl` 指向公网 tunnel/reverse proxy 时，ForgeRelay 会自动信任恰好 1 个上游代理 hop，让 Express 与 OAuth rate limiter 使用一致的客户端 IP。不要把 Express `trust proxy` 设为无条件 `true`；直接监听 `0.0.0.0` 等非 loopback 地址时也不会自动开启代理信任。可用 `FORGERELAY_TRUST_PROXY=0|1` 显式覆盖。

## OAuth owner flow

ForgeRelay 使用 single-user Owner-password OAuth approval flow。新安装的 owner secret 通常保存在 `~/.forgerelay/auth.json`；迁移安装可能继续使用旧 `.devspace` 配置目录。不要把 owner token、refresh token 或 `auth.json` 内容放进 Agent 输出、项目文件或日志。

Host 可通过这些 metadata endpoint 发现授权配置：

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

默认 redirect hosts 包含 `chatgpt.com`、`localhost`、`127.0.0.1`。其他 MCP client 需要显式加入 `FORGERELAY_OAUTH_ALLOWED_REDIRECT_HOSTS`。OAuth scope 默认仍使用 legacy-compatible internal identifier `devspace`，这是协议兼容值，不是产品名回退。

Owner password 不被接受时先用 `forgerelay doctor` 确认实际 auth/config 路径；只有用户明确要重建配置时才使用 `forgerelay init --force`。

## Stale Host metadata

`open_workspace` 每次都返回 ForgeRelay version/capability fingerprint；真实 callable surface 仍由当前 server 的 `tools/list` 决定。

如果 server fingerprint 明确报告某项已实现能力，而 Host 当前会话暴露的 tool snapshot 明显更旧，不要断言 ForgeRelay 缺少该能力。应判断为 Host MCP metadata stale，并建议重新连接/刷新 integration，或开启能重新加载 `tools/list` 的 Host context。ForgeRelay server 不能强制 Host 清掉缓存的 schema。

## MCP App / template debugging

当 ChatGPT 或其他支持 MCP App 的 Host 出现 `Failed to fetch template`、空卡片或资源加载失败时，先验证 server 侧链路：

```bash
npm run build
npm run debug:accept
```

ForgeRelay 正常会广告 content-hashed：

```text
ui://forgerelay/workspace-app-<hash>.html
```

`resources/read` 应返回 `text/html;profile=mcp-app`，并且 HTML 引用的 `/mcp-app-assets/` 资源必须可达。ForgeRelay 还保留 legacy `ui://forgerelay/workspace-app.html` 和历史 `workspace-app-*.html` 兼容指针，以容忍 Host 暂时持有旧 metadata snapshot。

需要 live trace 时，可用：

```bash
FORGERELAY_DEBUG_WIDGETS=full \
FORGERELAY_LOG_LEVEL=debug \
FORGERELAY_LOG_REQUESTS=1 \
FORGERELAY_LOG_ASSETS=1 \
forgerelay serve
```

排障时区分三类问题：Host 根本没有发 `resources/read`、template callback 失败、或 `/mcp-app-assets/` fetch 失败。不要把这三者混成同一个“UI坏了”。
