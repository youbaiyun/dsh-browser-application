# dsh 浏览器的手与眼（应用端）[![dshfind](https://dshfind.com/api/badge/youbaiyun/dsh-browser-lite?lang=zh)](https://dshfind.com/zh/plugins/youbaiyun/dsh-browser-lite?ref=badge)

[English](README.md) | **中文**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、操作控件、导航和管理标签页，同时保留登录态、会话和 Cookie。浏览器侧边栏就是对话界面：你在那里输入，回复在那里流式返回，每次工具调用只占一行。

> [!NOTE]
> **本项目是 [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) 的轻量化衍生版**，不是上游项目。浏览器引擎来自上游：文本快照流水线、编号寻址、全部工具实现、审批与信任模型、以及桥接层。不同之处在交互层——原本基于 React 的完整面板被替换为一个小的侧边栏控制条——外加若干新增能力，见下方「本版本改了什么」。**引擎问题请反馈给上游，面板问题请反馈到这里。**

`dsh` 是 DeepSeek AI 开源的、基于插件的 agent harness。本仓库把它所需的浏览器桥接插件与 Chrome/Firefox MV3 扩展放在同一个独立 pnpm workspace 里。

浏览器操作全程保持纯文本：页面被转成结构化文本 + 一份带编号的可交互元素清单，模型按编号寻址。**任何情况下都不截图。**

> [!IMPORTANT]
> **如果你要发布本项目的分叉**，推送前请把 `youbaiyun/dsh-browser-lite` 全部替换掉：本文件、`README.md` 里的安装命令、`README.zh.md` 顶部的徽章、`scripts/install.sh` 里的 `REPOSITORY`、以及 `scripts/install.ps1` 里的 `$Repository`，共 6 处。**不替换的话，一键安装会去下载上游、装上那个更大的版本**——和本项目的用意正好相反。另外请检查 `.github/FUNDING.yml`，它目前仍指向上游维护者的赞助账号。

> [!IMPORTANT]
> 本 workspace 锁定 dsh 0.2.0-rc.2，这是支持的最低运行时。更早的 DSH 版本不受支持。

## 本版本改了什么

以下每一项都是相对分叉点的实测结果，不是估算。

**替换：整个交互层**

| | 上游 | 本版本 |
|---|---|---|
| 面板 | React 应用，22 个文件，8520 行 | 原生 TypeScript，7 个文件，2827 行 |
| 面板测试 | 3088 行，19 个文件 | 2784 行，5 个文件 |
| 随之移除的功能 | 划选引用、提问卡片、更新卡片、界面缩放、图片消息 | — |

**新增：上游没有的能力**

- **面板来源标记。** 面板里输入的每句话都会带上一个固定前缀，模型据此区分「你的真实指令」和「网页里写的一句话」。该前缀只施加在唯一一条提交路径上，所以冒充是架构上的不可能，而不是靠模型自觉。
- **`openPagesForUser`，应用端开关。** 模型能否自行打开和导航页面，是桌面端的设置，通过握手下发给扩展。关闭后：提示词换成禁止版、`@open` 拒绝执行、自动弹出面板也一并停止。扩展不保留自己的副本——**策略缺失按「不允许」处理**，所以字段丢失不会变成一张没人给的通行证。
- **`@open`，确定性命令。** 在面板输入 `@open <网址>`，扩展直接打开、置前并接管该页面，**完全不经过模型**。「让我看着你打开」必须是保证，不能是一个模型可以拒绝的请求。
- **地址自愈。** 桌面端在启动时决定端口，重启后可能换端口。连续三次探测失败后，扩展会重新发现端口，而不是死拨一个旧地址。
- **顶替提示。** 当另一个浏览器抢走唯一的桥接连接位时，面板会说明情况并提供「取回连接」，而不是显示一条看不懂的通用错误。

**与上游逐字一致、完全未改的部分：** 快照流水线（`snapshot.ts`、`extract.ts`、`ids.ts`、`privacy.ts`）、全部工具实现、审批与信任模型、桥接服务端及其认证、标签页绑定逻辑，以及它们的测试。**78 个文件逐字节相同。**

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

浏览器操作仍采用纯文本设计：页面会转换为结构化文本和带编号的交互元素清单，模型通过编号定位元素。dsh 0.2.0 的多模态对话走独立通道——宿主声明图片能力时，侧栏可发送 PNG、JPEG、WebP 和 GIF；浏览器工具本身仍不会截取页面截图。

> [!IMPORTANT]
> 当前工作区固定使用 dsh 0.2.0-rc.2，也是最低支持版本；不再支持旧版 DSH。

## 快速安装

本项目不能只使用标准的 `dsh plugin` 命令安装。它同时包含 dsh bridge plugin 和浏览器扩展。一行安装器目前会安装 Chrome 构建。

macOS 与 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/youbaiyun/dsh-browser-lite/refs/heads/main/scripts/install.sh | bash
```

Windows（PowerShell）：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/youbaiyun/dsh-browser-lite/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器会构建并注册桥插件、构建扩展、把它复制到 `~/.dsh/browser-extension`、把该路径复制进剪贴板，然后打开 `chrome://extensions`。接下来有两件事脚本替你做不了：

1. **加载扩展** —— 打开右上角**开发者模式**，点**加载已解压的扩展程序**，粘贴那个路径（或选择 `%USERPROFILE%\.dsh\browser-extension`）。
2. **固定到导航栏** —— 新装的扩展**不会自动固定**，而且**没有任何扩展能自己固定**：Chrome 已经去掉了这个能力。点地址栏右边的**拼图图标**，再点 *dsh 浏览器的手与眼* 旁边的图钉。**漏掉这一步，是"以为装失败了"最常见的原因**——图标一直在，只是藏在菜单里。

**完整图文步骤、前置条件、脚本每一步做了什么、以及故障排查：[INSTALL.md](INSTALL.md)。** 里面详细写了固定这一步、Edge 冲突（同一时间只有一个浏览器能占用连接）、以及卸载方法。

如果 dsh 已经在运行，安装完成后请重启。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。本项目目前没有发布 npm 包，请使用上方安装器。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化 |
| 点击元素 | `browser_click` | 按编号点击链接/按钮/复选框等 |
| 填写表单 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，或新开标签页并跟随（`active:false` 时保持当前页在前台） |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL、窗口/顺序以及活动/受控状态 |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到 `browser_list_tabs` 返回的标签页，而不激活该标签页 |
| 关闭标签页 | `browser_close_tab` | 关闭 `browser_list_tabs` 返回的标签页 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |
| 发送图片 | `session.prompt` / `session.attachment` | 按宿主能力启用图片草稿、纯图片消息和持久历史预览 |
| 引用选中内容 | 侧栏输入框 | 在页面里划选的文字会出现在输入框，随下一条消息一起发送，并带上来源与不可信内容边界 |

## 组成

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
scripts/install.ps1
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **纯文本页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码，使模型无需截图也能操作页面；用户主动添加的对话图片走 dsh 独立的多模态消息通道。
- **用「指」代替「描述」**：直接划选你要问的那段文字，侧栏会把它引用下来，说「解释这个」不必再描述整页内容。只有侧栏打开时才会捕获，并且在你发送消息之前不会离开浏览器。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **受保护的桥连接**：远程连接使用认证握手，特权网关方法拒绝非回环调用方，扩展把工具绑定到一个由用户控制的标签页。

## 详细安装与使用

前置要求：Node.js `^22.19` 或 `>=24`、Corepack/pnpm，以及 Chrome 116+ 或 Firefox 140+。Windows 还需要系统自带的 Windows PowerShell 5.1，或 PowerShell 7+。

### 安装或更新

托管安装请运行：

```sh
curl -fsSL https://raw.githubusercontent.com/youbaiyun/dsh-browser-lite/refs/heads/main/scripts/install.sh | bash
```

Windows 请运行：

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/youbaiyun/dsh-browser-lite/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

安装器会下载 `main`、构建并注册桥插件、把 Chrome 扩展构建到 `~/.dsh/browser-extension`，然后打开 `chrome://extensions`。首次安装时，请把该目录作为已解压扩展加载；更新时点击**重新加载**。**然后记得固定到导航栏**——为什么这一步不能省，见 [INSTALL.md](INSTALL.md#④-把扩展固定到导航栏)。如果 dsh 已在运行，请重启。

`scripts/install.sh` 覆盖 macOS 与 Linux，`scripts/install.ps1` 覆盖 Windows；两者写入同一个托管工作区和同一份安装元数据。当系统提供剪贴板工具（`pbcopy`、`wl-copy`、`xclip`、`xsel` 或 PowerShell 的 `Set-Clipboard`）时，安装器会把扩展路径复制到剪贴板；无论是否复制成功都会打印该路径。若未检测到 Chrome/Chromium，安装器会打印对应的安装命令；设置 `DSH_INSTALL_BROWSER=1` 可让安装器尝试自动安装。

Windows 命令先下载 `install.ps1` 再执行，而不是管道给 `Invoke-Expression`：脚本是带 BOM 的 UTF-8，Windows PowerShell 依赖 BOM 才能正确显示中文，而 `Invoke-Expression` 无法处理开头的 BOM。本地 checkout 路径可以包含空格；安装器通过 profile 内的目录联接注册桥插件，因此包规格中不会出现 Windows 绝对路径。

如需从源码 checkout 安装当前分支：

```sh
git clone https://github.com/youbaiyun/dsh-browser-lite.git
cd dsh-browser
./scripts/install.sh
```

Windows 请在 checkout 中运行 `.\scripts\install.ps1`。拉取或切换版本后，请重新运行安装器并重新加载扩展。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 的 `moz-extension://` UUID 不能证明扩展身份，因此必须携带 `~/.dsh/ext-bridge-token` 中的 bearer token（dsh 启动日志会报告该文件路径）。扩展没有 token 输入框：在 Firefox 版上，从 `about:debugging#/runtime/this-firefox` 打开扩展的后台控制台，设置一次即可：

```js
chrome.storage.local.get('dshSettings').then(({ dshSettings }) =>
  chrome.storage.local.set({
    dshSettings: { ...dshSettings, token: '<~/.dsh/ext-bridge-token 的内容>' },
  }))
```

Chrome 在回环地址下不需要 token，因此这一步不适用。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。受支持的精确公开版本为：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Chrome 本机使用无需配置；Firefox 需要按上述方式设置本地桥 token。扩展**加载即自动连接**，点击 DeepSeek 鲸鱼图标可打开侧边栏查看状态。已有 HTTP(S) 标签页会在第一次操作时自动加载。在浏览器受保护页面和扩展商店中，模型可以读取标签页元数据，并通过浏览器级能力导航到 HTTP(S)、后退、前进和刷新，但不能读取或操作受保护页面的 DOM。

## 故障排查

**侧边栏一直显示「未连接」**

- 确认桌面端正在运行。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。如果返回的是网页而不是 JSON，说明当前运行的 dsh 早于桥接注册——重启 dsh。下次打开面板时扩展会自己把连接收回来。
- 扩展会自动探测 3080/3081/3090/14389/43189/19387 端口。若 dsh 运行在其它端口，或使用 `--host 0.0.0.0` 远程部署，请按上文方式在扩展的后台控制台里设置地址（Firefox 还需设置 token）——面板刻意没有这个输入框。
- 改动桥接代码或插件配置后，**必须重启桌面端**：插件只在启动时读取一次，禁用再启用不会重新读取。重新构建扩展后，需在 `chrome://extensions` 里重新加载。
- 仓库内的 `skills/dsh-browser-control/` 技能包覆盖了其余情况，包括如何从 `chrome.storage.local` 直接读取扩展的真实设置。

## 开发

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- 桥构建使用 Node.js `copyFileSync` 复制浏览器客户端，因此同一条包脚本不依赖 Unix `cp` 命令。
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

`check:runtime` 检查实际解析的 DSH 依赖和锁文件；`test:smoke` 使用临时 DSH home 启动真实 web 宿主，验证桥接和重启后的会话读取，无需模型密钥。CI 在干净安装后运行这些检查。

如果遇到 `cache.hydratePrepared is not a function`，更新仓库后重新运行 `pnpm install --frozen-lockfile` 和 `pnpm run build`，再重启 `pnpm start`。无需删除会话数据或清空全局缓存。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问；Firefox Origin 是每次安装生成的 UUID，必须携带 bearer token。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 单活动连接；浏览器页面管线为纯文本且不截图；用户主动添加的对话图片交给 dsh 持久附件服务，密码和卡号值永不回传。
- 助手开始工作时会绑定当时的活动标签页（提交提示时绑定；直接调用浏览器工具时则在首次调用绑定）。用户手动切页后，后续浏览器操作会暂停，侧栏会询问让助手继续原页面还是跟随新页面；选择原页面后允许在后台继续，但扩展绝不静默改绑或切换用户正在看的页面。受控标签页关闭后也会暂停，直到用户显式选择当前页。
- 只有在侧栏打开、且页面共享不是「关闭」时才会捕获划选内容，密码和卡号字段永不读取。内容在发送之前始终留在扩展内部；移除、页面跳转或标签页关闭都会丢弃它；发送时与页面快照一样包在不可信内容边界内，来源标题和 URL 同样由页面提供，因此也放在边界之内。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。可以只在当前侧栏会话中信任单个 origin（最后一个侧栏关闭或 Service Worker 重启即清空）；永久信任需在设置中显式管理。显式跨域 `browser_navigate` 和未知目标的历史跳转始终重新询问。
- **允许模型完全控制浏览器**是显式的全局选择，只有设置保存成功后才会生效。启用后，页面读取、页面操作和标签页列出/跟随/关闭都不会再请求确认。调用在收到时固定其访问模式，因此开启完全控制不会追溯提升已经开始的受限调用。关闭会立即生效：取消尚未下发操作的调用，等待已经下发到浏览器的操作完成，再保存限制设置。快速重新开启也会在旧权限撤销完成前保持受限，并发保存会按请求顺序落盘。无论是否启用，浏览器受保护页面的 DOM 内容都无法访问。
