# 语言服务初始化失败导致主进程退出

## 事故证据

北京时间 2026-11-06 00:29:59，`1.3.6-beta.1` 在文件写入成功后进入自动诊断，随后报告 Pyright 初始化期间收到 `SIGTERM`，Node.js 退出。

本次持久日志记录的顺序为：初始化启动 → 请求参数检查同步抛错 → `cleanupFailedStart()` 发送 `SIGTERM` → 语言服务退出 → 初始化退出监听器产生未处理的 Promise 拒绝 → 主进程以状态码 1 退出。因此，本次信号由 ForgeRelay 的初始化失败清理发送，最初失败发生在协议请求发送之前。

## 根因

实际全局安装解析到 `vscode-jsonrpc 9.0.3` 和 `vscode-languageserver-protocol 3.18.5`；后者自身安装 `vscode-jsonrpc 10.0.0`。ForgeRelay 从直接依赖创建连接，从协议包取得请求类型，两份通信库的 `ParameterStructures.byName` 对象身份不同，参数检查因此同步抛出 `Unknown parameter structure byName`。

初始化中的 `sendRequest()` 原本位于 `try/finally` 之外。同步抛错绕过了移除子进程退出监听器的 `finally`。外层捕获错误并关闭子进程后，遗留监听器拒绝了一个尚未被 `Promise.race()` 接管的 Promise，导致 Node.js 按未处理拒绝退出。

源码锁文件使用同一份 `vscode-jsonrpc 9.0.1`，此前源码及基于锁文件安装的打包测试没有覆盖实际全局安装的重复依赖。稳定性压力测试通过不能替代不同安装依赖树的验证。

## 修复和验证

1. 将初始化 `sendRequest()` 纳入现有 `try/finally`，确保同步抛错也会移除退出监听器；初始化失败仍沿原有工具诊断警告路径返回。
2. 通过 `vscode-languageserver-protocol/node` 创建连接，取消令牌和连接类型也统一从协议包导出，移除 ForgeRelay 对 `vscode-jsonrpc` 的直接依赖。
3. 回归测试启动独立子进程，通过真实 MCP 文件写入触发同步初始化失败，断言文件已保存、宿主存活、后续写入恢复。
4. 另一个回归测试加载真实第二份通信库，模拟 npm 重复安装。旧连接导入稳定失败，统一依赖来源后初始化及诊断成功。
5. 在仓库隔离副本中，让修复构建只读复用实际故障安装的依赖树，确认初始化、诊断及退出均成功；原安装包在同一脚本下复现原始崩溃。未修改正式安装或启停生产实例。

安装路径反馈命令为 `bash scripts/lsp/reproduce-installed-startup.sh [待测包目录]`；默认只读加载当前 Node 安装前缀下的全局 ForgeRelay 模块，测试配置及进程独立创建在仓库的 `.forgerelay-debug/`，不连接产品端口。结果写入 `logs/lsp-installed-startup.log`。

本次证据解释这次 beta 崩溃，尚不能证明更早版本的每次退出均具有相同依赖树。已发布的 `1.3.6-beta.1` 仍包含本次故障，不能将本地修复误认为该包已更新。
