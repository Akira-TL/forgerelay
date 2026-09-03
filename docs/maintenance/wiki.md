# GitHub Wiki 维护

ForgeRelay 的 GitHub Wiki 使用仓库内 `docs/wiki/` 作为唯一编辑源。GitHub Wiki 仓库只是发布镜像，不单独维护第二套文档。

## 为什么保留源文件在主仓库

这样 Wiki 修改可以和代码一样经过：

- Git diff 与 review；
- 原子提交；
- 分支 / worktree 隔离；
- 版本化技术事实核对；
- 自动链接检查。

GitHub Wiki 的浏览体验仍然保留，但网页上直接编辑的内容会在下一次同步时被 `docs/wiki/` 覆盖。

## 目录约定

```text
docs/wiki/
├── Home.md
├── _Sidebar.md
└── <Page>.md
```

当前同步器只接受 Wiki 根目录中的 Markdown 页面。不要在 GitHub Wiki 仓库中单独保存未进入 `docs/wiki/` 的页面或附件。

Wiki 面向用户提供路径式使用说明；精确 schema、架构决策、release 规范和 Agent 内部资料继续保留在主仓库现有文档中，不复制成第二套 authoritative reference。

## 本地检查

```bash
npm run wiki:check
```

检查包括：

- `docs/wiki/` 是否存在；
- `Home.md` 与 `_Sidebar.md` 是否存在；
- 页面文件名是否适合 GitHub Wiki；
- Wiki 内部页面链接是否能解析到现有 Markdown 页面。

仓库外的 HTTP(S) 链接不在这个检查中联网验证。

## 一次性初始化 GitHub Wiki

GitHub 只有在网页上创建第一张 Wiki 页面后，才会建立可 clone 的 `<repository>.wiki.git` 仓库。

仓库 Wiki 功能已经开启后，执行一次：

1. 打开 `https://github.com/Akira-TL/forgerelay/wiki`；
2. 创建并保存任意初始页面（可以只是临时 Home）；
3. 回到主仓库运行 Wiki workflow，或本地运行 `npm run wiki:publish`。

第一次发布会用 `docs/wiki/` 完整镜像替换这张临时页面。 Source 可以按主题放进子目录，但所有 Markdown basename 必须唯一，因为 GitHub Wiki 发布面保持扁平。

如果 Wiki 尚未初始化，发布脚本返回专用状态码 `2`；GitHub Actions 会把它显示为 bootstrap notice，而不是把主分支标记成失败。

## 本地发布

```bash
npm run wiki:publish
```

默认 Wiki remote：

```text
git@github.com:Akira-TL/forgerelay.wiki.git
```

因此本地发布复用开发者现有 Git SSH 认证，不在脚本中保存 token。

需要测试其他 remote 时：

```bash
FORGERELAY_WIKI_REMOTE=/path/to/local/wiki.git npm run wiki:publish
```

只准备 mirror/commit、不 push：

```bash
FORGERELAY_WIKI_DRY_RUN=1 npm run wiki:publish
```

## 自动发布

`.github/workflows/wiki.yml` 在下面两种情况下运行：

- `main` 上与 Wiki source / publisher 有关的文件发生变化；
- 手动 `workflow_dispatch`。

Workflow 先执行 `wiki:check`，再把 `docs/wiki/` 镜像到同仓库 GitHub Wiki。自动化只使用当前 repository-scoped GitHub token，并且只授予 `contents: write`。

Wiki 未初始化时 workflow 只给出 bootstrap notice。完成一次网页初始化后，手动重跑 workflow 即可；以后主分支相关修改会自动同步。

## 镜像语义

发布不是增量复制，而是完整 mirror：

1. clone 当前 `.wiki.git`；
2. 保留 `.git`；
3. 删除其余 Wiki working tree 内容；
4. 递归读取 `docs/wiki/`，按页面 basename 扁平镜像到 GitHub Wiki 根目录；
5. `git add --all`；
6. 没有变化则直接结束；
7. 有变化则创建同步提交并 push 当前 Wiki 默认分支。

因此 GitHub 网页上的临时编辑、额外页面或未纳入主仓库的文件都会在下一次同步时被删除或覆盖。这是保持单一事实源的预期行为。

## 修改流程

普通 Wiki 修改建议：

1. 在主仓库修改 `docs/wiki/` 下对应的 Markdown source；子目录只用于仓库内组织，发布后的 Wiki 页面名仍取文件 basename；
2. 运行 `npm run wiki:check`；
3. 核对内容是否仍与当前已发布 ForgeRelay 行为一致；
4. 按项目 Git 规范提交；
5. 合入 `main` 后由 Wiki workflow 发布。

如果文档描述的是尚未发布的新行为，应在对应版本稳定后再把它写成当前用户行为，或者明确标注未来版本，避免 Wiki 超前于公开 release。

## Source of truth 边界

| 内容 | 主要位置 |
| --- | --- |
| 面向用户的使用路径、概念解释、排障导航 | `docs/wiki/` → GitHub Wiki |
| 完整配置与技术 reference | `docs/*.md` |
| Domain terminology | `CONTEXT.md` |
| Architecture decisions | `docs/adr/` |
| Agent / contributor 内部规则 | `AGENTS.md`, `docs/agents/` |
| 版本变化 | `CHANGELOG.md`, GitHub Releases |

不要把同一份完整 reference 同时复制到 Wiki 和 `docs/`。
