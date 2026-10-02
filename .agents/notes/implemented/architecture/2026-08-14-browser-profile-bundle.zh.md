# Agent Note: 浏览器 profile bundle

Status: implemented

[English](2026-08-14-browser-profile-bundle.md) | 中文

## 问题

把桥接包装成普通 profile 依赖只能让 JavaScript 可解析，不能把它挂载到 `web` 组合。仓库曾用根目录 `--patch` 文件补足这一步，因此 `pnpm start` 可以加载桥接插件，标准的 `npx @deepseek-ai/dsh web` 命令却不能。两种启动器的行为并不一致，而且桥接插件的激活契约位于包外。

## 决策

桥接包把 `dsh.bundle.patch` 声明为 `./cordis.patch.yml`，导出该文件并将其纳入发布文件集合。安装器把链接形式的包添加到本机 `web` profile，让 Harness profile 管理器注册它的 patch 层。

`pnpm start` 运行 workspace 固定版本的 `dsh web`，`npx @deepseek-ai/dsh web` 则运行 npm 当前的公开版本。安装完成后，两种命令都会解析同一个本机 profile bundle，无需仓库相对路径形式的 `--patch` 参数。

桥接包通过 workspace 脚本路径调用 `tsdown`。运行时配置、构建工具与插件代码全部位于本仓库或其声明的包依赖图中；任何命令都不会从父 checkout 或父目录的 `node_modules` 解析依赖。

安装器在进入同一条构建和注册路径之前支持两种源码模式。脚本位于完整 checkout 中时，直接使用该 checkout，绝不下载或覆盖源码文件。脚本在没有 workspace 的情况下通过流式方式运行时，会把 `main` 分支压缩包下载到安装器持有的 `~/.dsh/dsh-browser` 目录，验证 workspace 结构，再重新执行已安装的脚本副本。标记文件用于区分托管目录和用户内容；非空目录如果没有该标记，远程安装会拒绝覆盖。

托管 workspace 必须保留，因为 `web` profile 会通过本机路径链接桥接包。再次运行远程命令会刷新该 workspace，同时保留 pnpm 的 `node_modules`；再次运行 clone 中的安装器仍会使用它当前所在的分支。

安装器会在原地更新稳定的已解压扩展目录，并区分首次安装与重新加载。扩展把原先的本机默认地址视为自动探测，在每次创建本机 WebSocket 前先探测桥接服务，并在打开侧边栏或保活闹钟触发时重试探测。这样可以避免 dsh 尚未运行时反复记录拒绝连接错误，并在服务可用后建立连接。

## 替代方案

**保留根叠加配置并为 npx 记录额外参数。**这样会继续维护两条激活路径，也无法让标准 npm 命令按照 Harness 的文档直接工作。

**在根目录与包内各复制一份 patch。**重复配置可能产生漂移或把插件挂载两次。profile 层只由该包统一持有。

**要求所有用户 clone 仓库。**需要修改源码或选择分支时，clone 很有用；普通安装不需要 Git 和 checkout 管理。托管压缩包保留了 profile 链接所需的本机包路径，同时无需用户处理这套流程。

## 验证

使用干净 lockfile 安装检查公开发布版的依赖图；通过包组装确认包含 `cordis.patch.yml`。隔离 home 的 shell 冒烟测试覆盖 workspace 检测和流式自举，包括托管更新及拒绝覆盖未标记路径。在隔离的 home 中执行启动冒烟测试：把 bundle 添加到全新的 `web` profile，分别启动 `pnpm start` 与 `npx @deepseek-ai/dsh web`，并要求 `/ext/bridge-config` 成功响应。扩展测试要求本机可用性探测成功后才创建 WebSocket。

## 后果

每个需要浏览器操作能力的 dsh home 都必须先运行一次安装器。托管安装以安装器持有且用户不应作为工作副本修改的源码目录，换取无需 Git 的安装体验；开发者仍保留普通 clone 语义。未指定版本的远程命令会跟随仓库当前的 `main`，未指定版本的 npx 命令会跟随 npm 当前 dist-tag，因此发布变化后仍需验证兼容性；对于每个选定的源码版本，workspace lockfile 继续提供可复现的依赖路径。
