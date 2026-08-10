# ForgeRelay Shell and Processes

当命令长时间运行、需要交互式 TTY、需要继续操作已有 `processId`，或遇到 shell/process 平台边界问题时读取本指南。

## Core process model

常规 tool mode 使用一个 `bash` 入口管理命令和后续 process lifecycle；Codex tool mode 仍可使用其兼容 command adapter。命令拥有本地用户权限；workspace path containment 不等于 OS sandbox。

普通 `bash` 最多在前台等待 300 秒。如果进程仍存活，ForgeRelay 不会因为 wait window 到期而杀掉它，而是返回：

```text
running: true
processId: <number>
```

`processId` 是 canonical process handle。旧 `sessionId` 仅为 0.2.x compatibility alias，不应作为新代码或新 Agent workflow 的首选名称。

## `bash(action="process")`

普通命令使用 `bash(action="run")`，其中 `action` 可省略；如果返回 `running: true` 和 `processId`，后续仍通过同一个 `bash` tool 操作该 process：

- 只传 `workspaceId`、`action="process"`、`processId`：poll / wait；
- `input`：向正在运行的进程写入字符；
- `interrupt: true`：显式发送 SIGINT / Ctrl-C；
- `yieldTimeMs`：继续等待，单次最多 300000 ms；
- `maxOutputTokens`：限制本次返回的近似输出 token；
- `columns` / `rows`：调整已经分配 PTY 的终端尺寸。

`action="run"` 与 `action="process"` 的参数不要混用。Process ownership 始终绑定原 `workspaceId`；未知或跨 workspace 的 `processId` 会被拒绝。

等待超时不会隐式 kill process。若没有必要立即等待，可以继续其他工作；进程完成后，ForgeRelay 会把 completion notice 一次性附加到同一 logical workspace 的后续 tool result。

不要因为暂时没有输出就重复启动相同长进程；先用返回的 `processId` poll。

## PTY / interactive commands

默认命令不需要 PTY。只有交互程序确实依赖 terminal semantics 时才设置 `tty: true`。Codex-shaped `exec_command` 可以同时指定：

```text
tty: true
columns: 80
rows: 24
```

PTY 依赖 optional `node-pty`。缺少该依赖时 ForgeRelay 会明确报错；不要把它误诊成命令本身失败。对非 PTY process 使用 `columns` / `rows` resize 也会失败。

对需要 prompt/REPL 的程序，用 `bash(action="run", tty=true)` 启动，再通过 `bash(action="process", processId=...)` 输入或 resize；对 tests/builds/formatters 等非交互命令保持默认非 PTY，以获得更稳定的 CI-style 输出。

## Platform notes

ForgeRelay shell runtime 需要 Bash。Windows 上原生 PowerShell 和 `cmd.exe` 当前不是该 runtime 的执行 shell；使用 Git Bash、WSL、MSYS2 或 Cygwin Bash，并用 `forgerelay doctor` 检查环境。

Shell 可以作为用户开发任务的一部分修改普通项目文件，但始终受 ForgeRelay core mutation/safety contract 约束。涉及 privileged OS files、credentials、configuration 或外部硬件持久写入时，不要用本指南替代 core authorization/safety 规则。
