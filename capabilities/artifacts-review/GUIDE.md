# ForgeRelay Artifacts and Change Review

当任务需要把 MCP Host 提供的原生文件保存进 workspace，或需要使用 ForgeRelay 的聚合 change-review UI 时读取本指南。

## Native artifact transfer

Native artifact download 默认关闭。只有 `tools/list` 实际暴露 `download_artifact` 时才调用它；当前安全发布实现主要面向 Linux。

典型流程：

1. 先用 `open_workspace` 打开目标项目；
2. 调用 `download_artifact`，传入 Host 原样提供的 native `file` 值、现有 `workspaceId` 和 workspace-relative `path`；
3. 成功后使用返回的 normalized relative path 配合普通 `read` / `rename` / `delete` / shell 等工具继续处理。

`download_artifact` 会创建缺失的父目录，但拒绝覆盖已有目标。不要把 native file 值改造成：

- 任意 URL 字符串；
- 猜测的本地主机路径；
- base64 内容；
- 含凭据的扩展对象。

不要把 signed URL、native connector object、base64 或凭据复制进 shell command 或日志。需要显式替换、移动、重命名或删除时，等文件安全落到 workspace 后再用普通 workspace primitives。

默认单文件上限为 100 MiB，可通过 `FORGERELAY_ARTIFACT_MAX_FILE_BYTES` 调整。ForgeRelay 先流式写入私有 partial，再校验并无覆盖发布；它不是任意 URL downloader，也没有 TTL/pinning/background cleanup 语义。

## Change review modes

`FORGERELAY_WIDGETS`：

- `full`：默认，为常用 workspace/file/edit/shell tools 附加 MCP App UI；
- `changes`：聚焦 `open_workspace` + `show_changes` 聚合 review；
- `off`：不附加 widget UI。

Plain MCP Host 可以忽略这些 UI metadata；不要把 UI 是否显示当成文件操作是否成功的判据。

当 `tools/list` 暴露 `show_changes` 时，它自己的 tool description 是调用契约：本轮成功修改文件后，在最后一个相关 file mutation 之后、final response 之前调用一次，让用户看到聚合 diff；不要每改一个文件就调用一次。

`show_changes` 使用 Git-backed review checkpoint。它按 workspace 跟踪 open/baseline 状态，展示自上次 review checkpoint 以来的 coherent diff，并在成功 review 后推进 baseline。当前版本要求可用的 Git workspace；checkpoint 缺失或 root 不匹配时会明确失败或使用受控 fallback，而不是凭空重建历史。

## Capability ownership

Artifact transfer 和 change review 都属于 ForgeRelay capability，而不是 Agent 自己的文件搬运协议。真实可调用工具仍以 `tools/list` 为准；本指南只提供低频流程和边界，不代表隐藏工具。
