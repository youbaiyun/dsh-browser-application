# Chrome Web Store listing

Copy-paste source for the store form. The store takes plain text, so the values
below are written the way they should be pasted, not formatted for Markdown.

## Name (75 characters max)

```
dsh Browser Hand & Eye
```

Chinese listing (if submitted as a separate item, or as the primary locale):

```
dsh 浏览器的手与眼（应用端）
```

The name is deliberately unlike upstream's `dsh Browser Control`. Two extensions
sharing "dsh Browser …" leaves a user unable to tell which one they want, and the
store rejects a name that duplicates an existing listing.

An English name is not a translation of the Chinese one. "Hand & Eye" is how the
same idea reads in English; "之手与眼" would not survive being transliterated.
`_locales/*/messages.json` holds each locale's own form, so the browser, the
extensions page and the toolbar tooltip all agree.

## Short description (132 characters max)

```
Connects the dsh desktop app to the browser tab you are already using: the model reads and operates it in text, never screenshots.
```

Count: 131 characters.

## Detailed description

The store allows up to 16 000 characters here, so the order is: what this is,
where the companion skill lives, then the short version of what it does. Someone
who reads only the first three lines should still know whether they want it.

```
应用端 DeepSeek Harness 浏览器插件

配套技能包（Skill）：
https://github.com/youbaiyun/dsh-browser-lite/tree/main/skills/dsh-browser-control

——————————————————————————————

让桌面端的 DeepSeek Harness（dsh）操作你正在用的浏览器标签页——
就在你当前这个页面里，保留你的登录态，不另开浏览器，不截图。

· 读页面：把网页转成结构化文本 + 带编号的控件清单，模型按编号操作。
  全程纯文本，不截图。
· 操作页面：点击、输入、滚动、跳转、管理标签页，只作用于你选中的那个页面。
· 先问你：点击和输入默认都要审批。可以按站点信任，也可以只放开当前连接。
· 密码和卡号不出页面：快照里就替换掉了，传出去的文本里没有。
· 网页不能冒充你：你在侧边栏打的每句话带来源标记，网页里写的带不上。
· 对话就在侧边栏：你说、它答，每次工具调用占一行。没有仪表盘和进度条。
· 只连本机：扩展只连 127.0.0.1 上的 dsh，不连任何服务器，没有遥测。

需要先装好桌面端 dsh，并让它在同一台机器上运行。没有 dsh 时，侧边栏会
显示未连接，不会做任何别的事。

浏览器引擎部分来自 Lum1104/dsh-browser（MIT 协议）；侧边栏与交互层是本
版本自己的实现。
```

English listing:

```
dsh Browser Hand & Eye — the browser side of the dsh desktop app

Companion skill:
https://github.com/youbaiyun/dsh-browser-lite/tree/main/skills/dsh-browser-control

——————————————————————————————

Lets the dsh desktop app work in the browser tab you already have open — in the
page itself, with your login intact. No separate browser. No screenshots.

• Reads the page as structured text with numbered controls, so the model acts on
  the page it was given instead of taking pictures of it.
• Clicks, types, scrolls, navigates and manages tabs, on the one page you choose.
• Asks first. Clicking and typing need approval by default; you can trust a site
  or open up the current connection.
• Passwords and card numbers never leave the page — replaced before anything is
  sent.
• A web page cannot impersonate you. What you type in the panel carries an origin
  marker that page text cannot.
• The conversation lives in the side panel: you type, it answers, each tool run
  takes one quiet line. No dashboards, no progress bars.
• Loopback only. The extension talks to dsh on 127.0.0.1 and nothing else — no
  server of its own, no telemetry.

Requires the dsh desktop app, running on the same machine. Without it the panel
says it is not connected and does nothing else.

The browser engine comes from Lum1104/dsh-browser (MIT); the side panel and the
interaction layer are this build's own.
```

## Category

Productivity

## Language

English (add Chinese (Simplified) as a second locale if submitting the `zh_CN`
strings as a separate listing)

## Store icon (128×128)

`extensions/dsh-browser/assets/icons/icon128.png`

## Screenshots (1280×800 or 640×400, at least one)

Not yet produced. Needed before submission. Take them with the panel open at a
realistic width:

1. A conversation in progress, with a tool line visible.
2. The settings sheet, showing the connection state.
3. An approval card, showing what is being asked and the allow/deny buttons.

## Additional fields

**Homepage URL** — the repository URL.

**Support URL** — the repository's issues page.

**Privacy policy URL** — a public URL for `PRIVACY.md` in this repository.

**Single purpose description** (required):

```
Operate the browser tab the user selects, on behalf of the dsh desktop app
running on the same machine.
```

**Justification for each permission** — see `permission-justification.md`.
