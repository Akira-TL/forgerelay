# 远端与复合工作区

ForgeRelay 可以把实际执行放到另一台机器，也可以让一个 Host 同时协调多个独立 Workspace。这两个功能经常一起用，但解决的问题不同。

Workspace Relay 决定“这个 Workspace 在哪台 ForgeRelay 上执行”。Composite Workspace 解决“一个 Host 怎么同时使用多个 Workspace”。

## Gateway、Execution 和 alias

Gateway ForgeRelay 是直接连接 ChatGPT / MCP Host 的实例。Host 看到的 Workspace handle 由它返回。

Execution ForgeRelay 才真正拥有远端文件、Git、进程、Hooks、Skills、Language Service 和 Activity 状态。

Gateway 用 Forge alias 记住远端实例，例如：

```text
workstation
compute
gpu-server
```

Agent 以后只需要引用 alias，不需要看到网络地址、SSH topology 或 credential。

## 认证远端 ForgeRelay

远端认证通过 CLI 完成，和 Host 使用的网页 OAuth 流程分开。

Gateway 能直接访问远端服务时：

```bash
forgerelay auth 10.11.12.13:7676 --alias workstation
```

交互式终端会隐藏 Owner token 输入。也可以显式传入：

```bash
forgerelay auth 10.11.12.13:7676 --alias workstation --token '<owner-token>'
```

不要把 token 放进脚本、Shell history 或日志。

认证成功后会直接创建或更新本机远端记录，不需要额外的 add-remote 步骤。

## 通过 SSH route 访问

如果 ForgeRelay 服务只能从最终 SSH 主机访问，可以用 `-J`：

```bash
forgerelay auth -J user@jump,user@target 127.0.0.1:7676 --alias compute --ssh-auth
```

最后一个节点是最终 SSH target，前面的节点按 ProxyJump 顺序使用。这里的 `127.0.0.1:7676` 是从最终 SSH target 的视角解释的。

ForgeRelay 调用系统 SSH 建立临时端口转发，把远端服务映射到本机随机 loopback 端口，再走和直连相同的认证 / MCP 路径。

它不会先直连，失败后自动猜测要不要切 SSH。是否走 SSH 由参数明确决定。

### `--ssh-auth`

已经有 SSH 登录权限时，`--ssh-auth` 可以在最终目标机读取该机 Owner token，并通过 SSH stdout 只返回给这一次认证流程。

这个 token 不应写入远端记录、命令参数、日志或 Activity audit。

`--ssh-auth` 必须和 `-J` 一起使用，并且不能和 `--token` 同时传。

## 管理远端记录

```bash
forgerelay auth list
forgerelay auth test workstation
forgerelay auth rename workstation build-server
forgerelay auth remove build-server
```

`list` 和其他管理命令不会打印已保存的 credential。`test` 会检查远端 MCP 连接，并在需要时刷新访问凭据。

## 打开 Relay Workspace

有 alias 后，普通 `open_workspace` 就可以指定远端执行位置：

```text
open_workspace(
  path="/srv/project",
  relay="workstation"
)
```

这里的 `path` 是 Execution ForgeRelay 所在机器上的路径，不是 Gateway 本机路径。

Host 继续使用 Gateway 返回的 Workspace handle，但文件、Git、Shell、Hooks、Skills、Language Service 和 Activity 状态都属于远端 Execution ForgeRelay。

Workspace Relay 不是文件同步。Gateway 不会维护远端项目的本地镜像。

## Composite Workspace

一个任务需要同时使用多个执行环境时，可以创建 Composite Workspace：

```text
open_workspace(kind="composite", name="research-project")
```

Composite 本身没有 filesystem root。它可以先为空，再加入 member。

加入已有 Workspace：

```text
open_workspace(
  action="member",
  workspaceId="cws_...",
  memberAction="add",
  member={
    name: "code",
    purpose: "源码开发",
    workspaceId: "ws_..."
  }
)
```

也可以直接定义 path-backed / Relay member：

```text
open_workspace(
  action="member",
  workspaceId="cws_...",
  memberAction="add",
  member={
    name: "compute",
    purpose: "GPU 与高性能计算",
    path: "/srv/research",
    relay: "gpu-server"
  }
)
```

Member 也可以使用 managed worktree mode，隔离和 finalize 仍由这个 member 自己的 Workspace lifecycle 负责。

## 每次操作都写明 member

```text
read(
  workspaceId="cws_...",
  member="code",
  path="src/model.py"
)
```

```text
bash(
  workspaceId="cws_...",
  member="compute",
  command="python train.py"
)
```

`purpose` 只是给 Host / Agent 的说明，不参与自动路由。

如果某个 member 离线、执行失败，或者某个工具“看起来更适合 GPU”，ForgeRelay 都不会偷偷切到另一个 member 或本机执行。目标执行位置必须一直可解释。

## Composite 不合并底层状态

每个 member 继续拥有自己的 filesystem、Git state、process、Hooks、Skills、Language Service 和 Activity / Audit facts。

Activity Panel 可以把当前 Host Turn 的 member operations 放到一起展示，但事实仍归底层 Workspace 所有。

## 加载某个 member 的完整上下文

需要重新加载某个 member 的 AGENTS、Skills、Capability guides 等 bootstrap 时，可以：

```text
open_workspace(
  workspaceId="cws_...",
  memberName="compute",
  context="full"
)
```

这只加载该 member 的上下文，不会建立隐式“当前 member”。后续 Core tool 仍然必须写 `member=`。

## Close 和 Delete

Close 只把 Composite identity 置为 `closed`，保留名称、member topology 和 Composite-owned durable state。它不会关闭 member Workspace、finalize member worktree、停止 member process、删除 Forge alias 或修改 member 文件。

Delete 才会 dissolve Composite 自己的 identity 和 member relationships，但仍不会顺带关闭或删除 member Workspace。

## 几个容易混淆的概念

| 概念 | 作用 | 不做什么 |
| --- | --- | --- |
| Remote Authentication | 建立 Gateway 到 Execution ForgeRelay 的可信访问 | 不选择项目 Workspace |
| SSH route | 定义到远端服务的网络路径 | 不代表 Composite member |
| Forge alias | 给已认证远端实例命名 | 不定义权限角色 |
| Workspace Relay | 把一个 Workspace 的执行交给远端 | 不同步文件 |
| Composite Workspace | 在一个 Host context 中协调多个 Workspace | 不合并底层执行状态 |

一个常见拓扑：

```text
ChatGPT
   │
   ▼
Gateway ForgeRelay (laptop)
   │
   ├── code ──► local checkout
   │
   └── compute ── Workspace Relay ──► GPU server ForgeRelay
```

更多架构边界见主仓库 [ADR-0007](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0007-separate-host-and-cli-auth.md)、[ADR-0008](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0008-composite-workspace-lifecycle.md) 和 [ADR-0009](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0009-persistent-workspace-identity-and-state.md)。
