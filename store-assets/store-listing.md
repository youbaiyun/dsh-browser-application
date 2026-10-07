# Chrome Web Store listing

Copy-paste source for the store form. The store takes plain text, so the values  
below are written the way they should be pasted, not formatted for Markdown.

## Name (75 characters max)

```
dsh Browser Extension
```

Chinese listing (if submitted as a separate item, or as the primary locale):

```
dsh 浏览器扩展（全端）
```

The name is deliberately unlike upstream's `dsh Browser Control`. Two extensions  
sharing "dsh Browser …" leaves a user unable to tell which one they want, and the  
store rejects a name that duplicates an existing listing.

An English name is not a translation of the Chinese one. Each language states the  
same thing in its own words — a browser extension for the dsh desktop app — rather  
than one being transliterated from the other. `_locales/*/messages.json` holds each  
locale's own form, so the browser, the extensions page and the toolbar tooltip all  
agree.

## Short description (132 characters max)

```
Browser executor for the dsh desktop app: reads and operates your page, signed in, no screenshots. Image look-up: deepseek-flash.
```

Count: 129 characters. Asserted equal to `_locales/en` by `extension/tests/locales.spec.ts`.

## Detailed description

The store allows up to 16 000 characters here, so the order is: what this is,  
where the companion skill lives, then the short version of what it does. Someone  
who reads only the first three lines should still know whether they want it.

```
全端 DeepSeek Harness 浏览器插件

完整项目skill+插件（要有完整项目才能正常使用）地址如下：
https://github.com/youbaiyun/dsh-browser-crossplatform

——————————————————————————————

让桌面端的 DeepSeek Harness（dsh）操作你正在用的浏览器标签页——
就在你当前这个页面里，保留你的登录态，不另开浏览器，不截图。

· 读页面：把网页转成结构化文本 + 带编号的控件清单，模型按编号操作。不截图。
· 看图（可选，默认关）：读你指定的那张图。扩展带着你的登录态去取它，所以登录后
  才可见的图也能读；不截图，也不整页拍图。
· 操作页面：点击、输入、滚动、跳转、管理标签页，只作用于你选中的那个页面。
· 确认开关：「不再询问，直接操作」出厂即开，所以新装的扩展点击和输入不会逐次弹确认；关掉它，就会改为审批，且可按站点信任、或只放开这一次连接。
· 密码和卡号不出页面：快照里就替换掉了，传出去的文本里没有。
· 网页不能冒充你：你在侧边栏打的每句话带来源标记，网页里写的带不上。
· 对话就在侧边栏：你说、它答。多步任务会先列出任务表，做完一条勾掉一条，每次工具调用占一行——
  没有仪表盘，也没有进度条。
**适配范围**：Windows / macOS / Linux 上的 dsh 桌面端（Node ≥ 20）+ 桌面 Chrome / Chromium / Edge **116+** 或 Firefox **140+**；**手机与平板不支持**（没有侧边栏这种界面）。
· 只连本机：扩展只连 127.0.0.1 上的 dsh，没有遥测。唯一例外是看图——你开启它并问某张
  图时，扩展会带着你的登录态去取那张图**本身**，再把字节交给桌面端。看图默认关闭。

需要先装好桌面端 dsh，并让它在同一台机器上运行。没有 dsh 时，侧边栏会
显示未连接，不会做任何别的事。

浏览器引擎极少部分来自 Lum1104/dsh-browser（现更名为 omdsh-dev/dsh-browser，MIT 协议）；侧边栏与交互层是本
版本自己的实现。
```

English listing:

```
dsh Browser Extension — all-sides suppoThe all-platform DeepSeek Harness browser extension

The complete project — skill and extension both — lives here (the extension only works with the full project installed):
https://github.com/youbaiyun/dsh-browser-crossplatform

——————————————————————————————

Let the desktop DeepSeek Harness (dsh) drive the browser tab you are already using —
right here in the page in front of you, signed in as you, with no second browser and no screenshots.

· Read the page: turns a web page into structured text plus a numbered list of controls, and the model acts by number. No screenshots.
· Look at an image (optional, off by default): reads the one image you point it at. The extension fetches it with your session, so an image only visible after signing in works too; no screenshots, and no full-page capture.
· Operate the page: click, type, scroll, navigate and manage tabs, only ever on the page you selected.
· The confirmation switch: "Don't ask again, act directly" ships switched on, so a fresh install does not prompt for every click and keystroke. Turn it off and approvals come back, with per-site trust or a one-connection-only allowance.
· Passwords and card numbers never leave the page: they are replaced inside the snapshot, so they are not in the text that goes out.
· A web page cannot impersonate you: every line you type in the side panel carries a provenance marker; anything written by the page does not.
· The conversation is in the side panel: you say it, it answers. A multi-step task first lays out a task list, and each finished item is ticked off; every tool call takes one line —
  no dashboard and no progress bar.
**Supported on**: the dsh desktop app on Windows / macOS / Linux (Node ≥ 20) plus desktop Chrome / Chromium / Edge **116+** or Firefox **140+**; **phones and tablets are not supported** (there is no side panel to put it in).
· Talks to this machine only: the extension connects to dsh on 127.0.0.1 and nothing else, with no telemetry. The one exception is image look-up — when you switch it on and ask about an image, the extension fetches that image **itself** with your session and hands the bytes to the desktop app. Image look-up is off by default.

It needs the dsh desktop app installed and running on the same machine first. With no dsh
running, the side panel says it is not connected and does nothing else.

A very small part of the browser engine comes from Lum1104/dsh-browser (now renamed omdsh-dev/dsh-browser, MIT); the side panel and the interaction layer are this
version's own implementation.

uage

English (add Chinese (Simplified) as a second locale if submitting the `zh_CN`  
strings as a separate listing)

## Store icon (128×128)

`extension/assets/icons/icon128.png`

## Screenshots (1280×800 or 640×400, at least one)

Not yet produced. Needed before submission. Take them with the panel open at a  
realistic width:

1. A conversation in progress, with a tool line visible.
2. The settings sheet, showing the connection state.
3. An approval card, showing what is being asked and the allow/deny buttons — available after turning 「不再询问，直接操作」 off, since it ships on.

## Additional fields

**Homepage URL** — the repository URL.

**Support URL** — the repository's issues page.

**Privacy policy URL** — a public URL for `PRIVACY.md` in this repository.

**Single purpose description** (required):

```
Operate the browser tab the user selects, on behalf of the dsh desktop app
running on the same machine.
```

**Justification for each permission** — see `permission-and-data-disclosure.md`.
