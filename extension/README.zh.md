# dsh 浏览器操作（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的**浏览器操作端**。由桌面端 DSH 驱动：模型直接读取并操作你已经打开的页面
——抓取内容、点击元素、填写表单、滚动、导航，全部在真实浏览器里执行，登录态、
Cookie 与会话都保留。

它同时**自带对话界面**：面板就是你输入提问、也是模型回复出现的地方。它是 Chrome 的
**侧边栏**（Firefox 的 sidebar），因此会常驻在页面旁边，而不是点走即关；看消息和发消息
不需要桌面窗口，桌面端只负责跑模型。

## 模型能做什么

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化 |
| 点击元素 | `browser_click` | 按清单编号点击链接/按钮/复选框等，兼容 React/Vue |
| 填写表单 | `browser_type` | 往输入框里输文本（`replace` 先清空）、选 `<select>` 的选项（按 value → 可见标签 → 1-based 序号）、用 `true`/`false` 勾选 checkbox/radio |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，或新开标签页并跟随 |
| 列出标签页 | `browser_list_tabs` | 返回可访问标签页的稳定 ID、标题、URL 与状态 |
| 跟随标签页 | `browser_follow_tab` | 把后续工具绑定到某个标签页，但不激活它 |
| 关闭标签页 | `browser_close_tab` | 关闭指定标签页 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 等页面稳定，或等某个选择器/文本出现（始终不出现则以 `timeout` 失败） |
| 启动浏览器 | `browser_launch` | 在**桌面端**执行：没有浏览器就没有可派发的扩展，所以这是唯一能把它拉起来并回报结果的工具 |
| 识别图片 | `browser_describe_image` | 只在"看图"打开时才应答；见仓库 README 的「看图」一节 |

以上是模型可见的 17 个工具；权威清单是 `packages/bridge/src/tools.ts` 里的
`BROWSER_TOOL_NAMES`。

页面始终以**结构化文本**呈现——带编号的交互元素清单，编号跨快照稳定。浏览器工具
不会截屏。

## 组成

```
浏览器侧边栏（输入框 + 时间线，同时也是连接界面）
        │  端口 "dsh-control"
        ▼
后台 Service Worker
        │  WebSocket  ws://127.0.0.1:<端口>/ext/bridge
        ▼
dsh 桥接插件（服务端，运行在 dsh 进程内）
        │  browser_* 工具调用与流式回复
        ▼
dsh 桌面窗口（模型在这里运行）
```

- **background**（`src/background/`）：持有桥接套接字（token 认证、自动探测、
  指数退避重连、保活），把工具调用**失败关闭式**地派发到一个由用户控制的标签页，
  并负责标签页亲和、审批协调、`session.*` 会话 RPC 和 `dsh-control` 端口协议。
- **内容脚本**（`src/content/`）：纯文本快照（正文抽取 + 编号交互清单 + 表单字段）、
  稳定元素编号（`data-dsh-el`）、增量变化、点击/输入/按键/滚动/导航，以及敏感字段掩码。
- **面板**（`control/`）：无依赖的原生 TS 侧边栏，显示对话、连接状态、受控标签页、
  审批卡片、**本轮任务表**、最近操作和安全设置。面板**有意不放**桥接地址与 token 输入框——受支持的那条路径上两者都由程序决定，给个空输入框只会让用户以为有什么要配。它在你浏览时常驻开着——旁边那个页面就是被操作的对象。
  - 任务表让多步请求始终可读：模型先写出它要执行的清单，之后带着勾选状态重新写出，面板把它显示在整轮之上，
    进行中的、已完成的、失败的各有标记。每条操作记录也以"这个工具实际做成了什么"结尾，因此已完成的步骤
    不会看起来和未开始的步骤一样。
- **协议**：线协议是工作区包 `@dsh-browser/protocol`（`packages/protocol/src/index.ts`
  及 `vision-contract.ts` 与 `plan.ts`），由打包器内联进两端，因此两半不可能漂移。

## 构建

在仓库根目录执行：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build            # Chrome/Edge -> dist/
pnpm --filter dsh-browser-extension run build:firefox    # Firefox     -> dist-firefox/
pnpm --filter dsh-browser-extension run build:store      # Chrome，不含 manifest `key` -> dist-store/
pnpm --filter dsh-browser-extension run build:store:firefox  # Firefox，不含 `key` -> dist-store-firefox/
pnpm --filter dsh-browser-extension run test
pnpm --filter dsh-browser-extension run typecheck
```

## 安装与使用

1. 按上面的命令构建，然后加载产物：
   - **Chrome/Edge**：`chrome://extensions` → 打开开发者模式 → 「加载已解压的扩展程序」
     → 选择 `extension/dist/`。
   - **Firefox**：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」
     → 选择 `extension/dist-firefox/manifest.json`。
2. 确认 dsh 已挂载桥接插件并正在运行，然后打开任意普通 `http://` 或 `https://` 页面，
   点击鲸鱼图标。
3. 面板会显示连接状态。Chrome / Edge 走回环连接，无需地址或 token——桥接会接受它，
   因为它来自**本扩展**（按扩展 id 识别）。Firefox 必须在面板里填入
   `~/.dsh/ext-bridge-token` 里的 token，因为 `moz-extension://` 的 UUID 不能证明
   扩展身份，桥接无法把它和别的连接区分开。
4. 在面板里和模型对话，让它读取或操作页面；第一次调用会绑定你正在看的标签页。

**桌面端 DSH 用户**：桌面应用可能随机分配本地 Web 端口。扩展会自动探测常见端口
（3080、3081、3090、14389、43189、19387）；如果不是其中之一，把
`bridgeUrl` 要写进扩展自己的存储里（面板没有这个输入框）：`chrome.storage.local.get('dshSettings').then(({ dshSettings }) => chrome.storage.local.set({ dshSettings: { ...dshSettings, bridgeUrl: 'http://127.0.0.1:<端口>' } }))`，然后重载扩展。在桌面设置里把端口固定为
`43189` 可以让自动探测继续有效。

安装或重载扩展之前就已经打开的页面，会在第一次操作时自动注入，无需手动刷新。
浏览器内部页面和受保护页面（`chrome://`、应用商店）只暴露标签页元数据和浏览器级
导航/后退/前进/刷新，DOM 无法读取或操作。

## 连接方式

- **加载即连接，而不是点击才连接。** 没有按钮要按：设置一读完，worker 就开始连接，
  每半分钟的 `alarms` 心跳同时保活套接字和 MV3 worker。**没有**开关能停掉它：安装即代表连接，面板里也不存在「自动连接」控件。它
  的关闭开关。
- **同一时间只允许一个浏览器。** 第二个打开的 profile 会收到让位指令（关闭码 4000），
  而不是互相抢占。
- **工具不请求就不读页面。** 快照和文本读取都包在带随机 nonce 的不可信内容边界里，
  并明确告诉模型：页面文字是不可信数据。

## 审批与安全

审批是强制执行边界，而面板并不是唯一的作答方式——面板关着时 worker 依然在跑：

- 默认 `auto` 模式允许模型直接读取受控标签页，不再额外弹窗；`ask` 恢复每次读取确认；
  `off` 完全阻断读取。
- 会改变状态的工具失败关闭，并显示确切来源与脱敏后的操作摘要。你可以拒绝、仅允许一次，
  或在本次桥接会话内信任某个 origin（面板会列出临时信任并可一键撤销）。
- 面板关闭时，审批会变成**系统通知**，并在工具栏图标上显示**红色角标数字**。
  点击任意一个都会打开面板并定位到该请求。你有两分钟时间决定。
- **允许模型完全控制浏览器**是一个显式开关，只有设置保存成功后才会生效；启用后
  页面读取、页面操作、标签页列出/跟随/关闭都不再请求确认。它是**持久化**设置而非
  单次连接有效：开启后一直有效，直到你手动关闭。无论是否启用，受保护页面的
  DOM 内容都无法访问。
- 用户手动切换标签页或窗口后怎么处理，由「跟随标签页」设置决定：默认**跟随**（工具改绑到你切过去的新页面），
  也可以选**每次询问**（暂停并问你留在原页面还是跟过去，「保持并以后不再询问」会记住选择）
  或**保持**（留在原页面）。受控标签页被关闭则失败关闭，直到你绑定当前页。
- 密码和信用卡字段始终显示为 `••••`，字段值永不离开页面。

## 权限

`storage`（设置、图片描述备忘，以及受控标签页的跨重启连续性）、`tabs` + `scripting`
（观察标签页变化，并只对明确受控的标签页注入/发消息，包括对安装前已打开页面的懒恢复）、
`sidePanel`（仅 Chrome——对话界面；Firefox 用 `sidebar_action` 代替）、
`webNavigation`（把消息绑定到该标签页的 frame 文档）、`alarms`（后台保活）、
`notifications`（面板关闭时接收审批通知），以及 `http/https`（普通页面注入内容脚本）。
**没有** `activeTab`：真正授予访问权的是宽泛的 host permission，而 `activeTab` 是上游
声明了却从未使用的。

扩展绝不改变用户正在看的标签页，也绝不静默跟随手动切换；后台操作只在你选择「留在原页面」
之后发生。

## 与上游版本的区别

相比上游 `dsh-browser` 扩展，本目录**删除**了 React 客户端栈（会话历史、图片附件、
模型选择、更新卡片、划选引用、`ask_user_question` 卡片、事件重放，以及整条网关 RPC
通道），并**替换**为一个无依赖的原生 TS 面板——它保留了对话输入框、时间线、桌面端会话
选择器与审批卡片。同时**新增**了加载即自动连接、待审批重放、角标计数和两分钟审批窗口。
桥接协议没有改动，dsh 侧的同一个插件可以同时服务两种构建。

## 已知限制

- 同一时间只允许一个扩展连接。
- 标签页亲和是连接级而非会话级：多个对话共享同一个受控标签页。
- 无法处理验证码和纯图片控件；工具结果会提示你手动完成这一步。
- 不做 token 自动轮换。
- 合成的 `browser_press` 事件不会触发浏览器原生默认行为，例如 Tab 焦点移动、方向键
  滚动或 Enter 激活。
- 不带条件的 `browser_wait` 只考虑页面加载加一个静默窗口；持续变化的 SPA 可能被判定为稳定。
  带 `selector` 或 `text` 条件时它改为轮询，默认 10 秒后以 `timeout` 失败（给了 `ms` 则按 `ms`）。
  轮询跑在内容脚本里，所以取消工具调用只能让调用方停止等待、不能中断轮询——这也是默认值取这么短的原因之一。
- `<canvas>` 永远不会作为图片被列出：它没有可取的地址，因此快照干脆不列它，而不是列成读不到。
