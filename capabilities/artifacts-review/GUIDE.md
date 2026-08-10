# ForgeRelay Artifacts and Change Review

当任务需要把 MCP Host 提供的原生文件保存进 workspace，或需要使用 ForgeRelay 的聚合 change-review UI 时读取本指南。

## Native artifact transfer

Native artifact download 默认关闭，且当前安全发布实现主要面向 Linux。只有 `open_workspace` 的 Capability catalog 广告 `artifact.download` 时才执行它；不熟悉 contract 时先 `capability(action="describe")`，其中会明确 native file 通过 Gateway 顶层 `file` transport slot 传入。

典型流程：

1. 先用 `open_workspace` 打开目标项目；
2. 调用 `capability`，`name="artifact.download"`、`action="run"`，把 Host 原样提供的 native `file` 值放在 Gateway 顶层 `file`，并在 `arguments.path` 传 workspace-relative 目标路径；
3. 成功后使用返回的 normalized relative path 配合普通 `read` / `rename` / `delete` / shell 等工具继续处理。

0.3.3 仍保留 `download_artifact` 作为迁移期 compatibility alias，但新的 Agent workflow 不应把它视为长期 public surface。

`artifact.download` 会创建缺失的父目录，但拒绝覆盖已有目标。不要把 native file 值改造成：

- 任意 URL 字符串；
- 猜测的本地主机路径；
- base64 内容；
- 含凭据的扩展对象。

不要把 signed URL、native connector object、base64 或凭据复制进 shell command 或日志。需要显式替换、移动、重命名或删除时，等文件安全落到 workspace 后再用普通 workspace primitives。

默认单文件上限为 100 MiB，可通过 `FORGERELAY_ARTIFACT_MAX_FILE_BYTES` 调整。ForgeRelay 先流式写入私有 partial，再校验并无覆盖发布；它不是任意 URL downloader，也没有 TTL/pinning/background cleanup 语义。

## Change review modes

`FORGERELAY_WIDGETS`：

- `full`：默认，为常用 workspace/file/edit/shell tools 附加 MCP App UI；
- `changes`：聚焦 `open_workspace` + `review.changes` 聚合 review；
- `off`：不附加 widget UI。

Plain MCP Host 可以忽略这些 UI metadata；不要把 UI 是否显示当成文件操作是否成功的判据。

当 Capability catalog 广告 `review.changes` 时，本轮成功修改文件后，在最后一个相关 file mutation 之后、final response 之前通过 `capability` 调用一次，让用户看到聚合 diff；不要每改一个文件就调用一次。0.3.3 仍保留 `show_changes` compatibility alias，但它和 `review.changes` 共用同一套 checkpoint，不是两套 review 状态。

`review.changes` 使用 Git-backed review checkpoint。它按 workspace 跟踪 open/baseline 状态，展示自上次 review checkpoint 以来的 coherent diff，并在成功 review 后推进 baseline。当前版本要求可用的 Git workspace；checkpoint 缺失或 root 不匹配时会明确失败或使用受控 fallback，而不是凭空重建历史。

## Capability ownership

Artifact transfer 和 change review 都属于 ForgeRelay registered capability，而不是 Agent 自己的文件搬运协议。`tools/list` 只负责暴露稳定 Gateway 与当前兼容 aliases；真正可用的低频能力以当前 workspace 的 Capability catalog 为准。本指南提供流程和边界，不额外创造隐藏执行入口。
