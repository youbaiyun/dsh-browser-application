# Chrome Web Store submission — the form, field by field

One page to fill the dashboard from. Every value below is copy-paste ready, and
where a field has a limit the count is given.

Sources this was compiled from: `store-listing.md` (the copy),
`permission-justification.md` (the permission answers), `PUBLISHING.md` (the
process). If a value here disagrees with those, they win and this file is stale.

## Before you start

| Thing | Where it is | Note |
|---|---|---|
| The archive to upload | `D:\DSH-demo\01-browser-extension\C-upload-to-chrome-store-0.3.1.zip` | **235.7 KB.** If you see 83 KB, that is the pre-fix archive whose entry names used `\` and it will be rejected |
| Store icon 128×128 | the same folder → `A-load-unpacked-extension-use-this/assets/icons/icon128.png` | |
| Screenshots | `D:\DSH-demo\03-store-listing\screenshots\` | 1280×800, 1–5 of them |
| Privacy policy URL | `https://gist.github.com/youbaiyun/92cd701036f39f168548f12c5ed171f6` | verified reachable without login |
| Homepage URL | `https://github.com/youbaiyun/dsh-browser-application` | |
| Support URL | `https://github.com/youbaiyun/dsh-browser-application/issues` | |

---

## 1. Store listing

### Name (75 characters max)

```
dsh 浏览器扩展（应用端）
```

The dashboard is in Chinese, so submit the Chinese name as the primary locale.
English (`dsh Browser Extension`) belongs in the English listing if you add one.

### Short description (132 characters max)

```
Connects the dsh desktop app to the browser tab you are already using: the model reads and operates it in text, never screenshots.
```

That is 131 characters — one to spare. The Chinese equivalent, if you switch the
listing language:

```
把桌面端的 dsh 接到你正在用的浏览器标签页上：模型以文本方式读取并操作页面，全程不截图。
```

### Detailed description

Use the Chinese block from `store-listing.md`, which begins
`应用端 DeepSeek Harness 浏览器插件` and ends with the upstream credit line. It is
written so that the first three lines alone tell someone whether they want it.

**One thing in it must stay**: the line saying the desktop app is required. Without
it, people install the extension, find it says 未连接, and leave a one-star review.

### Category

```
Productivity
```

### Language

```
Chinese (Simplified)
```

Add English as a second locale only if you also write an English listing; a
half-translated listing reads as neglected.

---

## 2. Graphic assets

| Field | Value |
|---|---|
| Store icon | `icon128.png` from the archive folder above |
| Screenshots | 1–5 at 1280×800. The first one is what the listing shows by default |
| Small promo tile (440×280) | optional; skip unless you want the extra placement |

Suggested screenshot order, and what each has to show:

1. **A conversation with a tool line** — the page on the left, the panel on the
   right, a question, an answer, one tool call. This is the one that says what the
   extension is.
2. **An approval card** — the ask, the target element, and the allow/deny buttons.
   Evidence that it does not act on its own.
3. **The settings sheet** — evidence that the user keeps control.
4. **`@open` having opened a page** — the clearest single feature.
5. **A snapshot** — numbered controls, to show how a page is read without
   screenshots.

---

## 3. Privacy

### Privacy policy URL

```
https://gist.github.com/youbaiyun/92cd701036f39f168548f12c5ed171f6
```

### Single purpose description (required)

```
Operate the browser tab the user selects, on behalf of the dsh desktop app running on the same machine.
```

### Justification for each permission

Copy each paragraph from `permission-justification.md` into the matching field.
The dashboard asks once per permission:

| Permission | The argument to give |
|---|---|
| `sidePanel` | the conversation interface *is* the panel; there is no popup and no separate tab |
| `storage` | remembers the bridge address and token plus the user's preferences; nothing else |
| `tabs` | lists open tabs so the user can choose one, keeps tools bound to it, opens a tab on request |
| `scripting` | injects the page reader and the action executor into the selected tab |
| `webNavigation` | detects a finished navigation so the next read sees the settled page |
| `alarms` | keeps the loopback connection alive across MV3 worker suspension |
| `notifications` | raises an approval when no panel is open, so a pending decision is not lost |

**Do not mention `activeTab`.** It was removed from the manifest in this release;
explaining a permission you do not request invites a question you cannot answer.

### Host permission (`http://*/*`, `https://*/*`)

This is the field most likely to draw a human reviewer, so give the argument in
full rather than a summary:

> The extension operates the page the user is looking at, and that page is not
> known when the manifest is written — the user may be on any site. No narrower
> pattern would work: a fixed domain list would break the feature everywhere else.
>
> What limits it: the content script only reads and acts on the tab the user
> explicitly selects; reading and acting are separate, approval-gated operations
> by default; passwords and payment-card values are replaced in place and never
> leave the page; page text is labelled as untrusted input so a page cannot issue
> instructions that look like the user's.

### Data usage disclosure

Tick **only** website content:

- Personally identifiable information — **not collected**
- Authentication information — **not collected** (the bridge token is generated by
  the desktop app and stored locally by the browser)
- Web history — **not collected**
- Website content — **read**, at the user's direction, and sent to the model the
  user configured. This is the extension's function
- User activity — **not collected**
- Location — **not collected**

Then certify all three required statements: the data is not sold, not used for
purposes unrelated to the single purpose, and not used to determine
creditworthiness or for lending.

---

## 4. Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All |
| Pricing | Free |

---

## 5. Submit

`Submit for review`. Then:

- A review takes days to weeks. The broad host permission is the usual reason for
  the longer end, which is why the justification above is written to answer that
  concern specifically — give it verbatim rather than paraphrasing.
- **The version number must be higher than the last submitted one, and a rejection
  still consumes it.** Before a resubmission, raise the version in
  `extensions/dsh-browser/manifest.json` and `manifest.firefox.json` together — a
  test asserts they agree — and rebuild.
- The published version is `0.3.1`. The next submission would be `0.3.2`.
