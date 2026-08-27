# Workspace 与 Activity 使用一个 ForgeRelay Panel

## 状态

接受。替代 ADR 0005《ChatGPT Web 中 Workspace 生命周期与 Activity 使用两个独立 MCP App》。

## 决策

ForgeRelay 对新的项目工作只暴露一个 Host-rendered MCP App：**ForgeRelay Panel**。Panel 与一个 `workspaceId` 绑定；Host 为不同 `workspaceId` 调用 `activity_panel` 时得到不同卡片。同一卡片内，**Workspace Summary** 固定显示在上方，不提供整体折叠；只有当前 Host Turn 已产生 Activity 时才显示下方的 **Activity Panel**，显示后继续保留独立的默认折叠、实时刷新、详情展开和 Bash 输出查看行为。空 Host Turn 不渲染 Activity 标题、计数、状态标记或折叠控件。

`open_workspace` 负责解析或创建 Workspace 并返回 `workspaceId` 与项目上下文，但不单独创建 UI。`activity_panel(workspaceId)` 是新项目工作唯一的 render tool，同时取得该 Workspace 的展示数据并建立当前 Host Turn。Workspace presentation 以标准 tool-result `_meta` 保留，同时镜像到 `structuredContent` 供 View 直接渲染，避免 Host 对 tool-result metadata 透传差异导致 Workspace Summary 退化为等待壳。持久化的当前 Host Turn 以 Host conversation scope + `workspaceId` 查找。scope 优先使用 Host 提供的会话标识（例如 `openai/session`）；缺失时依次退回 MCP transport session 与当前 MCP connection scope。这样 Inspector、STDIO/普通 MCP Host 在没有 OpenAI metadata 时，后续工作工具仍能归属到刚创建的 Panel，同时不会把不同 Workspace 的 Activity 混在一起。App-only Activity 查询继续负责动态 Activity 数据。旧 Workspace Lifecycle resource 只作为历史卡片读取兼容入口，不再作为新的可见 UI surface 广告。

## 原因

两个独立 App 把一个用户概念拆成了两个 Host iframe 生命周期。为了维持这种拆分，ForgeRelay 需要额外处理独立 resource identity、render tool、Host result 时序、bootstrap、缓存 revision 与跨 App 状态恢复，但这些复杂度并没有对应到用户需要的两个独立交互对象。Workspace 信息本质上是当前工作卡片的稳定上下文，Activity 才是随 Host Turn 变化的动态部分。

统一 Panel 后，Workspace identity 成为卡片边界：Workspace 不变时动态 Activity 在原卡片内更新；Workspace identity 改变时创建新卡片。这样把生命周期边界放回 ForgeRelay 可以明确表达的 `workspaceId`，而不是依赖 Host 是否复用某个 iframe DOM 实例。

## 兼容与验收

历史 Workspace Lifecycle URI 可以继续被读取，但不代表当前产品存在第二个 App。协议与资源链路可在本地 MCP Apps Host 中快速验收；ChatGPT Web 仍用于最终验证 ChatGPT 特有的 iframe 生命周期、缓存与通知行为。
