# ChatGPT Web 中 Workspace 生命周期与 Activity 使用两个独立 MCP App

ForgeRelay 的产品 UI 以 ChatGPT Web plugin / Apps SDK Host 为验收目标，而不是以本地 MCP client 或本地插件运行时为目标。本地 client 可以验证 MCP schema、resource 和 tool result，但不能替代 ChatGPT Web 中真实 iframe 生命周期的验收。

ForgeRelay 保持两个独立的 MCP App 身份。`open_workspace` 与 `close_workspace` 共用 **Workspace Lifecycle App** resource，只展示 Workspace 打开、复用、关闭和 managed-worktree 收尾等生命周期结果；它不接管普通文件、Shell、Capability 或 Activity 展示。普通项目操作由单独的 **Activity Panel** resource 展示。`activity_panel` 是 Activity UI 的 render tool，`activity_snapshot`、`activity_detail`、`activity_output` 是 App-only 数据源；普通核心工具不为每次调用各自挂载同一个 widget iframe。

该拆分同时保持 OpenAI Apps SDK 的 data/render separation：工具通过标准 `_meta.ui.resourceUri` 关联 UI，新的实现不依赖 `window.openai` 时序补丁，也不要求 `openai/outputTemplate` 作为主路径。旧 `workspace-app` resource 继续作为历史聊天兼容资源提供，但新的 Workspace Lifecycle 与 Activity Panel 都使用各自独立、按 bundle revision 变化的 `ui://` URI。Host 是否复用同一个 DOM iframe 实例由 ChatGPT 决定；ForgeRelay 保证的是 open/close 共用同一 App/resource 身份，并与 Activity Panel 身份严格分离。
