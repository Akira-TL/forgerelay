# 远端与复合工作区

ForgeRelay 可以把真实执行放到另一台 ForgeRelay 实例上，也可以把多个彼此独立的 Workspace 组合成一个 Host-facing 工作上下文。两者解决的是不同问题：

- **Workspace Relay**：决定一次 Workspace 实际在哪里执行；
- **Composite Workspace**：让一个 Host 同时协调多个独立 Workspace。

## 三个角色

### Gateway ForgeRelay

直接连接 ChatGPT / MCP Host 的 ForgeRelay。Host 看到的 Workspace handle 由它提供。

### Execution ForgeRelay

真正拥有远端文件系统、Git、进程、Hook、Skill、语言服务和 Activity 事实的 ForgeRelay。

### Forge alias

Gateway 本地保存的远端实例名称，例如：

```text
workstation
compute
gpu-server
```

后续 Workspace Relay 只通过 alias 选择远端，不需要把网络地址、SSH topology 或 credential 暴露给 Agent。

## 先认证远端 ForgeRelay

远端认证通过 CLI 完成，与 ChatGPT 使用的网页 OAuth 流程分离。

### 直接访问

如果 Gateway 可以直接访问远端服务：

```bash
forgerelay auth 10.11.12.13:7676 --alias workstation
```

交互终端会隐藏输入 Owner token。也可以显式传入：

```bash
forgerelay auth 10.11.12.13:7676 --alias workstation --token '<owner-token>'
```

不要把 token 写进脚本、Shell history 或日志。

认证成功会同时建立/更新本机远端实例记录，不需要另一个“add remote”步骤。

## 通过 SSH route 访问

如果远端 ForgeRelay 只从最终 SSH 主机可访问，使用 `-J`：

```bash
forgerelay auth -J user@jump,user@target 127.0.0.1:7676 --alias compute --ssh-auth
```

`-J` 表示完整 SSH route：最后一个节点是最终 SSH target，前面的节点按 ProxyJump 顺序使用。

此时远端 service target 是从**最终 SSH target 的视角**解释的。ForgeRelay 使用系统 SSH 做端口转发，把目标服务临时映射到本机随机 loopback 端口，然后继续走和直接访问相同的认证/MCP 路径。

ForgeRelay 不会先尝试直连、失败后自动切到 SSH。是否使用 SSH 由参数明确决定。

### `--ssh-auth`

当你已经拥有 SSH 登录权限时，`--ssh-auth` 可以让最终目标机上的 ForgeRelay 固定子命令读取该机 Owner token，并只通过 SSH stdout 返回给发起进程，用于这一次认证交换。

这个 Owner token 不应被写入远端记录、命令参数、日志或 Activity audit。

`--ssh-auth`：

- 必须与 `-J` 一起使用；
- 与 `--token` 互斥。

## 管理已认证远端

```bash
forgerelay auth list
forgerelay auth test workstation
forgerelay auth rename workstation build-server
forgerelay auth remove build-server
```

`list` 和管理命令不应该打印已保存 credential。

`test` 会验证远端 MCP 连接，并在需要时刷新访问凭据。

## 打开 Relay Workspace

认证得到 alias 后，Agent 可以通过普通 `open_workspace` 生命周期选择这个 Execution ForgeRelay：

```text
open_workspace(
  path="/srv/project",
  relay="workstation"
)
```

这里的 `path` 是 **Execution ForgeRelay 所在机器上的 Workspace path**，不是 Gateway 本机路径。

Host 仍然使用 Gateway 返回的 Workspace handle，但文件、Git、Shell、Hook、Skill、语言服务和 Activity 事实实际属于远端 Execution ForgeRelay。

Workspace Relay 不等于文件同步。Gateway 不维护远端项目的本地镜像。

## Composite Workspace

当一个任务需要同时使用多个独立执行环境时，可以创建 Composite Workspace：

```text
open_workspace(kind="composite", name="research-project")
```

Composite 本身没有 filesystem root，可以先是空的，再逐个加入 member。

### 加入已有 Workspace

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

### 直接定义 path-backed / Relay member

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

Member 也可以使用 managed worktree mode，由其实际 Workspace 生命周期负责隔离和 finalize。

## 每次执行都显式选择 member

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

`purpose` 只是给 Host/Agent 的语义说明，不产生自动路由。

ForgeRelay 不会因为：

- 某个工具“看起来更适合 GPU”；
- member 离线；
- 某个 member 执行失败；
- purpose 中写了 `code` / `compute`；

就自动切换到另一个 member 或本机执行。

这保证执行位置始终可解释。

## Member 的状态不会被合并

Composite 不会把这些内容合并成一个共享环境：

- filesystem；
- Git state；
- process；
- Lifecycle Hook；
- Agent Skill；
- Language service；
- Activity audit facts。

Composite Activity Panel 可以把当前 Host Turn 的 member operations 聚合展示，但真实事实仍归底层 Workspace 所有。

## 加载某个 member 的完整项目上下文

Composite 本身可以拥有自己的 bootstrap。需要某个 member 的 AGENTS、Skill、Capability guide 等较重上下文时，可以在 reopen Composite 时显式指定 member：

```text
open_workspace(
  workspaceId="cws_...",
  memberName="compute",
  context="full"
)
```

这只是加载该 member 的上下文，不会建立隐式“当前 member”。后续 Core tool 仍然要写明 `member=`。

## Composite close 与 delete

### Close

关闭 Composite 只把 Composite identity 置为 closed，并保留 name、member topology 和 Composite-owned state。

它不会：

- close member Workspace；
- finalize member worktree；
- stop member process；
- 删除远端 Forge alias；
- 修改 member 文件。

### Delete

显式 delete 才 dissolve Composite-owned identity 和 member relationships，但仍然不会顺带删除或关闭 member Workspace。

## 设计上的重要区别

| 概念 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Remote Authentication | 建立 Gateway 到 Execution ForgeRelay 的可信访问 | 不选择项目 Workspace |
| SSH route | 到达远端服务的网络路径 | 不代表 ForgeRelay member |
| Forge alias | 命名已认证远端实例 | 不等于设备权限角色 |
| Workspace Relay | 把一个 Workspace 的实际执行委托给远端 | 不同步文件 |
| Composite Workspace | 在一个 Host-facing context 中协调多个 Workspace | 不合并底层执行事实 |

## 推荐拓扑

一个常见的多设备开发拓扑：

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

Host 只需要维护一个 Composite Workspace，但每次文件或进程操作都清楚标明目标 member。

更多架构边界见主仓库 [ADR-0007](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0007-separate-host-and-cli-auth.md)、[ADR-0008](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0008-composite-workspace-lifecycle.md) 和 [ADR-0009](https://github.com/Akira-TL/forgerelay/blob/main/docs/adr/0009-persistent-workspace-identity-and-state.md)。
